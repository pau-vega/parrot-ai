# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Parrot AI

A **real-time** voice agent that listens and responds inside an Aircall call.
Current use: **staging**, talking to another AI (no real people or data, so GDPR /
EU AI Act considerations don't apply). Background context: screening of home-care
caregiver candidates. In the default prompt the agent **plays the candidate**
(María Fernández) and the other party is the interviewer — not the other way around.

## Core design idea

Aircall **does not expose call audio over its API** (only post-call recordings via
webhook). For real time, audio is captured at the macOS OS layer using **virtual
audio devices (BlackHole)**. Aircall keeps the two call directions separate, so by
using two distinct devices **there is no echo**.

Routing:

```
remote AI ─(call)─ Aircall
  Aircall OUTPUT/speaker  ->  BlackHole 2ch  ->  Node pipeline (input)   [the agent HEARS]
  Node pipeline (output)  ->  BlackHole 16ch ->  Aircall MIC             [the agent SPEAKS]
```

## Architecture

The realtime pipeline is **fully in-process Node/TypeScript** (it replaced an
earlier Pipecat/Python implementation — there is no Python left). STT, VAD, LLM,
TTS, audio I/O, and the turn engine all run in the backend process, so the VAD
that triggers barge-in and the output stream it interrupts live together.

The backend is laid out in **hexagonal / ports-and-adapters** style:

- `domain/` — pure logic, no IO libs. `ports.ts` declares the interfaces
  (`VadPort`, `SttPort`, `LlmPort`, `TtsPort`, `AudioInputPort`/`AudioOutputPort`,
  `TranscriptRepositoryPort`, plus the driving `PipelineBackend`). `turn-engine.ts`
  is the state machine; it depends only on ports. `conversation.ts`,
  `sentence-chunker.ts`, `turn-detector.ts` are the extracted pure units.
- `adapters/` — the concrete IO: audio, vad, stt, llm, tts, transcript, and the
  `http/` driving adapter (Express + WS).
- `application/pipeline-service.ts` — lifecycle: builds a `TurnEngine` per start,
  forwards its event stream, captures + persists the session transcript.
- `config/composition-root.ts` — the **only** place that imports concrete driven
  adapters; wires them into the domain behind the ports (`buildPipeline()`).

Dependency rule: `domain/` imports zero libs; driven adapters are referenced only
from the composition root; `index.ts` wires the http adapter and signals.

## Repository structure (pnpm monorepo + Turborepo)

```
parrot-ai/
  pnpm-workspace.yaml   ← declares apps/*; allowBuilds for native addons
  turbo.json            ← Turborepo task pipeline (build, dev, check-types)
  prompts/
    default-es.txt      ← canonical Spanish persona prompt (single source)
  models/               ← git-ignored weights, fetched via tools/fetch-models.sh
    ggml-base.bin                  ← whisper.cpp STT model
    silero_vad.onnx                ← Silero v5 VAD model
    es_ES-davefx-medium.onnx(.json)← Piper TTS voice
  tools/
    fetch-models.sh     ← downloads STT/VAD models + Piper voice
  apps/
    frontend/           ← vanilla JS UI (no build step)
      index.html
    backend/            ← Node.js/TypeScript server (hexagonal layout)
      src/
        index.ts         ← thin entry: load .env, buildPipeline(), start WS, signals
        types.ts         ← TypeScript types for all WS + event messages (wire contract)
        domain/          ← pure logic, no IO libs
          ports.ts          ← all port interfaces + driving PipelineBackend
          types.ts          ← value objects (AgentConfig, ChatMessage, TranscriptEntry, Session)
          turn-engine.ts    ← turn engine: VAD→STT→LLM→TTS→playback + barge-in (over ports)
          conversation.ts   ← chat history aggregate (feeds the LLM port)
          sentence-chunker.ts(+test) ← token stream → sentence chunks
          turn-detector.ts(+test)    ← VAD turn-taking hysteresis (prob → start/end)
        application/
          pipeline-service.ts ← lifecycle, event forwarding, transcript capture + persist
        adapters/          ← concrete IO behind the ports
          audio/naudiodon-audio.ts ← naudiodon-neo capture (16k) + playback (22050), device resolve
          vad/silero-vad.ts        ← Silero v5 via onnxruntime-node (prob only)
          stt/whisper-stt.ts       ← whisper.cpp (Metal) via smart-whisper
          llm/deepseek-llm.ts      ← DeepSeek streaming via openai SDK (stateless token stream)
          tts/piper-tts.ts         ← Piper TTS: piper_phonemize WASM → onnxruntime-node (pure Node)
          transcript/file-transcript-repository.ts ← per-session transcript JSON
          http/ws-server.ts        ← Express + WebSocket driving adapter, serves frontend/
        config/
          config.ts           ← single source for prompt + model/voice/LLM/device config
          composition-root.ts ← wires concrete adapters into the domain (buildPipeline)
```

## Stack

- **Backend (Node.js):** Express serves static `apps/frontend/`, `ws` handles `/ws`
  (`adapters/http/ws-server.ts`). `PipelineService` (`application/`) runs the
  in-process pipeline and emits a `PipelineEvent` stream to the browser.
- **Orchestration / real time:** hand-rolled turn engine in `domain/turn-engine.ts`
  (Silero VAD for turn-taking + barge-in). No Pipecat. Turn-taking hysteresis is
  the pure `domain/turn-detector.ts`; the VAD adapter returns probability only.
- **Audio I/O:** `naudiodon-neo` (PortAudio). Input opened on BlackHole 2ch at
  **16kHz mono** (Whisper/VAD native); output on BlackHole 16ch at **22050Hz mono**
  (Piper native) — BlackHole accepts both rates, so no resampling. Device pairing
  is by case-insensitive **substring** (numbered BlackHole duplicates).
- **STT:** `smart-whisper` (whisper.cpp), `model=base`, Spanish, on **Metal/GPU**.
  Warmed on start (the first run pays a one-time ~3s Metal kernel compile);
  warm transcription is ~180ms. Faster than the old Python CPU faster-whisper.
- **VAD:** Silero v5 via `onnxruntime-node`. 512-sample frames at 16kHz with a
  **64-sample context prepend** and a carried `[2,1,128]` state (mirrors the
  reference OnnxWrapper). Start/stop hysteresis drives turns + barge-in.
- **LLM:** DeepSeek via the `openai` SDK (`base_url=https://api.deepseek.com/v1`,
  `model=deepseek-chat`). Use **deepseek-chat**, never the reasoner (R1): it
  overthinks for conversation. `max_tokens=160`. The adapter
  (`adapters/llm/deepseek-llm.ts`) is **stateless** — it streams raw token deltas;
  history lives in `domain/conversation.ts` and sentence chunking in
  `domain/sentence-chunker.ts`, so TTS can start before the full reply lands.
- **TTS:** Piper, **pure Node** (`adapters/tts/piper-tts.ts`). Text → phoneme ids via the real
  `piper_phonemize` compiled to WASM (`@diffusionstudio/piper-wasm`, so phonemes
  match the trained voice — the espeak-ng CLI does **not** match), then VITS
  inference via `onnxruntime-node` (voice `es_ES-davefx-medium`, scales
  `[0.667, 1.0, 0.8]`, 22050Hz). Warmed on start; warm synth ~30ms per sentence.

## WebSocket protocol (`/ws` — browser-facing)

- **Client → server:**
  - `{type:"start", input_device, output_device}` — starts the pipeline.
  - `{type:"stop"}` — stops the pipeline.
  - `{type:"set_prompt", text}` — updates the prompt (applies on the next "start").
- **Server → client:**
  - `{type:"hello", running, devices:{input,output}, config:{prompt,input_device,output_device,llm,stt,tts}}` — on connect.
  - `{type:"state", value}` — `idle | listening | thinking | speaking`.
  - `{type:"transcript", role, text, ts?}` — transcript events.
  - `{type:"latency", ms}` — `UserStoppedSpeaking → BotStartedSpeaking` time.
  - `{type:"running", value}` / `{type:"error", message}`.

Internally `PipelineService` emits the same set as `PipelineEvent` (plus an
`init` with prompt + devices the server caches for `hello`).

## Configuration (environment)

The backend auto-loads a repo-root `.env` at startup (`index.ts`, Node's native
`process.loadEnvFile()` — no `dotenv` dependency). It's skipped silently if the
file is absent, so an exported/ambient env works too. Copy `.env.example` →
`.env` to get started.

- `DEEPSEEK_API_KEY` — **required** (the LLM client throws without it).
- `LLM_BASE_URL` — optional, defaults to `https://api.deepseek.com/v1`.
- `LLM_MODEL` — optional, defaults to `deepseek-chat`.
- `LLM_MAX_TOKENS` — optional, defaults to `160` (short voice replies).
- `WHISPER_MODEL` — optional STT model, defaults to `base`.
- `PIPER_VOICE` — optional TTS voice, defaults to `es_ES-davefx-medium`.
- `PORT` — optional Node server port, defaults to `8000`.

`config/config.ts` is the single source for the prompt + model/voice/device
defaults. Only `DEEPSEEK_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, and `PORT` are
declared in `turbo.json`'s `globalEnv`.

Per-session transcripts (role + text + ts) are persisted on stop by
`adapters/transcript/file-transcript-repository.ts` to a git-ignored
`transcripts/` dir, one JSON file per session.

## How to run

Requirements: macOS (Apple Silicon), `DEEPSEEK_API_KEY`, BlackHole 2ch and 16ch,
Node.js ≥ 20, pnpm ≥ 9, and a native toolchain (`cmake` + Xcode Command Line
Tools) — the audio/STT addons build **from source** (no prebuilds for current
Node on arm64). No Python.

```bash
# System deps (once)
brew install --cask blackhole-2ch blackhole-16ch   # audio driver (prompts for password)
brew install cmake                                  # builds whisper.cpp + naudiodon-neo
xcode-select --install                              # if not already present

# Node env (once) — native addons build during install (allowBuilds in pnpm-workspace.yaml)
pnpm install

# Models + Piper voice (once; weights are git-ignored)
tools/fetch-models.sh

# Run — UI (key via repo-root .env, or an exported env var)
cp .env.example .env                        # then fill in DEEPSEEK_API_KEY
pnpm dev                                    # = turbo dev; open http://localhost:8000
# or: pnpm --filter @parrot/backend dev
```

In Aircall settings: speaker = `BlackHole 2ch`, mic = `BlackHole 16ch`.

`pnpm lint` / `pnpm typecheck` both run `tsc --noEmit` across the workspace (no
separate linter). Unit tests cover the pure domain units via Node's built-in test
runner: `pnpm --filter @parrot/backend test` (`tsx --test src/domain/*.test.ts`) —
no framework installed.

## Gotchas

- The UI **needs the local backend**; it does not work in an isolated preview.
- **Native addons build from source on current Node/arm64** (no prebuilds): needs
  `cmake` + Xcode CLT. `pnpm install` runs the build via `allowBuilds` in
  `pnpm-workspace.yaml`; if an addon is missing, `node-gyp rebuild` in its package
  dir is the fallback.
- **Use `naudiodon-neo`, not `naudiodon`** — the original `naudiodon` segfaults in
  `getDevices()` on modern Node (old NAN addon vs new V8).
- **TTS phonemization must use `piper_phonemize`** (the WASM build), not the
  `espeak-ng` CLI. The CLI's `--ipa` output drops phonemes piper expects (e.g.
  palatalization, punctuation), so it produces degraded audio. The WASM build is
  the same C++ lib piper uses → phoneme ids match the trained voice.
- Piper has no working standalone binary on macOS arm64 (the release ships without
  its dylibs) — irrelevant now (TTS is in-process WASM+onnx), but don't go chasing
  the binary.
- BlackHole input is opened at 16kHz and output at 22050Hz; opening the same
  BlackHole device for both directions **in one process** can fail with PortAudio
  AUHAL `err=-50`. In production the two directions are separate devices, so this
  only bites loopback test harnesses.
- Target latency < 1–1.5 s; measured ~1.4 s end-to-end (dominated by LLM
  time-to-first-sentence + first TTS; STT is no longer the bottleneck).
- Two BlackHole installs with the same name get numbered; pairing is by **substring**
  (`adapters/audio/naudiodon-audio.ts resolveDevice`).
- Don't try to capture Aircall's WebRTC from the browser: it's cross-origin. The
  valid path is OS-level virtual audio.

## TODO

- [ ] **Hot reload** of the system prompt without restarting the agent
      (right now `set_prompt` only applies on the next "Start").
- [x] **Logging** of the per-session transcript (role + timestamps) — persisted to
      `transcripts/` on stop. Download from the UI is still open.

## Conventions

- Code comments, docstrings, and UI copy in **English**.
- The agent's persona prompt stays **Spanish** — the agent converses in Spanish
  (Whisper `language=es` + `es_ES` Piper voice). Switching to English means also
  changing the STT language and the TTS voice.
- Agent replies short and natural (it's voice, not chat).
- The persona prompt lives in `prompts/default-es.txt`, loaded once by
  `config/config.ts` as `DEFAULT_PROMPT`. It is **not** duplicated elsewhere.
- **Hexagonal dependency rule:** keep `domain/` free of concrete IO libs; wire new
  adapters only in `config/composition-root.ts` behind a port in `domain/ports.ts`.
- TypeScript follows the `typescript-rules@AI-Devkit` plugin conventions (enabled
  in `.claude/settings.json`): e.g. `interface extends` over `&`, no `enum`s,
  `import type`, no default exports, explicit return types, avoid `any`.
