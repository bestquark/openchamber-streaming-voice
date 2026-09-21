// Pinned, self-hosted Silero VAD. Microphone PCM stays in this page until a
// speech turn is confirmed. No external CDN, telemetry, or loudness fallback.
let loading;
function script(src) {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script'); element.src = src;
    element.onload = resolve;
    element.onerror = () => { element.remove(); reject(new Error('Speech detection could not load. Please reload and try again.')); };
    document.head.append(element);
  });
}
export async function loadSpeechDetector() {
  if (!loading) loading = (async () => {
    if (!window.ort) await script('/voice/vendor/ort.wasm.min.js');
    if (!window.vad) await script('/voice/vendor/bundle.min.js');
  })().catch(error => { loading = null; throw error; });
  await loading;
}
export async function createSpeechDetector(stream, context, onFrame) {
  await loadSpeechDetector();
  return window.vad.MicVAD.new({
    model: 'v5', baseAssetPath: '/voice/vendor/', onnxWASMBasePath: '/voice/vendor/',
    audioContext: context, processorType: 'AudioWorklet', startOnLoad: false,
    getStream: async () => stream, pauseStream: async () => {}, resumeStream: async () => stream,
    ortConfig: ort => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
    onFrameProcessed: (probabilities, frame) => onFrame(frame, probabilities.isSpeech),
    // Our TurnDetector owns turn boundaries and the stricter interruption rule.
    positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.4,
    redemptionMs: 1400, preSpeechPadMs: 800, minSpeechMs: 160,
  });
}
