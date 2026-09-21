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
