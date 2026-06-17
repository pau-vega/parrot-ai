"""
Parrot AI backend (Python / Pipecat).

Serves the UI (apps/frontend/index.html), exposes /ws (WebSocket) for control and
live events, and starts/stops the Pipecat pipeline based on what you send from the
panel.

Run (from this directory):
    uv run uvicorn app:app --host 127.0.0.1 --port 8000
    # then open http://localhost:8000

Tested against Pipecat 1.3.0 (see requirements.txt). In 1.x the API changed from
earlier versions: context is LLMContext + LLMContextAggregatorPair, VAD lives in
LLMUserAggregatorParams (not the transport), Piper is native (voice_id, no HTTP
server), and transcript/state are observed with a BaseObserver over the pipeline
frames.
"""

import asyncio
import os
import time
import warnings
from contextlib import suppress
from pathlib import Path

import sounddevice as sd
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.frames.frames import (
    TranscriptionFrame,
    LLMTextFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
)

# PipelineTask still works in 1.3.0 (subclass of PipelineWorker) but warns about
# deprecation; we silence that noise in the logs.
warnings.filterwarnings("ignore", category=DeprecationWarning)

# Repo layout: this file is apps/agent/app.py, so the repo root is two parents up.
# The frontend, persona prompt and .env all live relative to it (single sources).
REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_INDEX = REPO_ROOT / "apps" / "frontend" / "index.html"
PROMPT_FILE = REPO_ROOT / "prompts" / "default-es.txt"

# Auto-load the repo-root .env (mirrors the old Node entry's native .env load).
# Skipped silently if absent, so an exported/ambient env works too.
load_dotenv(REPO_ROOT / ".env")

PIPER_VOICE = "es_ES-davefx-medium"   # auto-downloaded on first use
WHISPER_MODEL = "base"                # base+int8 = faster than small; small if accuracy lacking
WHISPER_COMPUTE = "int8"              # CPU on Mac (whisper doesn't use MPS); int8 ~2-4x faster than float32
LLM_MAX_TOKENS = 160                  # short voice replies; cuts the LLM's long tail

# LLM: OpenAI. gpt-4o-mini is fast/cheap — good fit for short voice replies.
LLM_API_KEY = os.environ.get("OPENAI_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("Missing LLM key: export OPENAI_API_KEY (or set it in the repo-root .env).")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

# Persona prompt lives in prompts/default-es.txt (single source); Spanish on purpose
# (Whisper language=ES + es_ES Piper voice).
DEFAULT_PROMPT = PROMPT_FILE.read_text(encoding="utf-8").strip()

state = {
    "prompt": DEFAULT_PROMPT,
    "input_device": "BlackHole 2ch",
    "output_device": "BlackHole 16ch",
}

app = FastAPI()
clients: set[WebSocket] = set()
agent_task: asyncio.Task | None = None


# --- utilities -------------------------------------------------------------
def device_names(kind: str) -> list[str]:
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    seen, out = set(), []
    for d in sd.query_devices():
        if d[key] > 0 and d["name"] not in seen:
            seen.add(d["name"]); out.append(d["name"])
    return out


def device_index(name: str, kind: str) -> int:
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    for idx, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d[key] > 0:
            return idx
    raise RuntimeError(f"{kind} device '{name}' not found")


async def broadcast(msg: dict) -> None:
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def is_running() -> bool:
    return agent_task is not None and not agent_task.done()


# --- observer: pipeline frames -> UI ---------------------------------------
class ConsoleObserver(BaseObserver):
    """Translates Pipecat frames into the UI's WebSocket messages.

    An observer sees ALL the pipeline's frames (regardless of its position), so it's
    the natural place to feed transcript, state and latency. One frame crosses
    several edges -> on_push_frame fires multiple times; we deduplicate by frame id.
    """

    def __init__(self) -> None:
        super().__init__()
        self._seen: set = set()
        self._assistant_buf: list[str] = []
        self._t_user_stopped: float | None = None

    def _fresh(self, frame) -> bool:
        fid = getattr(frame, "id", id(frame))
        if fid in self._seen:
            return False
        self._seen.add(fid)
        if len(self._seen) > 4000:        # memory bound on long calls
            self._seen.clear()
        return True

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if not self._fresh(frame):
            return

        # --- caller transcript (final STT) ---
        if isinstance(frame, TranscriptionFrame) and isinstance(data.source, STTService):
            text = (getattr(frame, "text", "") or "").strip()
            if text:
                await broadcast({"type": "transcript", "role": "user", "text": text})
            return

        # --- agent transcript (LLM response, per turn) ---
        if isinstance(frame, LLMFullResponseStartFrame):
            self._assistant_buf = []
            return
        if isinstance(frame, LLMTextFrame):
            self._assistant_buf.append(getattr(frame, "text", "") or "")
            return
        if isinstance(frame, LLMFullResponseEndFrame):
            text = "".join(self._assistant_buf).strip()
            self._assistant_buf = []
            if text:
                await broadcast({"type": "transcript", "role": "assistant", "text": text})
            return

        # --- state + latency ---
        if isinstance(frame, UserStartedSpeakingFrame):
            await broadcast({"type": "state", "value": "listening"})
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._t_user_stopped = time.monotonic()
            await broadcast({"type": "state", "value": "thinking"})
        elif isinstance(frame, BotStartedSpeakingFrame):
            if self._t_user_stopped is not None:
                ms = int((time.monotonic() - self._t_user_stopped) * 1000)
                await broadcast({"type": "latency", "ms": ms})
                self._t_user_stopped = None
            await broadcast({"type": "state", "value": "speaking"})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            await broadcast({"type": "state", "value": "listening"})


# --- the pipeline ----------------------------------------------------------
async def run_agent() -> None:
    try:
        transport = LocalAudioTransport(
            LocalAudioTransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                input_device_index=device_index(state["input_device"], "input"),
                output_device_index=device_index(state["output_device"], "output"),
            )
        )
        stt = WhisperSTTService(
            model=WHISPER_MODEL, language=Language.ES, compute_type=WHISPER_COMPUTE
        )
        llm = OpenAILLMService(
            api_key=LLM_API_KEY,
            model=LLM_MODEL,
            params=OpenAILLMService.InputParams(max_tokens=LLM_MAX_TOKENS),
        )
        tts = PiperTTSService(voice_id=PIPER_VOICE)  # native, downloads the voice

        # Context + aggregators. VAD (turn-taking + barge-in) lives here in 1.x.
        context = LLMContext([{"role": "system", "content": state["prompt"]}])
        agg = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
        )

        pipeline = Pipeline([
            transport.input(),
            stt,
            agg.user(),
            llm,
            tts,
            transport.output(),
            agg.assistant(),
        ])

        task = PipelineTask(pipeline, params=PipelineParams())
        task.add_observer(ConsoleObserver())
    except Exception as e:
        await broadcast({"type": "error", "message": str(e)})
        await broadcast({"type": "running", "value": False})
        return

    await broadcast({"type": "running", "value": True})
    await broadcast({"type": "state", "value": "listening"})
    try:
        await PipelineRunner().run(task)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        await broadcast({"type": "error", "message": str(e)})
    finally:
        with suppress(Exception):
            await task.cancel()
        await broadcast({"type": "running", "value": False})
        await broadcast({"type": "state", "value": "idle"})


# --- routes ----------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(FRONTEND_INDEX)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    global agent_task
    await ws.accept()
    clients.add(ws)
    await ws.send_json({
        "type": "hello",
        "running": is_running(),
        "devices": {"input": device_names("input"), "output": device_names("output")},
        "config": {
            "prompt": state["prompt"],
            "input_device": state["input_device"],
            "output_device": state["output_device"],
            "llm": LLM_MODEL, "stt": "whisper · es", "tts": "piper",
        },
    })
    try:
        while True:
            cmd = await ws.receive_json()
            t = cmd.get("type")
            if t == "start" and not is_running():
                state["input_device"] = cmd.get("input_device") or state["input_device"]
                state["output_device"] = cmd.get("output_device") or state["output_device"]
                agent_task = asyncio.create_task(run_agent())
            elif t == "stop" and is_running():
                agent_task.cancel()
                with suppress(asyncio.CancelledError):
                    await agent_task
            elif t == "set_prompt":
                state["prompt"] = cmd.get("text", state["prompt"])
                # takes effect on the next "start"
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
