# OpenChamber streaming voice

A provider-neutral, local companion for [OpenChamber](https://github.com/openchamber/openchamber). Speak with the selected conversation while model text arrives, interrupt with your voice, and switch between projects and chats. Speech detection filters short background noises. No chimes.

This is an independent add-on, not an official OpenChamber plugin. It runs an unmodified, pinned OpenChamber Web package behind a localhost proxy. **Bring your own model and speech providers.** No private endpoint, hosted account, API key or model service is included.

## Quick start

Requires **Node.js 22+**, Git, the [OpenCode CLI](https://opencode.ai/docs/), an existing working OpenCode model configuration, and OpenAI-compatible transcription and speech services.

```sh
git clone https://github.com/bestquark/openchamber-streaming-voice.git
cd openchamber-streaming-voice
npm ci && npm run check
```

Configure your speech services in a private shell environment. For example, if a local server supplies both APIs:

```sh
export VOICE_API_BASE_URL=http://127.0.0.1:8000/v1
export VOICE_STT_MODEL=your-transcription-model
export VOICE_TTS_MODEL=your-speech-model
export VOICE_TTS_VOICE=your-preferred-voice
npm start -- --project="/absolute/path/to/your/project"
```

For an authenticated service, supply `VOICE_API_KEY` privately. If speech uses your selected OpenCode provider's exact API base URL, the launcher can reuse that provider's key, including `{env:...}` and `{file:...}` references. It reads `~/.config/opencode/opencode.json` and `opencode.jsonc` (or `XDG_CONFIG_HOME`) without rewriting them. Different service URLs do not implicitly receive that key.

Open **http://127.0.0.1:4260/**. On first launch, add the same project folder in OpenChamber. Choose a conversation, click **Voice**, then **Start conversation**, and allow the microphone. For a new conversation, send its first message before opening Voice. Switching chats ends the previous voice call. Press Control-C in the terminal to stop the local servers.

The language model stays configured through OpenCode. Voice prompts request the dominant language of the complete utterance, so a borrowed word should not switch an otherwise consistent reply. Actual language coverage, accents, voices and latency depend on your speech providers. This is sentence-chunked TTS from streaming text, not a native real-time audio model.

## Configuration

| Variable | Purpose |
| --- | --- |
| `VOICE_API_BASE_URL`, `VOICE_API_KEY` | Shared speech API base and optional bearer key. |
| `VOICE_STT_BASE_URL`, `VOICE_STT_API_KEY` | Override transcription destination/auth separately. |
| `VOICE_TTS_BASE_URL`, `VOICE_TTS_API_KEY` | Override speech destination/auth separately. |
| `VOICE_STT_MODEL` | Transcription model ID; default `whisper-1`. |
| `VOICE_TTS_MODEL`, `VOICE_TTS_VOICE` | Speech model and voice; defaults `tts-1` and `alloy`. |
| `VOICE_PORT` | First of three free local ports; default 4260. |
| `VOICE_DATA_DIR` | Private companion data/log directory; default `~/.local/share/openchamber-streaming-voice`. |

The base URLs include the API prefix, such as `/v1`. Providers must support `GET /models`, multipart `POST /audio/transcriptions`, and/or JSON `POST /audio/speech` with WAV output. The transcription and speech servers can be different. HTTPS is required for remote services; HTTP is supported on loopback. This adapter targets those HTTP contracts, not every provider that describes itself as compatible.

Optional language adapter: `VOICE_LANGUAGE_URL` can point to your own endpoint accepting `{text, previous}` and returning `{language, name}`. It is off by default; otherwise the language model selects the reply language. A different origin requires an explicit `VOICE_LANGUAGE_API_KEY` (empty for unauthenticated). `VOICE_TTS_LANGUAGE_FIELDS=1` additionally sends `language` and `languageSample` to speech providers that support those extensions. These are optional generic hooks, not bundled services.

## Local workspaces and privacy

Tools execute on this computer in the selected project directory, and OpenCode keeps its normal local conversations and tool history. An existing local installation may show its existing conversations. Project selection is a working directory, not a filesystem sandbox: retain normal tool permission checks.

Prompts, audio and selected file contents go to the providers you configure. Use local providers if you need offline processing. Each person should use their own local installation, OS account/data and provider credentials; no shared hosted workspace, VM, SSH or device enrollment is required. Provider credentials do not themselves register a device with a remote OpenChamber installation. See [SECURITY.md](SECURITY.md).

## Updates and verification

The pinned OpenChamber Web release is **1.24.2**. The companion does not patch its source or installed package files. It integrates through the HTML shell and existing session/event/dictation APIs.

To update: stop the companion, `git pull --ff-only`, `npm ci`, `npm run check`, then start again. Do not update the bundled OpenChamber through its built-in updater. Maintainers must review dependency/API changes and test real speech, interruption, conversation switching and narrow-screen layout before changing the pin.

The initial integration was checked on macOS Apple Silicon with OpenCode 1.18.31: an isolated synthetic ASR → model → TTS flow, local shell execution and the session/voice UI. The local test origin was blocked by this machine's Chrome; its UI rendered in Codex's browser, where microphone preparation did not complete. Those tests do not establish microphone/speaker success on another computer or compatibility with every provider. Windows is not supported; Linux has not been verified.

[OpenChamber PR #3748](https://github.com/openchamber/openchamber/pull/3748) adds sentence-chunked server TTS playback. It was still open when this companion was prepared. Overlapping code can be retired once upstream provides and passes the full streaming conversation flow.

## Troubleshooting and development

- **Speech unavailable:** check your base URLs, keys, `/models` response and configured model IDs.
- **Microphone blocked:** use the localhost URL and allow microphone access. Headphones help reduce speaker echo.
- **Port occupied:** stop the previous instance or choose three free consecutive ports. The launcher refuses to attach to another process.
- **Logs:** `VOICE_DATA_DIR/runtime.log`, or the default data directory above. Redact private text before sharing.
- **New chat has no voice controls yet:** submit the first text message, then open Voice.
- **Reconnecting to workspace:** the event stream retries automatically and recovers missed reply text without cancelling the agent.
- **Old speech-tool conversation stays silent:** update the companion and reload. Current voice turns explicitly replace older speech-tool instructions; history is retained. Keep only one voice call active for a conversation.
- **Slow first reply:** speech starts at the first completed sentence. Model reasoning and a long conversation can delay that sentence; OpenChamber's context compaction can reduce the history sent to the model without deleting the visible conversation.

`npm run check` checks the pinned shell contract, asset hashes, syntax, turn detection, speech chunking and request/config boundaries without credentials. After intentionally editing browser assets, run `node hash-assets.mjs`, review the diff, then rerun checks. Browser/audio acceptance remains a separate manual check.

## Licenses

Original companion code: MIT. OpenChamber remains separately licensed upstream. Browser VAD includes vad-web 0.0.31 (ISC), Silero v5 (MIT), and ONNX Runtime Web 1.22.0 (MIT); notices and asset provenance are in `voice/vendor/`. No inference or speech models other than the VAD model are distributed here.
