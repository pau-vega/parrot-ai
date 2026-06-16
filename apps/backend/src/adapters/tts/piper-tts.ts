import createPiperPhonemize from "@diffusionstudio/piper-wasm/build/piper_phonemize.js"
import * as ort from "onnxruntime-node"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

import type { TtsPort, TtsResult } from "../../domain/ports.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../")
const VOICE_ONNX = resolve(REPO_ROOT, "models/es_ES-davefx-medium.onnx")
const WASM_GLUE = fileURLToPath(import.meta.resolve("@diffusionstudio/piper-wasm/build/piper_phonemize.js"))
const WASM_DIR = dirname(WASM_GLUE)

// Piper voice config (es_ES-davefx-medium): VITS inference scales + output rate.
const ESPEAK_VOICE = "es"
const SCALES = Float32Array.from([0.667, 1.0, 0.8]) // noise_scale, length_scale, noise_w
const SAMPLE_RATE = 22050

interface PhonemizeResult {
  phoneme_ids: number[]
}

/**
 * Pure-Node Piper TTS: text → phoneme ids (the real piper_phonemize compiled to
 * WASM, so phonemes match the trained voice) → VITS inference via onnxruntime-node
 * → 16-bit PCM. No Python, no child process.
 */
export class PiperTTS implements TtsPort {
  private session?: ort.InferenceSession
  private phonemize?: (text: string) => number[]
  sampleRate: number = SAMPLE_RATE

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(VOICE_ONNX)
    if (!this.session.outputNames.includes("output")) {
      throw new Error(
        `PiperTTS: ONNX model missing expected output "output"; found: ${this.session.outputNames.join(", ")}`,
      )
    }

    // One warm WASM instance; callMain is reused per synth. espeak-ng-data is
    // preloaded inside the module at /espeak-ng-data.
    const lines: string[] = []
    const mod = await createPiperPhonemize({
      print: (l) => lines.push(l),
      printErr: () => {},
      locateFile: (p) => resolve(WASM_DIR, p),
    })
    this.phonemize = (text: string): number[] => {
      lines.length = 0
      mod.callMain(["-l", ESPEAK_VOICE, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"])
      const ids: number[] = []
      for (const line of lines) {
        try {
          ids.push(...(JSON.parse(line) as PhonemizeResult).phoneme_ids)
        } catch {
          // non-JSON log line — ignore
        }
      }
      return ids
    }

    // Warm the VITS graph so the first real turn doesn't pay graph-init cost.
    await this.synth("hola")
  }

  /** Synthesize one sentence to 16-bit PCM at this.sampleRate. */
  async synth(text: string): Promise<TtsResult> {
    if (!this.phonemize || !this.session) throw new Error("PiperTTS: call load() before synth()")
    const ids = this.phonemize(text)
    if (ids.length === 0) return { sampleRate: this.sampleRate, pcm: Buffer.alloc(0) }

    const input = new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length])
    const inputLengths = new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1])
    const scales = new ort.Tensor("float32", SCALES, [3])
    const out = await this.session.run({ input, input_lengths: inputLengths, scales })

    const audio = out.output?.data
    if (!(audio instanceof Float32Array)) return { sampleRate: this.sampleRate, pcm: Buffer.alloc(0) }
    const pcm = Buffer.alloc(audio.length * 2)
    for (let i = 0; i < audio.length; i++) {
      const s = Math.max(-1, Math.min(1, audio[i] ?? 0))
      pcm.writeInt16LE((s < 0 ? s * 32768 : s * 32767) | 0, i * 2)
    }
    return { sampleRate: this.sampleRate, pcm }
  }
}
