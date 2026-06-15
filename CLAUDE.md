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
  Aircall OUTPUT/speaker  ->  BlackHole 2ch  ->  Pipecat (input)    [the agent HEARS]
  Pipecat (output)        ->  BlackHole 16ch ->  Aircall MIC        [the agent SPEAKS]
```

## Stack

- **Orchestration / real time:** Pipecat (Silero VAD for turn-taking + barge-in).
- **STT:** local faster-whisper, `model="base"`, `compute_type="int8"`,
  `language=Language.ES`. Whisper runs on **CPU** on Mac (no MPS); `int8` is
  ~2-4x faster than `float32`. Bump to `small` only if accuracy is lacking (costs
  latency).
- **LLM:** DeepSeek via an OpenAI-compatible endpoint
  (`base_url=https://api.deepseek.com/v1`, `model="deepseek-chat"`).
  Use **deepseek-chat**, never the reasoner (R1): it overthinks for conversation.
  `max_tokens=160` to cut the long tail (voice replies are short).
- **TTS:** local **native** Piper (`piper-tts` package, `pipecat-ai[piper]` extra,
  no HTTP server). Voice `es_ES-davefx-medium`, auto-downloaded on first use via
  `voice_id`. The voice `.onnx`/`.onnx.json` files are cached in `console/`.
- **UI:** FastAPI serves `console/index.html` + a `/ws` WebSocket for control and
  live events (state, transcript, latency, prompt editing).

## Files

- `parrot_ai_agent.py` — headless (CLI) version, no UI. Useful for debugging.
- `console/app.py` — FastAPI backend + WebSocket + pipeline lifecycle.
- `console/index.html` — operator panel (vanilla JS, connects to `ws://localhost:8000/ws`).

> The Pipecat pipeline is **duplicated** across `parrot_ai_agent.py` (`main()`)
> and `console/app.py` (`run_agent()`), as are the config constants
> (`WHISPER_MODEL`, `WHISPER_COMPUTE`, `PIPER_VOICE`, `LLM_MAX_TOKENS`, and the
> `SYSTEM_PROMPT`/`DEFAULT_PROMPT`). If you touch the wiring or a model parameter,
> **change it in both places**.

## Configuration (environment)

- `DEEPSEEK_API_KEY` — **required**, startup fails if missing.
- `LLM_BASE_URL` — optional, defaults to `https://api.deepseek.com/v1`.
- `LLM_MODEL` — optional, defaults to `deepseek-chat`.

## How to run

Requirements: macOS (Apple Silicon), `DEEPSEEK_API_KEY` in the environment, BlackHole
2ch and 16ch installed. **Use Python 3.12** (faster-whisper/onnxruntime have no
wheels for 3.14). Piper no longer needs a server: the voice auto-downloads on first
use.

```bash
# environment (once)
brew install --cask blackhole-2ch blackhole-16ch   # audio driver (prompts for password)
brew install portaudio                              # needed to compile pyaudio
/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
# CFLAGS/LDFLAGS so pyaudio finds Homebrew's portaudio
export CFLAGS="-I/opt/homebrew/include" LDFLAGS="-L/opt/homebrew/lib"
pip install -r requirements.txt
# (alternative from scratch, pins fewer versions:)
# pip install "pipecat-ai[silero,whisper,openai,local,piper]" sounddevice faster-whisper fastapi uvicorn

# run — UI
export DEEPSEEK_API_KEY="..."
cd console && uvicorn app:app --host 127.0.0.1 --port 8000   # open http://localhost:8000

# run — headless (debugging, no UI)
export DEEPSEEK_API_KEY="..."
python parrot_ai_agent.py
```

In Aircall settings: speaker = `BlackHole 2ch`, mic = `BlackHole 16ch`.

There are no tests or linter configured in the repo.

## WebSocket protocol (`/ws`)

`console/app.py` keeps a **single** global `agent_task` → only one pipeline at a
time (`is_running()`). State lives in the `state` dict (prompt + devices). Messages:

- **Client → server:**
  - `{type:"start", input_device, output_device}` — starts the pipeline (ignored if already running).
  - `{type:"stop"}` — cancels the `agent_task`.
  - `{type:"set_prompt", text}` — updates the prompt; **applies on the next "start"**, not live.
- **Server → client:**
  - `{type:"hello", running, devices:{input,output}, config:{prompt,input_device,output_device,llm,stt,tts}}` — on connect.
  - `{type:"state", value}` — `idle | listening | thinking | speaking`.
  - `{type:"transcript", role, text, ts?}` — `role` = `user` (caller) | `assistant` (agent).
  - `{type:"latency", ms}` — `UserStoppedSpeaking → BotStartedSpeaking` time.
  - `{type:"running", value}` / `{type:"error", message}`.

The Pipecat-frames → WS-messages translation is done by `ConsoleObserver`
(a `BaseObserver` subclass), attached via `task.add_observer(...)`. See the next
section for why an observer and not something else.

## Pipecat API — resolved for 1.3.0 (pinned in `requirements.txt`)

The code is adapted to **Pipecat 1.3.0**. The API changed a lot from earlier
versions; if you upgrade Pipecat, review these points (`pip show pipecat-ai`).
Current mapping:

- **Context/aggregators:** `LLMContext([...])` +
  `LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(...))`
  → `.user()` / `.assistant()`. (Previously: `OpenAILLMContext` +
  `llm.create_context_aggregator`, which **no longer exist**.)
- **VAD:** lives in `LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())`,
  **not** in `LocalAudioTransportParams` (that parameter was removed).
- **Piper TTS:** `PiperTTSService(voice_id="es_ES-davefx-medium")`, native, no
  `base_url`/HTTP.
- **STT:** `WhisperSTTService(model="base", language=Language.ES)` —
  `language` is the `pipecat.transcriptions.language.Language` enum, not a string.
- **Transcript + UI state:** there is no `TranscriptProcessor` anymore. A
  `BaseObserver` (`ConsoleObserver` in `app.py`) over `on_push_frame` is used,
  reading `TranscriptionFrame` (user), `LLMTextFrame`/`LLMFullResponse*Frame`
  (agent) and `User/BotStartedSpeakingFrame` (state). One frame crosses several
  edges → `on_push_frame` fires multiple times, so it's **deduplicated by frame id**
  (`_fresh`, capped at 4000 ids). Attached with `task.add_observer(...)`.
- **Task:** `PipelineTask(pipeline, params=PipelineParams())` — `allow_interruptions`
  is no longer a field (interruptions on by default via the turn system).
  `PipelineTask` is marked *deprecated* (subclass of `PipelineWorker`) but works;
  shut down with `await task.cancel()`.

All the WebSocket/UI machinery and start/stop are stable.

## Gotchas

- The UI **needs the local backend**; it does not work in an isolated preview.
- Target latency < 1–1.5 s. Whisper is the usual bottleneck; it's already on
  `base`+`int8` (the fastest). Don't bump to `small` unless accuracy is lacking.
- Two BlackHole installs with the same name get numbered; pairing is by **substring**
  of the device name (`device_index`).
- Don't try to capture Aircall's WebRTC from the browser: it's cross-origin. The
  valid path is OS-level virtual audio.
- The `PipelineTask` deprecation warning is silenced with
  `warnings.filterwarnings("ignore", category=DeprecationWarning)` in both files.

## TODO

- [ ] **Hot reload** of the system prompt without restarting the agent
      (right now `set_prompt` only applies on the next "Start").
- [ ] **Logging/download** of the per-session transcript (role + timestamps).

## Conventions

- Code comments, docstrings, and UI copy in **English**.
- The agent's persona prompt (`SYSTEM_PROMPT`/`DEFAULT_PROMPT`) stays **Spanish** — the
  agent converses in Spanish (Whisper `language=ES` + `es_ES` Piper voice). Switching it
  to English means also changing the STT language and the TTS voice.
- Agent replies short and natural (it's voice, not chat).
