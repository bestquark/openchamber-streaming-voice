// AudioWorklet: send short PCM frames. Audio remains in memory, never on disk.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) this.buffer.push(input[i]);
      const length = Math.round(sampleRate / 20);
      while (this.buffer.length >= length) {
        const data = new Float32Array(this.buffer.splice(0, length));
        this.port.postMessage(data, [data.buffer]);
      }
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
