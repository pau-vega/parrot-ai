#!/usr/bin/env bash
# Fetch the model weights the Node realtime pipeline (PIPELINE_BACKEND=node) needs.
# Weights are git-ignored (large); run this once after cloning.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models

# Whisper STT (whisper.cpp ggml, base) — matches the Python config's "base" model.
if [ ! -f models/ggml-base.bin ]; then
  echo "↓ ggml-base.bin (~147MB)"
  curl -fSL -o models/ggml-base.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
fi

# Silero VAD v5 (16kHz) — turn-taking + barge-in.
if [ ! -f models/silero_vad.onnx ]; then
  echo "↓ silero_vad.onnx (~2MB)"
  curl -fSL -o models/silero_vad.onnx \
    https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx
fi

# Piper TTS voice (es_ES davefx, medium) — used by python/tts_piper.py.
PIPER_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium
if [ ! -f python/es_ES-davefx-medium.onnx ]; then
  echo "↓ es_ES-davefx-medium.onnx (~63MB)"
  curl -fSL -o python/es_ES-davefx-medium.onnx "$PIPER_BASE/es_ES-davefx-medium.onnx"
  curl -fSL -o python/es_ES-davefx-medium.onnx.json "$PIPER_BASE/es_ES-davefx-medium.onnx.json"
fi

echo "✓ models ready (./models + python/ piper voice)"
