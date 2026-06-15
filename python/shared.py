"""
Shared config + pipeline construction for Parrot AI.

Both python/pipeline.py (IPC mode) and python/agent.py (headless CLI) import
from here so the persona prompt, the LLM/STT/TTS config and the Pipecat wiring
live in ONE place and cannot drift apart.

Tested against Pipecat 1.3.0 (see python/requirements.txt).
"""

import os
from pathlib import Path

import sounddevice as sd

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.transcriptions.language import Language
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)

# --- model / service config --------------------------------------------------
#
# These values are owned by the Node config (apps/backend/src/config.ts), which
# injects them as env vars when it spawns this process. The defaults below keep a
# directly-launched agent.py working standalone (no Node), so the two never drift.

PIPER_VOICE = os.environ.get("PIPER_VOICE", "es_ES-davefx-medium")  # auto-downloaded on first use
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")     # base+int8 faster than small; small if accuracy lacking
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")  # CPU on Mac (no MPS); int8 ~2-4x faster
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "160"))  # short voice replies; cuts the LLM's long tail

# LLM: DeepSeek's direct API (OpenAI-compatible endpoint).
# Use deepseek-chat; NEVER the reasoner (R1): it overthinks for conversation.
LLM_API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("Missing LLM key: export DEEPSEEK_API_KEY.")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")

# Default device names. Two distinct BlackHole devices keep the two call
# directions separate, so there is no echo (see CLAUDE.md).
DEFAULT_INPUT_DEVICE = os.environ.get("PARROT_INPUT_DEVICE", "BlackHole 2ch")    # Aircall output (agent HEARS)
DEFAULT_OUTPUT_DEVICE = os.environ.get("PARROT_OUTPUT_DEVICE", "BlackHole 16ch")  # Aircall mic (agent SPEAKS)

# Persona prompt: kept in Spanish on purpose (Whisper language=ES + es_ES Piper
# voice). The canonical text lives in prompts/default-es.txt so Node and Python
# read the SAME prompt. Node passes it via PARROT_PROMPT on spawn; agent.py falls
# back to reading the file directly.
_PROMPT_FILE = Path(__file__).resolve().parent.parent / "prompts" / "default-es.txt"
DEFAULT_PROMPT = os.environ.get("PARROT_PROMPT") or _PROMPT_FILE.read_text(encoding="utf-8").strip()


# --- device helpers ----------------------------------------------------------

def device_names(kind: str, devices=None) -> list[str]:
    """Unique device names exposing channels of `kind` ('input' | 'output').

    Pass a cached `devices` list to avoid re-querying CoreAudio.
    """
    devices = sd.query_devices() if devices is None else devices
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    seen: set[str] = set()
    out: list[str] = []
    for d in devices:
        if d[key] > 0 and d["name"] not in seen:
            seen.add(d["name"])
            out.append(d["name"])
    return out


def device_index(name: str, kind: str, devices=None) -> int:
    """CoreAudio index of the first `kind` device whose name contains `name`.

    Pairing is by substring because duplicate BlackHole installs get numbered
    (see CLAUDE.md). Raises RuntimeError if no match. Pass a cached `devices`
    list to avoid re-querying CoreAudio.
    """
    devices = sd.query_devices() if devices is None else devices
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    for idx, d in enumerate(devices):
        if name.lower() in d["name"].lower() and d[key] > 0:
            return idx
    raise RuntimeError(f"{kind} device '{name}' not found")


# --- pipeline construction ---------------------------------------------------

def build_task(prompt: str, input_device: str, output_device: str) -> PipelineTask:
    """Build the STT -> LLM -> TTS Pipecat task bound to the two BlackHoles.

    Queries CoreAudio once and resolves both device indices from that snapshot.
    The caller attaches observers and runs the task.
    """
    devices = sd.query_devices()

    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            input_device_index=device_index(input_device, "input", devices),
            output_device_index=device_index(output_device, "output", devices),
        )
    )
    stt = WhisperSTTService(
        model=WHISPER_MODEL, language=Language.ES, compute_type=WHISPER_COMPUTE
    )
    llm = OpenAILLMService(
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        model=LLM_MODEL,
        params=OpenAILLMService.InputParams(max_tokens=LLM_MAX_TOKENS),
    )
    tts = PiperTTSService(voice_id=PIPER_VOICE)

    context = LLMContext([{"role": "system", "content": prompt}])
    agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline([
        transport.input(),   # audio coming in via the input BlackHole
        stt,                 # -> text
        agg.user(),          # accumulates the user's turn (+ VAD)
        llm,                 # -> DeepSeek response (streaming)
        tts,                 # -> Piper audio
        transport.output(),  # out via the output BlackHole (= Aircall's mic)
        agg.assistant(),     # accumulates the agent's turn
    ])

    return PipelineTask(pipeline, params=PipelineParams())
