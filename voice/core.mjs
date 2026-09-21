// Pure helpers shared by the browser and the integration checks.
export class SpeechChunks {
  constructor() { this.pending = ''; this.inCode = false; }
  push(delta, final = false) {
    this.pending += delta;
    const chunks = [];
    while (this.pending) {
      const fence = this.pending.indexOf('```');
      if (this.inCode) {
        if (fence < 0) { this.pending = this.pending.slice(-2); break; }
        this.pending = this.pending.slice(fence + 3); this.inCode = false; continue;
      }
      if (fence === 0) { this.pending = this.pending.slice(3); this.inCode = true; continue; }
      const match = /[。！？]|[.!?…]["')\]]*(?:\s|$)|\n/.exec(this.pending);
      let end = match ? match.index + match[0].length : 0;
      if (fence > 0 && (!end || fence < end)) end = fence;
      if (!end && this.pending.length > 220) end = this.pending.lastIndexOf(' ', 200);
      if (!end && final) end = this.pending.length;
      if (!end) break;
      const raw = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      const clean = raw.replace(/https?:\/\/\S+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_#`~]/g, '').replace(/^\s*[-•]\s*/gm, '').replace(/\s+/g, ' ').trim();
      if (clean) chunks.push(clean);
    }
    return chunks;
  }
}

export class TurnDetector {
  constructor() { this.reset(); }
  reset() { this.active = false; this.onset = 0; this.quiet = 0; this.duration = 0; this.interrupting = false; }
  step(probability, ms, speaking = false, enabled = true) {
    if (!enabled) { this.onset = 0; return null; }
    // Silero speech probability, never raw loudness. A loud appliance is not
    // permission to cancel a reply. Require stronger, sustained speech to barge in.
    const voiced = Number.isFinite(probability) && probability >= (this.active ? 0.4 : speaking ? 0.85 : 0.65);
    if (!this.active) {
      if (!this.onset) this.interrupting = speaking;
      this.interrupting ||= speaking;
      this.onset = voiced ? this.onset + ms : Math.max(0, this.onset - ms * 2);
      if (this.onset >= (this.interrupting ? 384 : 160)) { this.active = true; this.duration = this.onset; this.quiet = 0; return 'start'; }
    } else {
      this.duration += ms; this.quiet = voiced ? 0 : this.quiet + ms;
      if (this.quiet >= 1400 || this.duration >= 59000) { this.reset(); return 'finish'; }
    }
    return null;
  }
}

export function pcmBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export const browserSpeechInstructions = `The browser handles the microphone and automatically speaks your ordinary assistant text as it streams. This replaces any earlier VoiceMode/converse instructions in this conversation, including instructions to stay silent, use speech tools, or loop listening. Always finish with a plain text reply for the browser to speak. Never use speech MCP tools, shell speech commands, afplay, say, or audio-device diagnostics to answer a voice check. A greeting or "can you hear me?" needs an immediate brief text answer, without tools. Do not emit private reasoning as the answer.`;

export function isCompactionReply(info) { return info.role === 'assistant' && info.summary === true; }

// EventSource reconnects itself. A transport interruption is not a request to
// cancel the agent. Reconcile persisted messages on reconnect to recover deltas.
export function connectWorkspaceEvents(url, { EventSourceClass = EventSource, onEvent, onDisconnect, onReconnect, timeoutMs = 15000 }) {
  const source = new EventSourceClass(url);
  let opened = false, disconnected = false, settled = false, resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true; source.close(); reject(new Error('Workspace event stream timed out. Please try again.'));
  }, timeoutMs);
  source.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (error) { console.error('Voice event:', error.message); } };
  source.onerror = () => { disconnected = true; onDisconnect(); };
  source.onopen = () => {
    clearTimeout(timer);
    if (!opened) { opened = true; settled = true; resolve(); }
    else if (disconnected) Promise.resolve().then(onReconnect).catch(onDisconnect);
    disconnected = false;
  };
  return { source, ready };
}
