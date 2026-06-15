"""
Real-time voice agent over Aircall (macOS, staging / AI-vs-AI).
Headless (CLI) version, no UI — handy for debugging the pipeline.

Audio routing (set it in Sound prefs + Aircall settings):
    Aircall  SPEAKER/OUTPUT -> "BlackHole 2ch"    (the agent HEARS here)
    Aircall  MIC/INPUT      <- "BlackHole 16ch"   (the agent SPEAKS here)

Pipeline:
    BlackHole 2ch -> SileroVAD -> faster-whisper -> DeepSeek -> Piper -> BlackHole 16ch

Config, persona prompt and pipeline wiring live in python/shared.py.
Tested against Pipecat 1.3.0 (see requirements.txt).
"""

import asyncio
import sys
import warnings

import sounddevice as sd

from pipecat.pipeline.runner import PipelineRunner

import shared
from shared import DEFAULT_INPUT_DEVICE, DEFAULT_OUTPUT_DEVICE, DEFAULT_PROMPT

warnings.filterwarnings("ignore", category=DeprecationWarning)


async def main() -> None:
    try:
        task = shared.build_task(
            DEFAULT_PROMPT, DEFAULT_INPUT_DEVICE, DEFAULT_OUTPUT_DEVICE
        )
    except RuntimeError as e:
        print(f"[!] {e}. Available devices:\n")
        print(sd.query_devices())
        sys.exit(1)

    print("[*] Agent running. Start the call in Aircall.")
    await PipelineRunner().run(task)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[*] Stopped.")
