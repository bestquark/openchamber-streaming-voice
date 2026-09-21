(() => {
  const machines = ['local'];
  const requested = new URL(location.href).searchParams.get('machine');
  let saved;
  try { saved = sessionStorage.getItem('openchamber.machine') || localStorage.getItem('openchamber.machine'); } catch {}
  const machine = machines.includes(requested) ? requested : machines.includes(saved) ? saved : 'local';
  try { sessionStorage.setItem('openchamber.machine', machine); localStorage.setItem('openchamber.machine', machine); localStorage.setItem('openchamber.pwaName', 'OpenChamber'); } catch {}
  const prefix = '/machines/' + machine;
  // Upstream uses this identity for per-instance stores. Keep transports under the
  // same local origin as the browser workspace.
  window.__OPENCHAMBER_API_BASE_URL__ = location.origin + prefix;
  // Session navigation in upstream replaces the query string. Keep the machine
  // in copied links as well as in this tab's reload state.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = (state, unused, value) => {
      const url = new URL(value == null ? location.href : value, location.href);
      if (url.origin === location.origin) url.searchParams.set('machine', machine);
      const result = original(state, unused, url.href);
      window.dispatchEvent(new Event('openchamber:navigation'));
      return result;
    };
  }
  function routed(value) {
    const url = new URL(value, location.href);
    if (url.host === location.host && /^\/(api|auth|health)(\/|$)/.test(url.pathname)) url.pathname = prefix + url.pathname;
    return url.href;
  }
  const originalFetch = window.fetch.bind(window);
  function needsLogin(response) {
    if (!response.redirected || !response.url) return false;
    const url = new URL(response.url);
    if (url.origin !== location.origin || url.pathname !== '/login') return false;
    location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search));
    return true;
  }
  window.fetch = async (input, init) => {
    let target = input;
    let options = init;
    if (input instanceof Request) {
      const url = routed(input.url);
      if (url !== input.url) {
        // Passing a Request as RequestInit exposes its body as a ReadableStream.
        // Safari cannot upload that stream. Apply overrides, then retain the
        // complete body as bytes when changing the request's destination.
        const request = new Request(input, init);
        const body = request.body === null ? undefined : await request.arrayBuffer();
        target = new Request(url, {
          method: request.method, headers: request.headers, body,
          mode: request.mode, credentials: request.credentials, cache: request.cache,
          redirect: request.redirect, referrer: request.referrer,
          referrerPolicy: request.referrerPolicy, integrity: request.integrity,
          keepalive: request.keepalive, signal: request.signal,
        });
        options = undefined;
      }
    } else {
      target = routed(input);
    }
    const response = await originalFetch(target, options);
    if (needsLogin(response)) throw new Error('Sign in to unlock OpenChamber.');
    return response;
  };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(url, protocols) { super(routed(url), protocols); }
  };
  const OriginalEventSource = window.EventSource;
  window.EventSource = class extends OriginalEventSource {
    constructor(url, options) { super(routed(url), options); }
  };
  window.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('nav');
    bar.id = 'openchamber-fleet';
    bar.setAttribute('aria-label', 'Coding machine');
    bar.innerHTML = `<span class="fleet-wordmark">OpenChamber</span><button id="fleet-choice" aria-expanded="false" aria-controls="fleet-menu"><span class="fleet-dot"></span><span>${machine}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button><a class="fleet-lock" href="/logout" aria-label="Lock OpenChamber" title="Lock OpenChamber"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/><path d="M12 14v3"/></svg></a><div id="fleet-menu" hidden><div class="fleet-heading">Run on a machine</div>${machines.map(id=>`<a href="/?machine=${id}" data-machine="${id}" ${id === machine ? 'aria-current="true"' : ''}><span><strong>${id}</strong><small>${'Files and tools on this computer'}</small></span><span class="fleet-status">Checking…</span></a>`).join('')}<p>Files and tools run on the machine you choose.</p></div>`;
    document.body.prepend(bar);
    const voiceLink = document.createElement('a');
    voiceLink.href = '/voice?machine=' + machine; voiceLink.className = 'fleet-voice';
    voiceLink.textContent = 'Voice'; voiceLink.title = 'Streaming voice in the selected conversation';
    voiceLink.setAttribute('role', 'button'); voiceLink.setAttribute('aria-expanded', 'false');
    voiceLink.setAttribute('aria-controls', 'openchamber-voice-panel');
    const voicePanel = document.createElement('section'); voicePanel.id = 'openchamber-voice-panel';
    voicePanel.setAttribute('aria-label', 'Streaming voice'); voicePanel.hidden = true;
    const voiceHeader = document.createElement('div'); voiceHeader.className = 'voice-panel-header';
    const voiceTitle = document.createElement('span'); voiceTitle.textContent = 'Voice';
    const closeVoice = document.createElement('button'); closeVoice.textContent = '×';
    closeVoice.setAttribute('aria-label', 'Close voice');
    const voiceBody = document.createElement('div'); voiceBody.className = 'voice-panel-body';
    voiceHeader.append(voiceTitle, closeVoice); voicePanel.append(voiceHeader, voiceBody); document.body.append(voicePanel);
    let voiceOpen = false, frame = null, frameSession = '', transition = 0;
    const voiceTheme = () => document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    new MutationObserver(() => frame?.contentWindow?.postMessage({ type: 'openchamber.voice.theme', theme: voiceTheme() }, location.origin)).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    async function stopFrame(old) {
      if (!old) return;
      await new Promise(resolve => {
        const request = crypto.randomUUID(); let timer;
        const done = () => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(); };
        const receive = event => {
          if (event.origin === location.origin && event.source === old.contentWindow && event.data?.type === 'openchamber.voice.stopped' && event.data.request === request) done();
        };
        window.addEventListener('message', receive); timer = setTimeout(done, 1800);
        old.contentWindow?.postMessage({ type: 'openchamber.voice.stop', request }, location.origin);
      });
      old.remove();
    }
    async function syncVoice() {
      if (!voiceOpen) return;
      const session = new URL(location.href).searchParams.get('session') || '';
      if (frame && session === frameSession) return;
      const revision = ++transition, old = frame; frame = null; frameSession = '';
      await stopFrame(old);
      if (revision !== transition || !voiceOpen) return;
      voiceBody.replaceChildren(); voiceTitle.textContent = 'Voice';
      if (!/^ses[a-zA-Z0-9_-]+$/.test(session)) {
        const note = document.createElement('p'); note.className = 'voice-panel-empty';
        note.textContent = 'Choose a conversation from the sidebar. For a new conversation, send its first message, then start voice here.';
        voiceBody.append(note); return;
      }
      const next = document.createElement('iframe'); next.title = 'Voice controls for selected conversation';
      next.allow = 'microphone; autoplay'; next.src = '/voice?' + new URLSearchParams({ machine, session, embed: '1', theme: voiceTheme() });
      frame = next; frameSession = session; voiceBody.append(next);
      try {
        const response = await originalFetch(prefix + '/api/session/' + session);
        if (response.ok) {
          const info = await response.json();
          if (revision === transition) { voiceTitle.textContent = info.title || 'Voice'; voiceTitle.title = info.directory || ''; }
        }
      } catch {}
    }
    async function setVoiceOpen(open) {
      voiceOpen = open; voicePanel.hidden = !open;
      document.body.classList.toggle('openchamber-voice-open', open); voiceLink.setAttribute('aria-expanded', String(open));
      if (open) await syncVoice();
      else { ++transition; const old = frame; frame = null; frameSession = ''; await stopFrame(old); voiceBody.replaceChildren(); }
    }
    voiceLink.addEventListener('click', event => { event.preventDefault(); void setVoiceOpen(!voiceOpen); });
    closeVoice.addEventListener('click', () => { void setVoiceOpen(false); voiceLink.focus(); });
    window.addEventListener('openchamber:navigation', () => { void syncVoice(); });
    window.addEventListener('popstate', () => { void syncVoice(); });
    bar.insertBefore(voiceLink, bar.querySelector('.fleet-lock')); bar.querySelector('.fleet-lock').remove();
    const button = document.getElementById('fleet-choice');
    const menu = document.getElementById('fleet-menu');
    function close() { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); }
    button.addEventListener('click', () => { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) refresh(); });
    document.addEventListener('click', event => { if (!bar.contains(event.target)) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); button.focus(); } });
    async function refresh() {
      try {
        const response = await originalFetch('/fleet/health');
        if (needsLogin(response)) return;
        if (!response.ok) throw new Error('Authentication required');
        const { machines: statuses } = await response.json();
        for (const status of statuses) {
          const row = bar.querySelector(`[data-machine="${status.id}"]`);
          if (!row) continue;
          const label = row.querySelector('.fleet-status');
          label.textContent = status.online ? 'Online' : 'Offline';
          label.classList.toggle('online', status.online);
          if (status.id === machine) button.querySelector('.fleet-dot').classList.toggle('online', status.online);
        }
      } catch { bar.querySelectorAll('.fleet-status').forEach(label => { label.textContent = 'Unavailable'; label.classList.remove('online'); }); }
    }
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    const manifest = document.querySelector('link[rel="manifest"]');
    if (manifest) manifest.href = '/site.webmanifest';
    for (const icon of document.querySelectorAll('link[rel="apple-touch-icon"]')) {
      const url = new URL(icon.href, location.href);
      url.searchParams.set('v', 'oc-20260905-opaque');
      icon.href = url.href;
      icon.setAttribute('sizes', '512x512');
    }
    document.title = `OpenChamber · ${machine}`;
  });
})();
