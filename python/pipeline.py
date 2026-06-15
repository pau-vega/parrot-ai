"""
Parrot AI pipeline (IPC mode).

Communicates with the Node.js backend via stdin/stdout newline-delimited JSON.
All logging goes to stderr so it does not pollute the JSON channel.

Commands received on stdin:
    {"type": "start", "input_device": "...", "output_device": "..."}
    {"type": "stop"}
    {"type": "set_prompt", "text": "..."}

Events emitted on stdout:
    {"type": "init", "prompt": "...", "devices": {"input": [...], "output": [...]}}
    {"type": "running", "value": true/false}
    {"type": "state", "value": "idle|listening|thinking|speaking"}
    {"type": "transcript", "role": "user|assistant", "text": "..."}
    {"type": "latency", "ms": 420}
    {"type": "error", "message": "..."}

Config, persona prompt and pipeline wiring live in python/shared.py.
Tested against Pipecat 1.3.0 (see python/requirements.txt).
"""

import asyncio
import json
import logging
import os
import sys
import time
import warnings
from collections import OrderedDict
from contextlib import suppress
from typing import Any

from pipecat.pipeline.runner import PipelineRunner
from pipecat.services.stt_service import STTService
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

import shared
from shared import DEFAULT_INPUT_DEVICE, DEFAULT_OUTPUT_DEVICE, DEFAULT_PROMPT

warnings.filterwarnings("ignore", category=DeprecationWarning)

# stderr only — stdout is the IPC channel and must stay pure JSON.
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("parrot.pipeline")

# Cap on the de-dup id buffer (one frame crosses several edges, so on_push_frame
# fires multiple times per frame). Oldest ids are evicted one at a time.
SEEN_MAX = 4000

state = {
    "prompt": DEFAULT_PROMPT,
    "input_device": DEFAULT_INPUT_DEVICE,
    "output_device": DEFAULT_OUTPUT_DEVICE,
}

agent_task: asyncio.Task | None = None


# --- IPC helpers -------------------------------------------------------------

def ipc_write(msg: dict[str, Any]) -> None:
    """Write a JSON event to stdout (the IPC channel to Node).

    If Node has gone away the pipe is broken; exit quietly instead of dumping a
    BrokenPipeError traceback.
    """
    try:
        print(json.dumps(msg, ensure_ascii=False), flush=True)
    except BrokenPipeError:
        os._exit(0)


# --- observer: pipeline frames -> IPC ----------------------------------------

class ConsoleObserver(BaseObserver):
    """Translates Pipecat frames into IPC events for the Node backend.

    Writes to stdout instead of broadcasting over WebSocket.
    """

    def __init__(self) -> None:
        super().__init__()
        # OrderedDict as a bounded FIFO set: eviction is one-at-a-time so a
        # frame still in flight is never spuriously re-emitted (a bulk .clear()
        # at the cap could duplicate transcripts/state).
        self._seen: OrderedDict[Any, None] = OrderedDict()
        self._assistant_buf: list[str] = []
        self._t_user_stopped: float | None = None

    def _fresh(self, frame) -> bool:
        fid = getattr(frame, "id", id(frame))
        if fid in self._seen:
            return False
        self._seen[fid] = None
        if len(self._seen) > SEEN_MAX:
            self._seen.popitem(last=False)
        return True

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if not self._fresh(frame):
            return

        if isinstance(frame, TranscriptionFrame) and isinstance(data.source, STTService):
            text = (getattr(frame, "text", "") or "").strip()
            if text:
                ipc_write({"type": "transcript", "role": "user", "text": text})
            return

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
                ipc_write({"type": "transcript", "role": "assistant", "text": text})
            return

        if isinstance(frame, UserStartedSpeakingFrame):
            ipc_write({"type": "state", "value": "listening"})
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._t_user_stopped = time.monotonic()
            ipc_write({"type": "state", "value": "thinking"})
        elif isinstance(frame, BotStartedSpeakingFrame):
            if self._t_user_stopped is not None:
                ms = int((time.monotonic() - self._t_user_stopped) * 1000)
                ipc_write({"type": "latency", "ms": ms})
                self._t_user_stopped = None
            ipc_write({"type": "state", "value": "speaking"})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            ipc_write({"type": "state", "value": "listening"})


# --- pipeline ----------------------------------------------------------------

async def run_agent() -> None:
    try:
        task = shared.build_task(
            state["prompt"], state["input_device"], state["output_device"]
        )
        task.add_observer(ConsoleObserver())
    except Exception as e:
        log.exception("Failed to build pipeline")
        ipc_write({"type": "error", "message": str(e)})
        ipc_write({"type": "running", "value": False})
        return

    ipc_write({"type": "running", "value": True})
    ipc_write({"type": "state", "value": "listening"})
    try:
        await PipelineRunner().run(task)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        log.exception("Pipeline run failed")
        ipc_write({"type": "error", "message": str(e)})
    finally:
        with suppress(Exception):
            await task.cancel()
        ipc_write({"type": "running", "value": False})
        ipc_write({"type": "state", "value": "idle"})


# --- IPC command dispatcher --------------------------------------------------

async def handle_cmd(cmd: dict) -> None:
    global agent_task
    t = cmd.get("type")
    if t == "start" and (agent_task is None or agent_task.done()):
        state["input_device"] = cmd.get("input_device") or state["input_device"]
        state["output_device"] = cmd.get("output_device") or state["output_device"]
        agent_task = asyncio.create_task(run_agent())
    elif t == "stop" and agent_task is not None and not agent_task.done():
        agent_task.cancel()
        with suppress(asyncio.CancelledError):
            await agent_task
    elif t == "set_prompt":
        state["prompt"] = cmd.get("text", state["prompt"])


async def ipc_reader() -> None:
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            log.warning("Dropping malformed IPC line: %r", line)
            continue
        await handle_cmd(cmd)


# --- entry point -------------------------------------------------------------

async def main() -> None:
    ipc_write({
        "type": "init",
        "prompt": DEFAULT_PROMPT,
        "devices": {
            "input": shared.device_names("input"),
            "output": shared.device_names("output"),
        },
    })
    await ipc_reader()


if __name__ == "__main__":
    asyncio.run(main())
