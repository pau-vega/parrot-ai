import * as ort from "onnxruntime-node";
import { resolve } from "path";
import type { VadPort } from "../../domain/ports";

const REPO_ROOT = resolve(__dirname, "../../../../../");
const MODEL = resolve(REPO_ROOT, "models/silero_vad.onnx");

// Silero v5 @ 16kHz: 512-sample frames, with a 64-sample context prepended each
// call (model input = 576), and a [2,1,128] state carried across calls. This
// mirrors the reference OnnxWrapper exactly (see silero_vad utils_vad.py).
export const VAD_FRAME = 512;
const CONTEXT = 64;
const SR = 16000;

/**
 * Streaming voice-activity detector. Feed 512-sample float32 frames; it returns
 * a speech probability per frame. Turn-taking hysteresis lives in the domain
 * (TurnDetector) — this adapter only runs the model.
 */
export class SileroVAD implements VadPort {
  private session?: ort.InferenceSession;
  private state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  private context = new Float32Array(CONTEXT);
  private readonly sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SR)]), []);

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(MODEL);
    const names = this.session.outputNames;
    if (!names.includes("stateN") || !names.includes("output")) {
      throw new Error(`SileroVAD: unexpected model outputs [${names.join(", ")}]; expected "output" and "stateN"`);
    }
  }

  /** Run one 512-sample frame; returns the speech probability [0,1]. */
  async process(frame: Float32Array): Promise<number> {
    if (!this.session) throw new Error("SileroVAD: call load() before process()");
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);
    const out = await this.session.run({
      input: new ort.Tensor("float32", input, [1, input.length]),
      state: this.state,
      sr: this.sr,
    });
    const stateN = out.stateN;
    if (!stateN) throw new Error("SileroVAD: model missing stateN output");
    this.state = stateN;
    this.context = input.slice(input.length - CONTEXT);
    const first = out.output?.data?.[0];
    return typeof first === "number" ? first : 0;
  }

  reset(): void {
    this.state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
  }
}
