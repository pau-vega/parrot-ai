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

The realtime pipeline is **in-process Node/TypeScript** (it replaced an earlier
Pipecat/Python implementation). The only remaining Python is a thin Piper TTS
synth helper — Piper ships no working standalone binary on macOS arm64, and
synthesis is a stateless text→PCM step off the realtime control loop, so keeping
it as a child process does not split the audio or turn-taking path.

Audio never crosses a process boundary except that one stateless synth call, so
the VAD that triggers barge-in and the output stream it interrupts live together.

## Repository structure (pnpm monorepo + Turborepo)

```
parrot-ai/
  pnpm-workspace.yaml   ← declares apps/*; allowBuilds for native addons
  turbo.json            ← Turborepo task pipeline (build, dev, check-types)
  prompts/
    default-es.txt      ← canonical Spanish persona prompt (single source)
  models/               ← git-ignored weights, fetched via tools/fetch-models.sh
    ggml-base.bin        ← whisper.cpp STT model
    silero_vad.onnx      ← Silero v5 VAD model
  tools/
    fetch-models.sh     ← downloads STT/VAD models + Piper voice
  apps/
    frontend/           ← vanilla JS UI (no build step)
      index.html
    backend/            ← Node.js/TypeScript server
      src/
        index.ts         ← Express + WebSocket, serves frontend/, owns the backend
        backend.ts       ← PipelineBackend interface (the seam)
        node-backend.ts  ← NodePipelineBackend: runs the pipeline, emits events
        config.ts        ← single source for prompt + model/voice/LLM/device config
        types.ts         ← TypeScript types for all WS + event messages
        rt/              ← the realtime pipeline
          audio.ts        ← naudiodon-neo capture (16k) + playback (22050), device resolve
          vad.ts          ← Silero v5 via onnxruntime-node, turn-taking hysteresis
          stt.ts          ← whisper.cpp (Metal) via smart-whisper
          llm.ts          ← DeepSeek streaming via openai SDK, sentence chunking
          tts.ts          ← client for the Piper synth helper (framed PCM over stdio)
          orchestrator.ts ← turn engine: VAD→STT→LLM→TTS→playback + barge-in
  python/
    tts_piper.py        ← thin persistent Piper synth (text→PCM); the only Python left
    requirements.txt    ← just piper-tts
    es_ES-davefx-medium.onnx       ← Piper voice (git-ignored; fetch-models.sh)
    es_ES-davefx-medium.onnx.json
```

## Stack

- **Backend (Node.js):** Express serves static `apps/frontend/`, `ws` handles `/ws`.
  `NodePipelineBackend` runs the in-process pipeline and emits a `PipelineEvent`
  stream to the browser.
- **Orchestration / real time:** hand-rolled turn engine in `rt/orchestrator.ts`
  (Silero VAD for turn-taking + barge-in). No Pipecat.
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
  overthinks for conversation. `max_tokens=160`. Streams tokens and yields
  **sentence chunks** so TTS can start before the full reply lands.
- **TTS:** Piper via `python/tts_piper.py` (a persistent child; voice model warm).
  Voice `es_ES-davefx-medium`; warm synth ~tens of ms per sentence.

## TTS helper protocol (Node ↔ python/tts_piper.py)

`rt/tts.ts` spawns `.venv/bin/python python/tts_piper.py` with `PIPER_VOICE_ONNX` set.

- **Node → helper (stdin):** one UTF-8 JSON line per request: `{"text": "..."}`.
- **helper → Node (stdout):** per request, `[u32 LE sample_rate][u32 LE byte_len]`
  then `byte_len` bytes of signed-16-bit little-endian mono PCM (`byte_len==0` =
  nothing to speak).
- **stderr** is for logs only — never write anything else to the helper's stdout.

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

Internally `NodePipelineBackend` emits the same set as `PipelineEvent` (plus an
`init` with prompt + devices the server caches for `hello`).

## Configuration (environment)

- `DEEPSEEK_API_KEY` — **required** (the LLM client throws without it).
- `LLM_BASE_URL` — optional, defaults to `https://api.deepseek.com/v1`.
- `LLM_MODEL` — optional, defaults to `deepseek-chat`.
- `PORT` — optional Node server port, defaults to `8000`.

`config.ts` is the single source for the prompt + model/voice/device defaults.

## How to run

Requirements: macOS (Apple Silicon), `DEEPSEEK_API_KEY`, BlackHole 2ch and 16ch,
Node.js ≥ 20, pnpm ≥ 9, **Python 3.12** (piper-tts), and a native toolchain
(`cmake` + Xcode Command Line Tools) — the audio/STT addons build **from source**
(no prebuilds for current Node on arm64).

```bash
# System deps (once)
brew install --cask blackhole-2ch blackhole-16ch   # audio driver (prompts for password)
brew install cmake                                  # builds whisper.cpp + naudiodon-neo
xcode-select --install                              # if not already present

# Python helper env (once) — only piper-tts
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt

# Node env (once) — native addons build during install (allowBuilds in pnpm-workspace.yaml)
pnpm install

# Models + Piper voice (once; weights are git-ignored)
tools/fetch-models.sh

# Run — UI
export DEEPSEEK_API_KEY="..."
pnpm turbo dev                              # open http://localhost:8000
# or: pnpm --filter @parrot/backend dev
```

In Aircall settings: speaker = `BlackHole 2ch`, mic = `BlackHole 16ch`.

There are no tests configured. `pnpm lint` / `pnpm typecheck` both run `tsc --noEmit`
across the workspace (no separate linter).

## Gotchas

- The UI **needs the local backend**; it does not work in an isolated preview.
- **Native addons build from source on current Node/arm64** (no prebuilds): needs
  `cmake` + Xcode CLT. `pnpm install` runs the build via `allowBuilds` in
  `pnpm-workspace.yaml`; if an addon is missing, `node-gyp rebuild` in its package
  dir is the fallback.
- **Use `naudiodon-neo`, not `naudiodon`** — the original `naudiodon` segfaults in
  `getDevices()` on modern Node (old NAN addon vs new V8).
- **Piper has no working standalone binary on macOS arm64** (the release ships
  without its dylibs), hence the `python/tts_piper.py` helper.
- BlackHole input is opened at 16kHz and output at 22050Hz; opening the same
  BlackHole device for both directions **in one process** can fail with PortAudio
  AUHAL `err=-50`. In production the two directions are separate devices, so this
  only bites loopback test harnesses.
- Target latency < 1–1.5 s; measured ~1.4 s end-to-end (dominated by LLM
  time-to-first-sentence + first TTS; STT is no longer the bottleneck).
- Two BlackHole installs with the same name get numbered; pairing is by **substring**
  (`rt/audio.ts resolveDevice`).
- Don't try to capture Aircall's WebRTC from the browser: it's cross-origin. The
  valid path is OS-level virtual audio.
- `python/tts_piper.py` stdout is the **framed-PCM channel** — only the helper's
  audio protocol goes there; use `sys.stderr` for any debug output.
- The venv was created under an old path, so `.venv/bin/<console-script>` shebangs
  (e.g. `pip`, `piper`) may be stale — use `.venv/bin/python -m <tool>` instead.

## TODO

- [ ] **Hot reload** of the system prompt without restarting the agent
      (right now `set_prompt` only applies on the next "Start").
- [ ] **Logging/download** of the per-session transcript (role + timestamps).
- [ ] Optional: pure-Node TTS (onnxruntime-node + espeak-ng) to drop the last
      Python dependency.

## Conventions

- Code comments, docstrings, and UI copy in **English**.
- The agent's persona prompt stays **Spanish** — the agent converses in Spanish
  (Whisper `language=es` + `es_ES` Piper voice). Switching to English means also
  changing the STT language and the TTS voice.
- Agent replies short and natural (it's voice, not chat).
- The persona prompt lives in `prompts/default-es.txt`, loaded once by
  `config.ts` as `DEFAULT_PROMPT`. It is **not** duplicated elsewhere.
