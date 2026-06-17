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
  Aircall OUTPUT/speaker  ->  BlackHole 2ch  ->  Python pipeline (input)  [the agent HEARS]
  Python pipeline (output) ->  BlackHole 16ch ->  Aircall MIC            [the agent SPEAKS]
```

## Architecture

The realtime pipeline is a **Python / Pipecat** app (`apps/agent/`). An earlier
in-process Node/TypeScript port produced poor transcripts on real call audio, so the
project was reverted to the known-good Pipecat implementation (pinned to the versions
that worked, see `apps/agent/requirements.txt`). There is no Node backend left.

`apps/agent/app.py` is the whole backend:

- A **FastAPI** server serves the UI (`apps/frontend/index.html`) at `/` and exposes
  `/ws` for control + live events.
- A **Pipecat `Pipeline`** is started/stopped per session: `transport.input()` →
  `WhisperSTTService` → `LLMContextAggregatorPair.user()` (VAD lives here in Pipecat
  1.x via `LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())`) →
  `OpenAILLMService` → `PiperTTSService` → `transport.output()` → `agg.assistant()`.
- A **`ConsoleObserver`** (`BaseObserver`) watches pipeline frames and translates them
  into the UI's WebSocket messages (transcript / state / latency), deduplicating by
  frame id.

Pipecat's `LocalAudioTransport` (sounddevice/PortAudio) owns audio capture/playback
and resampling; turn-taking + barge-in are handled by Pipecat's VAD aggregator. We do
not hand-roll a turn engine.

## Repository structure (pnpm monorepo + Turborepo, with a Python app)

```
parrot-ai/
  pnpm-workspace.yaml   ← declares apps/* + packages/*; catalog; allowBuilds (esbuild, lefthook)
  turbo.json            ← Turborepo task pipeline (build, dev, lint, typecheck, format, test)
  justfile              ← task runner; `just setup-agent` creates the Python venv (`just --list`)
  lefthook.yml          ← git hooks: pre-commit/pre-push, commit-msg (commitlint)
  commitlint.config.ts  ← conventional-commits config for the commit-msg hook
  .prettierrc / .prettierignore ← prettier config (semi:false, printWidth 120)
  prompts/
    default-es.txt      ← canonical Spanish persona prompt (single source, loaded by app.py)
  packages/             ← @parrot/tsconfig + @parrot/eslint-config (orphaned now the Node backend is gone)
  apps/
    frontend/           ← vanilla JS UI (no build step), served by the Python app
      index.html
    agent/              ← Python / Pipecat backend
      app.py            ← FastAPI + /ws + Pipecat pipeline + ConsoleObserver (the whole backend)
      requirements.txt  ← pinned, fully-frozen deps (the lockfile; `uv pip sync` reproduces it)
      pyproject.toml    ← uv project metadata (requires-python 3.12; deps via requirements.txt)
      package.json      ← Turborepo shim: `dev`/`start` scripts wrap `uv run uvicorn`
      .python-version   ← 3.12
```

faster-whisper and Piper auto-download their own weights to the Hugging Face cache on
first run — there is no `models/` dir or fetch step in the Python flow.

## Stack

- **Backend (Python):** FastAPI serves static `apps/frontend/` and handles `/ws`
  (`apps/agent/app.py`). Pipecat 1.3.0 orchestrates the realtime pipeline; a
  `ConsoleObserver` forwards frame events to the browser. Managed with **uv** (pinned
  `requirements.txt`, Python 3.12).
- **Orchestration / real time:** **Pipecat** `Pipeline` + `PipelineRunner`. VAD
  (turn-taking + barge-in) is `SileroVADAnalyzer`, wired via
  `LLMUserAggregatorParams` on the user aggregator (Pipecat 1.x location).
- **Audio I/O:** Pipecat `LocalAudioTransport` (sounddevice / PortAudio). Input =
  BlackHole 2ch, output = BlackHole 16ch, selected by case-insensitive **substring**
  (`device_index()`); Pipecat handles sample-rate conversion internally.
- **STT:** Pipecat `WhisperSTTService` = **faster-whisper** (CTranslate2),
  `model=base`, `language=ES`, `compute_type=int8` (CPU; int8 ~2–4× faster). This is
  the configuration that transcribed real call audio well.
- **LLM:** OpenAI via Pipecat `OpenAILLMService` (`model=gpt-4o-mini`,
  `max_tokens=160`). gpt-4o-mini is fast/cheap — good fit for short voice replies.
- **TTS:** Pipecat `PiperTTSService` (native, `voice_id=es_ES-davefx-medium`); the
  voice auto-downloads on first use. Requires the `pipecat-ai[piper]` extra
  (`piper-tts` package) — it's in `requirements.txt`.

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

Internally the `ConsoleObserver` broadcasts the same `state`/`transcript`/`latency`
messages to all connected WS clients (`broadcast()` in `app.py`).

## Configuration (environment)

`app.py` auto-loads a repo-root `.env` at startup via **python-dotenv**
(`load_dotenv`). It's skipped silently if absent, so an exported/ambient env works
too. Copy `.env.example` → `.env` to get started.

- `OPENAI_API_KEY` — **required** (`app.py` raises on startup without it).
- `LLM_MODEL` — optional, defaults to `gpt-4o-mini`.

The STT model (`base`/`int8`), TTS voice (`es_ES-davefx-medium`), `max_tokens` (160)
and the server port (8000) are **constants in `app.py`**, not env vars. The persona
prompt is read from `prompts/default-es.txt` (single source).

## How to run

Requirements: macOS (Apple Silicon), `OPENAI_API_KEY`, BlackHole 2ch and 16ch,
Python 3.12 (faster-whisper/onnxruntime have no 3.13/3.14 wheels), `uv`, Homebrew
`portaudio` (for PyAudio/sounddevice), and pnpm ≥ 9 (for the Turborepo task runner).

```bash
# System deps (once)
brew install --cask blackhole-2ch blackhole-16ch   # audio driver (prompts for password)
brew install portaudio uv                           # PortAudio for sounddevice/PyAudio; uv

# Python env (once) — creates apps/agent/.venv and installs the pinned deps
just setup-agent
# = cd apps/agent && uv venv --python 3.12 && uv pip sync requirements.txt
# If PyAudio fails to build, point it at Homebrew's portaudio:
#   CFLAGS=-I/opt/homebrew/include LDFLAGS=-L/opt/homebrew/lib uv pip sync requirements.txt

# Run — UI (key via repo-root .env, or an exported env var)
cp .env.example .env                        # then fill in OPENAI_API_KEY
pnpm dev                                    # = turbo dev → uvicorn; open http://localhost:8000
# or: cd apps/agent && uv run uvicorn app:app --port 8000
```

In Aircall settings: speaker = `BlackHole 2ch`, mic = `BlackHole 16ch`.

faster-whisper and the Piper voice download on first run (cached under
`~/.cache/huggingface`), so the first call after install is slower. `pnpm format` /
`format:check` run Prettier over the JS/JSON; lefthook + commitlint still apply to
commits. There are no unit tests in the Python app yet.

## Gotchas

- The UI **needs the local Python backend** running; it does not work in an isolated
  preview.
- **Python 3.12 only** — faster-whisper/ctranslate2 and onnxruntime have no wheels for
  3.13/3.14. `apps/agent/.python-version` pins it; `uv venv --python 3.12` enforces it.
- **PyAudio builds from source** against PortAudio. If the build can't find headers,
  export `CFLAGS=-I/opt/homebrew/include LDFLAGS=-L/opt/homebrew/lib` before the sync.
- **Piper needs the `[piper]` extra** — `PiperTTSService` imports the `piper` module
  (`piper-tts` on PyPI). It's pinned in `requirements.txt`; without it `app.py` fails
  to import (`ModuleNotFoundError: No module named 'piper'`).
- The deps are a **verbatim pinned freeze** of the known-good environment. Reproduce
  with `uv pip sync requirements.txt`; don't re-resolve against latest (that's how the
  quality regression crept in). Upgrading Pipecat is a deliberate separate task.
- Two BlackHole installs with the same name get numbered; pairing is by **substring**
  (`device_index()` in `app.py`).
- Don't try to capture Aircall's WebRTC from the browser: it's cross-origin. The valid
  path is OS-level virtual audio (Pipecat `LocalAudioTransport`).

## TODO

- [ ] **Hot reload** of the system prompt without restarting the agent
      (right now `set_prompt` only applies on the next "Start").
- [ ] **Logging** of the per-session transcript (role + timestamps) — was a Node-only
      feature; not yet reimplemented in the Python app.

## Conventions

- Code comments, docstrings, and UI copy in **English**.
- The agent's persona prompt stays **Spanish** — the agent converses in Spanish
  (Whisper `language=ES` + `es_ES` Piper voice). Switching to English means also
  changing the STT language and the TTS voice.
- Agent replies short and natural (it's voice, not chat).
- The persona prompt lives in `prompts/default-es.txt`, loaded once by `app.py` as
  `DEFAULT_PROMPT`. It is **not** duplicated elsewhere.
- **Pin discipline:** `requirements.txt` is a full freeze; change deps deliberately and
  re-freeze (`uv pip freeze > requirements.txt`), don't float versions.
- The `packages/` TS configs and the `typescript-rules` plugin only mattered for the
  removed Node backend; they're dormant. Python style is plain PEP 8 (no linter wired
  yet — `ruff` is the obvious add if wanted).
