"""
Thin Piper TTS synth helper for the Node realtime pipeline.

Piper has no working standalone binary on macOS arm64 (the release ships without
its dylibs), so this tiny process is the ONE Python piece the Node pipeline keeps.
It is a stateless text->PCM synthesizer: the voice model loads once and stays
warm; Node owns everything realtime (capture, VAD, STT, LLM, playback, barge-in).
Because synthesis is request/response and off the continuous audio/turn loop,
keeping it here does not regress latency or interruption (Node still controls the
output stream and can stop feeding it instantly on barge-in).

Protocol (binary framed, over stdin/stdout; stderr is for logs only):
  Node -> here  (stdin) : one UTF-8 JSON line per request: {"text": "..."}
  here -> Node  (stdout): per request, an 8-byte header then the PCM body:
                          [u32 LE sample_rate][u32 LE byte_len] + byte_len bytes
                          of signed 16-bit little-endian mono PCM.
                          byte_len == 0 means "nothing to speak" (empty text).

Env: PIPER_VOICE_ONNX (path to the .onnx voice; .json is auto-resolved alongside).
"""

import json
import os
import struct
import sys
from pathlib import Path

from piper import PiperVoice
from piper.config import SynthesisConfig


def log(msg: str) -> None:
    print(f"[tts_piper] {msg}", file=sys.stderr, flush=True)


def main() -> None:
    onnx = os.environ.get("PIPER_VOICE_ONNX")
    if not onnx or not Path(onnx).exists():
        log(f"voice model not found: {onnx!r}")
        sys.exit(1)

    # Load once, keep warm. espeak data ships inside the piper-tts package.
    voice = PiperVoice.load(onnx)
    syn = SynthesisConfig(normalize_audio=False)
    log(f"ready: {Path(onnx).name}")

    stdout = sys.stdout.buffer
    for line in sys.stdin:  # blocks until Node writes a request line
        line = line.strip()
        if not line:
            continue
        try:
            text = (json.loads(line).get("text") or "").strip()
        except json.JSONDecodeError:
            log(f"bad request line: {line[:80]!r}")
            continue

        if not text:
            stdout.write(struct.pack("<II", 0, 0))
            stdout.flush()
            continue

        # Synthesize the whole utterance, concatenate PCM, frame it back.
        pcm = bytearray()
        sample_rate = 22050
        for chunk in voice.synthesize(text, syn_config=syn):
            sample_rate = chunk.sample_rate
            pcm += chunk.audio_int16_bytes
        stdout.write(struct.pack("<II", sample_rate, len(pcm)))
        stdout.write(pcm)
        stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass  # Node went away; exit quietly
