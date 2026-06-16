import { EventEmitter } from "events";
import * as portAudio from "naudiodon-neo";

export const STT_SAMPLE_RATE = 16000;

/** Resolve a device id by case-insensitive substring (numbered BlackHole duplicates match the base name). */
export function resolveDevice(name: string, kind: "input" | "output"): number {
  const key = kind === "input" ? "maxInputChannels" : "maxOutputChannels";
  const dev = portAudio.getDevices().find((d) => d.name.toLowerCase().includes(name.toLowerCase()) && d[key] > 0);
  if (!dev) throw new Error(`${kind} device '${name}' not found`);
  return dev.id;
}

/** Unique device names exposing channels of `kind` — feeds the UI device list. */
export function deviceNames(kind: "input" | "output"): string[] {
  const key = kind === "input" ? "maxInputChannels" : "maxOutputChannels";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of portAudio.getDevices()) {
    if (d[key] > 0 && !seen.has(d.name)) {
      seen.add(d.name);
      out.push(d.name);
    }
  }
  return out;
}

/**
 * Capture from the input BlackHole at 16kHz mono and emit fixed 512-sample
 * float32 frames (the size Silero VAD wants). PortAudio hands us arbitrary-size
 * int16 buffers, so we reframe.
 */
export class AudioInput extends EventEmitter {
  private io: portAudio.AudioIO;
  private acc: number[] = [];
  private readonly frameSize = 512;

  constructor(deviceName: string) {
    super();
    this.io = new portAudio.AudioIO({
      inOptions: {
        channelCount: 1,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: STT_SAMPLE_RATE,
        deviceId: resolveDevice(deviceName, "input"),
        closeOnError: false,
      },
    });
    this.io.on("data", (buf: Buffer) => this.onData(buf));
  }

  private onData(buf: Buffer): void {
    for (let i = 0; i + 1 < buf.length; i += 2) this.acc.push(buf.readInt16LE(i) / 32768);
    while (this.acc.length >= this.frameSize) {
      const chunk = this.acc.splice(0, this.frameSize);
      this.emit("frame", Float32Array.from(chunk));
    }
  }

  start(): void {
    this.io.start();
  }
  stop(): void {
    this.io.quit();
  }
}

/**
 * Playback to the output BlackHole (= Aircall mic). Opened at the TTS sample
 * rate (Piper davefx = 22050). Audio is written in small slices so barge-in can
 * stop it promptly: `stop()` drops everything still queued.
 */
export class AudioOutput {
  private io: portAudio.AudioIO;
  private cancelled = false;

  constructor(
    deviceName: string,
    private sampleRate: number,
  ) {
    this.io = new portAudio.AudioIO({
      outOptions: {
        channelCount: 1,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: this.sampleRate,
        deviceId: resolveDevice(deviceName, "output"),
        closeOnError: false,
      },
    });
    this.io.start();
  }

  /** Write PCM in ~20ms slices; abort early if stop() fires (barge-in). */
  async play(pcm: Buffer): Promise<void> {
    this.cancelled = false;
    const slice = Math.floor(this.sampleRate * 0.02) * 2; // 20ms of 16-bit mono
    for (let off = 0; off < pcm.length; off += slice) {
      if (this.cancelled) return;
      const canContinue = this.io.write(pcm.subarray(off, Math.min(off + slice, pcm.length)));
      if (canContinue) {
        await new Promise<void>((r) => setImmediate(r));
      } else {
        // Back-pressure: wait for drain or a 100ms safety timeout (e.g. if quit() fires).
        await new Promise<void>((r) => {
          const tid = setTimeout(r, 100);
          this.io.once("drain", () => { clearTimeout(tid); r(); });
        });
      }
    }
  }

  /** Barge-in: stop feeding audio. PortAudio's small internal buffer drains. */
  stop(): void {
    this.cancelled = true;
  }

  close(): void {
    this.cancelled = true;
    this.io.quit();
  }
}
