import * as ort from "onnxruntime-node";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../../");
const MODEL = resolve(REPO_ROOT, "models/silero_vad.onnx");

// Silero v5 @ 16kHz: 512-sample frames, with a 64-sample context prepended each
// call (model input = 576), and a [2,1,128] state carried across calls. This
// mirrors the reference OnnxWrapper exactly (see silero_vad utils_vad.py).
export const VAD_FRAME = 512;
const CONTEXT = 64;
const SR = 16000;

/**
 * Streaming voice-activity detector. Feed 512-sample float32 frames; it emits a
 * speech probability per frame and tracks speech start/stop with hysteresis
 * (start fast, end after a hangover so short pauses don't end a turn).
 */
export class SileroVAD {
  private session!: ort.InferenceSession;
  private state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  private context = new Float32Array(CONTEXT);
  private readonly sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);

  // turn-taking hysteresis
  speaking = false;
  private silenceFrames = 0;
  constructor(
    private startThreshold = 0.5,
    private endThreshold = 0.35,
    private hangoverFrames = 24, // ~0.77s of sub-threshold frames ends a turn
  ) {}

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(MODEL);
  }

  /** Run one 512-sample frame; returns {prob, started, ended} edge flags. */
  async process(frame: Float32Array): Promise<{ prob: number; started: boolean; ended: boolean }> {
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);
    const out = await this.session.run({
      input: new ort.Tensor("float32", input, [1, input.length]),
      state: this.state,
      sr: this.sr,
    });
    this.state = out.stateN as ort.Tensor;
    this.context = input.slice(input.length - CONTEXT);
    const first = out.output?.data?.[0];
    const prob = typeof first === "number" ? first : 0;

    let started = false;
    let ended = false;
    if (!this.speaking) {
      if (prob >= this.startThreshold) {
        this.speaking = true;
        this.silenceFrames = 0;
        started = true;
      }
    } else {
      if (prob < this.endThreshold) {
        if (++this.silenceFrames >= this.hangoverFrames) {
          this.speaking = false;
          this.silenceFrames = 0;
          ended = true;
        }
      } else {
        this.silenceFrames = 0;
      }
    }
    return { prob, started, ended };
  }

  reset(): void {
    this.state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
    this.speaking = false;
    this.silenceFrames = 0;
  }
}
