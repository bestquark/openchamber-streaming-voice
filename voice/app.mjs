import { SpeechChunks, TurnDetector, pcmBase64 } from './core.mjs';
import { createSpeechDetector, loadSpeechDetector } from './speech-detector.mjs';

const $ = id => document.getElementById(id);
const locationParams = new URL(location.href).searchParams;
const embedded = locationParams.get('embed') === '1' && window.parent !== window;
if (embedded) document.body.classList.add('embedded');
function applyTheme(theme) { if (embedded) document.body.dataset.theme = theme === 'light' ? 'light' : 'dark'; }
applyTheme(locationParams.get('theme'));
const client = window.OPENCHAMBER_VOICE_CLIENT;
const machines = ['local'];
const machine = 'local';
const base = '/machines/' + machine + '/api';
let directory = locationParams.get('directory') || client.directory;
if (!directory.startsWith('/') || directory.length > 2000 || directory.includes('\0')) throw new Error('Choose an absolute project folder.');
const requestedSession = locationParams.get('session');
if (requestedSession) {
  if (!/^ses[a-zA-Z0-9_-]+$/.test(requestedSession)) throw new Error('Invalid workspace session.');
  const response = await fetch(base + '/session/' + requestedSession);
  if (!response.ok) { $('error').hidden = false; $('error').textContent = 'This session is unavailable on the selected computer. Open its workspace and try again.'; throw new Error('Session unavailable'); }
  const existing = await response.json(); directory = existing.directory;
}
const query = '?directory=' + encodeURIComponent(directory);
const sessionKey = 'openchamber.voice.session:' + machine + ':' + directory;
const languageKey = 'openchamber.voice.language:' + machine + ':' + directory;
if (requestedSession) sessionStorage.setItem(sessionKey, requestedSession);
$('machine').value = machine; $('directory').value = directory;
$('context-label').textContent = machine + ' · ' + directory;
$('brand').href = '/?machine=' + machine;
// A navigation failure must not silently become a clock/DNS change.
// These session-only checks leave ordinary OpenCode workspaces unchanged.
const permissions = ['*sntp *', '*networksetup *', '*scutil --set *', '*systemsetup *'].map(pattern => ({ permission: 'bash', pattern, action: 'ask' }));
const system = client.system;
let session, events, socket, ctx, media, speechDetector;
let live = false, muted = false, busy = false, ending = false, speechReady = false;
let currentDictation = null, epoch = 0, speechQueue = [], pumping = false, scheduledUntil = 0;
let audioSources = new Set(), speechAbort = new AbortController(), preRoll = [], frameRate = 16000;
let messages = new Map(), parts = new Map(), activeParts = new Set(), ignoredMessages = new Set();
let vad = new TurnDetector(), requestInFlight = false, turnStart = 0, firstAudio = false, pendingQuestion;
let sessionSetup = null;
let ownsTurn = false, frameWatchdog, lastFrame = 0, callGeneration = 0;
let replyLanguage = sessionStorage.getItem(languageKey) || '';

async function languageForTurn(text) {
  if (!client.languageDetection) return {language: '', name: 'the dominant language of the complete user utterance'};
  const response = await fetch('/voice/language', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, previous: replyLanguage }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Could not choose the reply language. Please try again.');
  const language = await response.json();
  replyLanguage = language.language; sessionStorage.setItem(languageKey, replyLanguage);
  return language;
}

function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function status(text) { $('status').textContent = text; $('dot').classList.toggle('live', live && !muted); }
function updateStatus() {
  $('interrupt').hidden = !(live || busy || audioSources.size || speechQueue.length || pumping);
  if (currentDictation) return status(currentDictation.finishing ? 'Transcribing…' : 'Listening…');
  if (audioSources.size || speechQueue.length || pumping) return status('Speaking · you can interrupt');
  if (busy) return status('Thinking…');
  status(live ? (muted ? 'Microphone muted' : 'Listening · speak whenever you’re ready') : 'Ready · local speech');
}
async function api(path, body, method) {
  const response = await fetch(base + path + query, { method: method || (body === undefined ? 'GET' : 'POST'),
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  if (response.redirected && new URL(response.url).pathname === '/login') { location.assign('/login?next=%2Fvoice'); throw new Error('Sign in to continue.'); }
  if (!response.ok) throw new Error(`Workspace request failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}
async function audioContext() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}
function renderMessage(id, role, text) {
  let item = messages.get(id);
  if (!item) {
    const node = document.createElement('article'); node.className = 'message ' + role;
    const label = document.createElement('span'); label.className = 'label'; label.textContent = role === 'user' ? 'You' : 'Assistant';
    const content = document.createElement('span'); node.append(label, content); $('messages').append(node);
    item = { role, node, content }; messages.set(id, item); $('intro').hidden = true;
  }
  item.content.textContent = text;
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 300) item.node.scrollIntoView({ block: 'nearest' });
}
function showTool(part) {
  const id = 'tool-' + part.id; let node = document.getElementById(id);
  if (!node) { node = document.createElement('div'); node.id = id; node.className = 'tool'; $('messages').append(node); }
  node.textContent = `${part.tool} · ${part.state?.status || 'running'}`;
  if (part.state?.status === 'running') status('Working · ' + part.tool);
}
function stopAudio() {
  epoch++; speechAbort.abort(); speechAbort = new AbortController(); speechQueue = [];
  for (const source of audioSources) { source.onended = null; try { source.stop(); } catch {} }
  audioSources.clear(); scheduledUntil = 0;
}
async function interrupt() {
  stopAudio();
  for (const id of activeParts) { const p = parts.get(id); if (p) ignoredMessages.add(p.messageID); }
  activeParts.clear();
  if (busy && session) { busy = false; await api(`/session/${session.id}/abort`, {}).catch(e => error(e.message)); }
  updateStatus();
}
function enqueue(text, languageSample = text, language = replyLanguage) {
  if (!$('read').checked || ending || (embedded && !live) || !text.trim()) return;
  speechQueue.push({ text, languageSample, language, epoch }); void pumpSpeech();
}
async function pumpSpeech() {
  if (pumping) return;
  pumping = true;
  try {
    while (speechQueue.length) {
      if (ctx && scheduledUntil - ctx.currentTime > 9) { await new Promise(r => setTimeout(r, 100)); continue; }
      const next = speechQueue.shift();
      if (next.epoch !== epoch) continue;
      const signal = speechAbort.signal;
      const response = await fetch('/voice/speech', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: next.text, speed: 1.04, language: next.language, languageSample: next.languageSample.slice(0, 4000) }) });
      if (!response.ok) throw new Error(`Speech synthesis unavailable (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (next.epoch !== epoch) continue;
      const context = await audioContext(); const buffer = await context.decodeAudioData(bytes);
      if (next.epoch !== epoch) continue;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      const when = Math.max(context.currentTime + 0.025, scheduledUntil);
      source.start(when); scheduledUntil = when + buffer.duration; audioSources.add(source);
      source.onended = () => { audioSources.delete(source); updateStatus(); };
      if (!firstAudio && turnStart) { firstAudio = true; $('timing').textContent = `${((performance.now() - turnStart) / 1000).toFixed(1)}s to voice`; }
      updateStatus();
    }
  } catch (e) {
    if (e.name !== 'AbortError') { speechQueue = []; error(e.message + ' You can still read the reply.'); }
  } finally { pumping = false; updateStatus(); if (speechQueue.length) void pumpSpeech(); }
}
function applyText(part, final = false, historical = false) {
  const item = messages.get(part.messageID);
  if (!item || item.role !== 'assistant' || ignoredMessages.has(part.messageID)) return;
  const p = parts.get(part.id) || { id: part.id, text: '', fed: 0, chunks: new SpeechChunks() };
  p.messageID = part.messageID; p.type = part.type; p.text = part.text ?? p.text; parts.set(part.id, p);
  const full = [...parts.values()].filter(x => x.messageID === part.messageID && x.type === 'text').map(x => x.text).join('\n');
  renderMessage(part.messageID, 'assistant', full);
  if (!historical && !ending && (!embedded || live)) {
    if (!p.text.startsWith(p.previous || '')) { p.fed = p.text.length; p.chunks = new SpeechChunks(); }
    for (const chunk of p.chunks.push(p.text.slice(p.fed), final)) enqueue(chunk, p.text);
    p.fed = p.text.length; p.previous = p.text; activeParts.add(part.id);
  }
}
function showRequest(type, data) {
  if (document.getElementById(data.id)) return;
  const box = document.createElement('div'); box.id = data.id; box.className = 'request';
  const title = document.createElement('p'); box.append(title); $('requests').append(box);
  if (type === 'permission.asked') {
    title.textContent = `Permission needed: ${data.permission}\n${(data.patterns || []).join('\n')}`;
    for (const [label, reply] of [['Allow once', 'once'], ['Deny', 'reject']]) {
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = async () => { try { await api(`/permission/${data.id}/reply`, { reply }); box.remove(); } catch (e) { error(e.message); } }; box.append(button);
    }
    enqueue('I need your permission. Please check the request on screen.');
  } else {
    pendingQuestion = { id: data.id, data, box };
    title.textContent = data.questions.map(q => q.question).join('\n'); enqueue(title.textContent);
    const inputs = data.questions.map(q => { const input = document.createElement('input'); input.placeholder = q.options?.map(o => o.label).join(' / ') || 'Your answer'; input.setAttribute('aria-label', q.question); box.append(input); return input; });
    const button = document.createElement('button'); button.textContent = 'Answer';
    button.onclick = async () => { try { await api(`/question/${data.id}/reply`, { answers: inputs.map(i => [i.value]) }); pendingQuestion = null; box.remove(); } catch(e) { error(e.message); } }; box.append(button);
  }
  status('Waiting for your answer');
}
function handleEvent(event) {
  const p = event.properties || {};
  if ((p.sessionID || p.info?.sessionID || p.part?.sessionID) !== session?.id) return;
  if (event.type === 'message.updated') {
    const info = p.info;
    if (!messages.has(info.id)) renderMessage(info.id, info.role, '');
    if (info.error && info.error.name !== 'MessageAbortedError') error(info.error.data?.message || info.error.name);
    if (info.time?.completed) for (const part of parts.values()) if (part.messageID === info.id && part.type === 'text') applyText(part, true);
  } else if (event.type === 'message.part.updated') {
    const part = p.part;
    if (part.type === 'tool') showTool(part);
    if (part.type === 'text') {
      if (messages.get(part.messageID)?.role === 'user') renderMessage(part.messageID, 'user', part.text);
      else applyText(part, !!part.time?.end);
    }
  } else if (event.type === 'message.part.delta' && p.field === 'text') {
    const part = parts.get(p.partID);
    if (part?.type === 'text') applyText({ ...part, text: part.text + p.delta });
  } else if (event.type === 'session.status') {
    busy = p.status.type !== 'idle';
    if (!busy) { for (const id of activeParts) { const part = parts.get(id); if (part) applyText(part, true); } activeParts.clear(); ownsTurn = false; }
    updateStatus();
  } else if (event.type === 'session.error') { error(p.error?.data?.message || 'The model request failed.'); busy = false; updateStatus(); }
  else if (event.type === 'permission.asked' || event.type === 'question.asked') showRequest(event.type, p);
  else if (event.type === 'permission.replied' || event.type === 'question.replied' || event.type === 'question.rejected') document.getElementById(p.requestID)?.remove();
}
async function ensureSession(force = false) {
  if (sessionSetup) return sessionSetup;
  sessionSetup = prepareSession(force);
  try { return await sessionSetup; } finally { sessionSetup = null; }
}
async function prepareSession(force = false) {
  if (session && !force && events?.readyState === EventSource.OPEN) return;
  const saved = force ? null : sessionStorage.getItem(sessionKey);
  if (saved && /^ses[a-zA-Z0-9_-]+$/.test(saved)) { try { session = await api('/session/' + saved); } catch {} }
  if (!session || force) session = await api('/session', { title: 'Voice · ' + new Date().toLocaleString(), permission: permissions });
  sessionStorage.setItem(sessionKey, session.id);
  $('workspace').href = '/?machine=' + machine + '&session=' + encodeURIComponent(session.id);
  events?.close();
  events = new EventSource(base + '/event' + query);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Workspace event stream timed out.')), 15000);
    events.onopen = () => { clearTimeout(timer); resolve(); };
    events.onerror = () => { clearTimeout(timer); reject(new Error('Workspace connection lost. Reconnect to continue.')); };
  });
  events.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error('Voice event:', err.message); } };
  events.onerror = () => { error('Workspace connection lost; reconnecting.'); if (ownsTurn) void interrupt(); else stopAudio(); };
  if (saved && !force) {
    const history = await api(`/session/${session.id}/message`);
    for (const m of history) {
      renderMessage(m.info.id, m.info.role, m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'));
      for (const p of m.parts) if (p.type === 'text' && m.info.role === 'assistant') { parts.set(p.id, { ...p, fed: p.text.length, previous: p.text, chunks: new SpeechChunks() }); }
    }
  }
}
async function sendText(text, fromSpeech = false) {
  text = text.trim(); if (!text || requestInFlight) return;
  if (fromSpeech && /^(um|uh|erm|hmm|eh|mmm)[.,…\s]*$/i.test(text)) { updateStatus(); return; }
  requestInFlight = true; error(''); ending = false;
  try {
    await audioContext();
    if (pendingQuestion) stopAudio();
    else if ($('requests').children.length) { stopAudio(); throw new Error('Please allow or deny the pending request on screen first.'); }
    else if (busy || audioSources.size || pumping) await interrupt();
    if (!fromSpeech) { turnStart = performance.now(); firstAudio = false; }
    await ensureSession();
    if (pendingQuestion && pendingQuestion.data.questions.length === 1) {
      await api(`/question/${pendingQuestion.id}/reply`, { answers: [[text]] }); pendingQuestion.box.remove(); pendingQuestion = null;
    } else {
      const language = await languageForTurn(text);
      busy = true; activeParts.clear(); $('timing').textContent = ''; updateStatus();
      const turnSystem = system + `\nThe interface speaks your text as it streams. Do not call VoiceMode, converse, or other speech tools; write the answer as ordinary text. For this turn, reply in ${language.name}. This is the dominant language of the complete utterance, or an explicit language request. A borrowed word, product name, quote, or tool output in another language must not switch your response language. Keep the same language throughout your answer unless the user explicitly requests a translation or multiple languages.`;
      ownsTurn = true;
      await api(`/session/${session.id}/prompt_async`, { agent: 'build', system: turnSystem, parts: [{ type: 'text', text }] });
    }
  } catch(e) { busy = false; error(e.message); updateStatus(); }
  finally { requestInFlight = false; }
}
function sendPcm(pcm) {
  const d = currentDictation; if (!d || d.finishing) return;
  if (!d.ready) { d.buffer.push(pcm); return; }
  socket.send(JSON.stringify({ type: 'chunk', dictationId: d.id, seq: d.seq++, audio: pcmBase64(pcm) }));
}
function finishDictation() {
  const d = currentDictation; if (!d || d.finishing) return;
  d.finishing = true; turnStart = performance.now(); firstAudio = false;
  const finish = () => socket.send(JSON.stringify({ type: 'finish', dictationId: d.id, finalSeq: d.seq - 1 }));
  if (d.ready) finish(); else d.onReady = finish;
  d.timer = setTimeout(() => { if (currentDictation === d) { socket.send(JSON.stringify({ type: 'cancel', dictationId: d.id })); currentDictation = null; error('Transcription timed out. Please try again.'); updateStatus(); } }, 35000);
  updateStatus();
}
async function connectDictation() {
  if (socket?.readyState === 1) return;
  // Recognition is a shared service; tools and sessions use the selected host.
  socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/machines/local/api/dictation/ws');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Speech connection timed out.')), 12000);
    socket.onmessage = event => { const msg = JSON.parse(event.data); if (msg.type === 'ready') { clearTimeout(timer); resolve(); } };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Cannot connect to local recognition.')); };
  });
  socket.onmessage = event => {
    const msg = JSON.parse(event.data); const d = currentDictation;
    if (!d || msg.dictationId !== d.id) return;
    if (msg.type === 'ack' && !d.ready) {
      d.ready = true;
      for (const pcm of d.buffer) socket.send(JSON.stringify({ type: 'chunk', dictationId: d.id, seq: d.seq++, audio: pcmBase64(pcm) }));
      d.buffer = []; d.onReady?.();
    } else if (msg.type === 'final') {
      clearTimeout(d.timer); currentDictation = null; vad.reset(); preRoll = [];
      if (live && msg.text?.trim()) void sendText(msg.text, true); else updateStatus();
    } else if (msg.type === 'error') {
      clearTimeout(d.timer); currentDictation = null; vad.reset(); error(msg.error || 'Speech recognition failed.'); updateStatus();
    }
  };
  socket.onclose = () => { if (live) { error('Speech connection closed. Start the conversation again.'); void stopCall(); } };
}
function audioFrame(float, speechProbability) {
  lastFrame = performance.now();
  if (!live || muted) return;
  const pcm = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, float[i])) * 32767);
  const speaking = audioSources.size > 0 || pumping || speechQueue.length > 0;
  const ms = float.length / frameRate * 1000;
  preRoll.push(pcm); while (preRoll.reduce((n, p) => n + p.length, 0) > frameRate * 0.8) preRoll.shift();
  const event = vad.step(speechProbability, ms, speaking, !currentDictation?.finishing && (!speaking || $('barge').checked));
  if (event === 'start') {
    if ($('requests').children.length) stopAudio(); else void interrupt();
    const id = crypto.randomUUID(); currentDictation = { id, seq: 0, ready: false, buffer: [...preRoll], finishing: false };
    socket.send(JSON.stringify({ type: 'start', dictationId: id, format: `audio/pcm;rate=${frameRate};bits=16`, options: { provider: 'openai-compatible', openaiCompatible: { baseUrl: client.asrBase, model: client.asrModel, apiKey: 'local-speech' } } }));
    status('Listening…');
  } else if (currentDictation && !currentDictation.finishing) sendPcm(pcm);
  if (event === 'finish') finishDictation();
}
async function startCall() {
  const attempt = ++callGeneration;
  const cancelled = () => attempt !== callGeneration;
  error(''); $('start').disabled = true; ending = false;
  try {
    await audioContext();
    if (cancelled()) return;
    status('Preparing microphone…');
    await loadSpeechDetector();
    if (cancelled()) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 }, video: false });
    if (cancelled()) { stream.getTracks().forEach(t => t.stop()); return; }
    media = stream;
    await Promise.all([ensureSession(), connectDictation()]);
    if (cancelled()) { socket?.close(); return; }
    const detector = await createSpeechDetector(media, ctx, audioFrame);
    if (cancelled()) { await detector.destroy().catch(() => {}); return; }
    speechDetector = detector; frameRate = 16000;
    await speechDetector.start();
    if (cancelled()) { await detector.destroy().catch(() => {}); return; }
    live = true; muted = false; vad.reset(); preRoll = [];
    lastFrame = performance.now();
    frameWatchdog = setInterval(() => {
      if (live && !document.hidden && ctx?.state === 'running' && performance.now() - lastFrame > 5000) {
        void stopCall().then(() => error('Microphone processing stopped. Start the conversation again.'));
      }
    }, 2000);
    $('start').textContent = 'End conversation'; $('interrupt').hidden = false; $('mute').hidden = false; updateStatus();
  } catch(e) { if (!cancelled()) { await stopCall(); error(e.name === 'NotAllowedError' ? 'Allow microphone access for this site, then start again.' : e.message); } }
  finally { $('start').disabled = false; }
}
async function stopCall() {
  ++callGeneration;
  live = false; ending = true;
  clearInterval(frameWatchdog);
  media?.getTracks().forEach(t => t.stop()); media = null;
  if (speechDetector) await speechDetector.destroy().catch(() => {}); speechDetector = null;
  if (currentDictation) { clearTimeout(currentDictation.timer); if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', dictationId: currentDictation.id })); }
  currentDictation = null; socket?.close(); socket = null; vad.reset(); preRoll = [];
  if (ownsTurn) await interrupt(); else stopAudio();
  ownsTurn = false; $('start').textContent = 'Start conversation'; $('mute').hidden = true; $('interrupt').hidden = true; $('mute').textContent = 'Mute microphone'; updateStatus();
}
$('start').onclick = () => live ? stopCall() : startCall();
$('interrupt').onclick = () => interrupt();
$('mute').onclick = () => { muted = !muted; media?.getAudioTracks().forEach(t => { t.enabled = !muted; }); if (muted && currentDictation && !currentDictation.finishing) finishDictation(); vad.reset(); preRoll = []; $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; updateStatus(); };
$('read').onchange = () => { if (!$('read').checked) stopAudio(); updateStatus(); };
$('text-form').onsubmit = e => { e.preventDefault(); const text = $('text').value; $('text').value = ''; void sendText(text); };
$('new').onclick = async () => { try { await stopCall(); session = null; sessionStorage.removeItem(sessionKey); sessionStorage.removeItem(languageKey); replyLanguage = ''; messages.clear(); parts.clear(); ignoredMessages.clear(); activeParts.clear(); $('timing').textContent = ''; turnStart = 0; firstAudio = false; pendingQuestion = null; $('messages').replaceChildren(); $('requests').replaceChildren(); $('intro').hidden = false; await ensureSession(true); const u = new URL(location.href); u.searchParams.delete('session'); history.replaceState(null, '', u); } catch(e) { error(e.message); } };
$('context-form').onsubmit = async e => { e.preventDefault(); const nextDirectory = $('directory').value.trim(); if (!nextDirectory.startsWith('/') || nextDirectory.includes('\0')) return error('Enter the full path to a folder on the selected computer.'); await stopCall(); location.assign('/voice?' + new URLSearchParams({ machine: $('machine').value, directory: nextDirectory })); };
$('preview').onclick = async () => { ending = false; await interrupt(); await audioContext(); const samples = { es: 'Hola. Estoy lista. ¿En qué te gustaría trabajar?', fr: 'Bonjour. Je suis prête. Sur quoi veux-tu travailler ?', zh: '你好，我准备好了。你想做什么？', en: 'Hello. I’m ready. What would you like to work on?' }; enqueue(samples[replyLanguage] || samples.en, '', replyLanguage || 'en'); };
window.addEventListener('pagehide', () => { clearInterval(frameWatchdog); media?.getTracks().forEach(t => t.stop()); socket?.close(); events?.close(); stopAudio(); if (busy && ownsTurn && session) fetch(base + `/session/${session.id}/abort` + query, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {}); });
// Parent waits for microphone/playback shutdown before replacing the iframe.
window.addEventListener('message', async event => {
  if (!embedded || event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'openchamber.voice.theme') { applyTheme(event.data.theme); return; }
  if (event.data?.type !== 'openchamber.voice.stop') return;
  await stopCall(); parent.postMessage({ type: 'openchamber.voice.stopped', request: event.data.request }, location.origin);
});

try {
  const r = await fetch('/voice/asr-health');
  const d = await r.json(); const tts = await (await fetch('/voice/health')).json(); speechReady = d.ready && tts.ready;
  $('start').disabled = !speechReady;
  if (!speechReady) error('Local speech models are not ready yet. You can still type.');
  updateStatus();
  void loadSpeechDetector().catch(() => {});
  if (sessionStorage.getItem(sessionKey)) await ensureSession();
} catch(e) { error('Sign in to OpenChamber and reload to connect local speech.'); status('Speech unavailable'); }
