import { resolve } from "path"
import { Whisper } from "smart-whisper"

import type { SttPort } from "../../domain/ports.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../")
const MODEL = resolve(REPO_ROOT, "models/ggml-base.bin")

/**
 * Whisper STT via whisper.cpp (Metal/GPU on Mac), base model, Spanish. The model
 * loads once and is warmed on init so the first real turn doesn't pay the ~3s
 * Metal kernel-compile cost.
 */
export class WhisperSTT implements SttPort {
  private whisper?: Whisper

  async load(): Promise<void> {
    this.whisper = new Whisper(MODEL, { gpu: true })
    // Warm-up: compile Metal kernels now, not on the first user turn.
    const silence = new Float32Array(16000)
    const task = await this.whisper.transcribe(silence, { language: "es" })
    await task.result
  }

  /** Transcribe 16kHz mono float32 audio to a single trimmed Spanish string. */
  async transcribe(audio: Float32Array): Promise<string> {
    if (!this.whisper) throw new Error("WhisperSTT: call load() before transcribe()")
    const task = await this.whisper.transcribe(audio, { language: "es" })
    const segments = await task.result
    return segments
      .map((s) => s.text)
      .join("")
      .trim()
  }

  async free(): Promise<void> {
    await this.whisper?.free()
  }
}
