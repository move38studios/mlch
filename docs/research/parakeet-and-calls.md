# Local transcription (Parakeet), call listening and screenshots

Run on 2026-10-07 on an M4 Pro, 24 GB, macOS 15.6. Nothing built into the app; experiments in a scratch folder.

## Parakeet versus Groq

Same two clips (16 kHz mono WAV), parakeet-tdt-0.6b-v3 through parakeet-mlx (Python, MLX) and Groq whisper-large-v3-turbo.

| | 15.6 s clip | 28.5 s clip | Notes |
|---|---|---|---|
| Parakeet v3, local (MLX) | 0.26 s | 0.37 s | 60–78× real time once warm; first call 2.6 s; peak memory 3.7 GB; model 2.5 GB |
| Groq | 0.3–0.6 s | 0.3–0.4 s | network round trip included |

Accuracy was about the same. Both wrote "Kessler" for Koestler; Parakeet wrote "Heftabase" where Groq got "Heptabase". Numbers and currency came out formatted in both ("$10 million", "15%").

Speed is not a reason to switch. Local gains: offline, free, audio never leaves the Mac (matters most for calls). Local costs: a model download, memory while running, Apple Silicon and macOS 14+ only, 25 European languages (Groq's Whisper covers more).

### How to build it

- **FluidAudio** (Swift, Apache-2.0, CoreML on the Neural Engine, macOS 14+). Used by many Mac dictation and meeting apps. Parakeet Ultra (a post-trained v3, more accurate, same speed) has a 595 MB int8 encoder. The same library has streaming ASR with end-of-utterance detection, voice activity detection, speaker diarization (Sortformer up to 4 speakers, offline clustering for more) and echo removal (LocalVQE), which a call mode needs.
- Ship it as a small helper binary that main starts and talks to over stdio, outside Electron's processes (keeps the "no native ML in Electron" rule).
- It slots in behind the `Transcriber` interface: we already cut speech into chunks at pauses, which suits a batch model.
- Settings: Groq or local; the model downloads on first use (the first-run download screen is already planned).
- Effort: about 2–3 days including signing the helper.
- Not benchmarked: FluidAudio itself. `swift build` failed here because the Command Line Tools (16.2) do not match their own SDK ("this SDK is not supported by the compiler"). Reinstalling the Command Line Tools or installing Xcode fixes it; any native helper needs that.
- Rejected: shipping Python and MLX inside the app (heavy); onnxruntime-node inside Electron (crashes, see CLAUDE.md). A WebAssembly ONNX build would follow our rules but is untested and likely much slower.

## Listening to calls

Two streams: the microphone (already captured) and the Mac's sound output, which carries the other people.

| Route | Permission | Verdict |
|---|---|---|
| Core Audio process tap (macOS 14.4+), on Zoom, Teams or all output | "System Audio Recording Only" (`NSAudioCaptureUsageDescription`) | Use this. Needs the same kind of Swift helper as Parakeet, so one helper can do both |
| ScreenCaptureKit audio | Screen Recording, re-approved periodically on macOS 15 | Heavier permission than needed |
| Electron `desktopCapturer` loopback audio | — | Documented Windows only (Electron 44.6) |
| Virtual devices (BlackHole and similar) | — | The person would have to set it up |

- Mic and system audio kept apart gives "me" and "them" for free; diarization separates voices within "them".
- On speakers rather than headphones the mic also hears the others: echo removal with system audio as the reference, or drop mic segments that duplicate system audio.
- A call mode differs from braindump capture: slower batches (every 30–60 s), pulling out ideas, decisions and open questions with speaker labels, and a clear indicator while listening. Never starts on its own.
- Cost: Groq about $0.04 per hour of audio; local is free.
- Consent: in many places (California, much of the EU) everyone on a call must agree to be recorded.
- Effort: roughly 1–2 weeks with the helper.
- Not tested: live system-audio capture (it would raise macOS permission prompts).

## Screenshots

- A global shortcut opens macOS's own window picker (`SCContentSharingPicker`, macOS 15; Electron's `setDisplayMediaRequestHandler` with `useSystemPicker: true`). Picking a window this way needs no Screen Recording permission.
- The capture lands on the canvas as an image card; the image lane already captions and enriches it.
- Only the person triggers it. The AI taking screenshots on its own would need the full permission and feels invasive.
- Effort: about a day.
