import { EventEmitter } from "events";
import type { PipelineEvent } from "../types";
import { AudioInput, AudioOutput, STT_SAMPLE_RATE } from "./audio";
import { SileroVAD } from "./vad";
import { WhisperSTT } from "./stt";
import { LLMClient } from "./llm";
import { PiperTTS } from "./tts";

const PREROLL_FRAMES = 10; // ~0.32s kept before speech start (VAD reacts slightly late)
const MIN_UTTERANCE_SAMPLES = STT_SAMPLE_RATE * 0.3; // ignore <0.3s blips

/**
 * In-process realtime turn engine: VAD → STT → LLM → TTS → playback, with
 * barge-in. Replaces the Pipecat pipeline. Emits the same PipelineEvent stream
 * the Python backend produced, so the frontend is unchanged.
 *
 * Audio never leaves this process except the stateless TTS synth call, so the
 * VAD that triggers barge-in and the output it stops live together — no
 * cross-process hop on the interrupt path.
 */
export class Orchestrator extends EventEmitter {
  private vad = new SileroVAD();
  private stt = new WhisperSTT();
  private tts = new PiperTTS();
  private llm: LLMClient;
  private input?: AudioInput;
  private output?: AudioOutput;

  private mode: "listening" | "thinking" | "speaking" = "listening";
  private userAudio: number[] = [];
  private preRoll: Float32Array[] = [];
  private abort?: AbortController;
  private frameChain: Promise<void> = Promise.resolve();
  private tUserStopped = 0;

  constructor(
    private prompt: string,
    private inputDevice: string,
    private outputDevice: string,
  ) {
    super();
    this.llm = new LLMClient(prompt);
  }

  private emitEvent(e: PipelineEvent): void {
    this.emit("event", e);
  }
  private setState(value: "idle" | "listening" | "thinking" | "speaking"): void {
    this.emitEvent({ type: "state", value });
  }

  async start(): Promise<void> {
    await this.vad.load();
    await this.stt.load();
    await this.tts.load();
    this.llm.reset();

    this.output = new AudioOutput(this.outputDevice, this.tts.sampleRate);
    this.input = new AudioInput(this.inputDevice);
    this.input.on("frame", (frame: Float32Array) => {
      // Serialize frame handling so VAD state stays consistent under async work.
      this.frameChain = this.frameChain.then(() => this.onFrame(frame)).catch((err) => {
        this.emitEvent({ type: "error", message: String(err?.message ?? err) });
      });
    });
    this.input.start();
    this.emitEvent({ type: "running", value: true });
    this.setState("listening");
  }

  private async onFrame(frame: Float32Array): Promise<void> {
    const { started, ended } = await this.vad.process(frame);

    // pre-roll ring buffer (only matters before a turn begins)
    this.preRoll.push(frame);
    if (this.preRoll.length > PREROLL_FRAMES) this.preRoll.shift();

    if (started) {
      if (this.mode === "speaking" || this.mode === "thinking") this.bargeIn();
      this.mode = "listening";
      this.userAudio = [];
      for (const f of this.preRoll) this.userAudio.push(...f);
      this.setState("listening");
    }

    if (this.vad.speaking && this.mode === "listening") {
      this.userAudio.push(...frame);
    }

    if (ended && this.mode === "listening" && this.userAudio.length >= MIN_UTTERANCE_SAMPLES) {
      this.tUserStopped = Date.now();
      const audio = Float32Array.from(this.userAudio);
      this.userAudio = [];
      void this.handleTurn(audio);
    }
  }

  /** Barge-in: abort the in-flight reply and silence the output immediately. */
  private bargeIn(): void {
    this.abort?.abort();
    this.output?.stop();
  }

  private async handleTurn(audio: Float32Array): Promise<void> {
    this.mode = "thinking";
    this.setState("thinking");

    const text = await this.stt.transcribe(audio);
    if (!text) {
      this.mode = "listening";
      this.setState("listening");
      return;
    }
    this.emitEvent({ type: "transcript", role: "user", text });

    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.mode = "speaking";
    let firstAudio = true;
    let full = "";

    try {
      for await (const sentence of this.llm.respond(text, signal)) {
        if (signal.aborted) break;
        full += (full ? " " : "") + sentence;
        const { pcm } = await this.tts.synth(sentence);
        if (signal.aborted) break;
        if (firstAudio) {
          firstAudio = false;
          this.setState("speaking");
          this.emitEvent({ type: "latency", ms: Date.now() - this.tUserStopped });
        }
        await this.output!.play(pcm);
      }
    } catch (err) {
      if (!signal.aborted) this.emitEvent({ type: "error", message: String((err as Error)?.message ?? err) });
    }

    if (full.trim() && !signal.aborted) {
      this.emitEvent({ type: "transcript", role: "assistant", text: full.trim() });
    }
    if (this.mode === "speaking") {
      this.mode = "listening";
      this.setState("listening");
    }
  }

  async stop(): Promise<void> {
    this.bargeIn();
    this.input?.stop();
    this.output?.close();
    await this.stt.free();
    this.tts.kill();
    this.emitEvent({ type: "running", value: false });
    this.setState("idle");
  }
}
