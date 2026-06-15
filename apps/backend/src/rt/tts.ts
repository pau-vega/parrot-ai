import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../../");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");
const TTS_SCRIPT = resolve(REPO_ROOT, "python/tts_piper.py");
const VOICE_ONNX = resolve(REPO_ROOT, "python/es_ES-davefx-medium.onnx");

/**
 * Piper TTS via the thin persistent Python synth helper (python/tts_piper.py).
 * Piper has no working standalone binary on macOS arm64, so this one Python
 * process stays — but it's a stateless text->PCM synth, off the realtime control
 * loop. The model loads once; warm synth is ~tens of ms per sentence.
 *
 * Protocol: write {"text"} JSON lines; read [u32 sample_rate][u32 len] + PCM.
 */
export class PiperTTS {
  private proc!: ChildProcess;
  private buf = Buffer.alloc(0);
  private queue: Array<(r: { sampleRate: number; pcm: Buffer }) => void> = [];
  sampleRate = 22050;

  async load(): Promise<void> {
    this.proc = spawn(PYTHON_BIN, [TTS_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, PIPER_VOICE_ONNX: VOICE_ONNX },
    });
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    // Give the voice model a moment to load before the first request.
    await new Promise((r) => setTimeout(r, 1500));
  }

  private pump(): void {
    while (this.buf.length >= 8) {
      const sampleRate = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) return;
      const pcm = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      const resolveFn = this.queue.shift();
      if (resolveFn) resolveFn({ sampleRate, pcm: Buffer.from(pcm) });
    }
  }

  /** Synthesize one sentence to 16-bit PCM (sampleRate set on the result). */
  synth(text: string): Promise<{ sampleRate: number; pcm: Buffer }> {
    return new Promise((res) => {
      this.queue.push(res);
      this.proc.stdin!.write(JSON.stringify({ text }) + "\n");
    });
  }

  kill(): void {
    this.proc?.stdin?.end();
    this.proc?.kill();
  }
}
