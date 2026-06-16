import { EventEmitter } from "events"

import type { AgentState, PipelineEvent } from "../types.js"
import type {
  AudioInputPort,
  AudioOutputPort,
  LlmPort,
  PipelineDependencies,
  SttPort,
  TtsPort,
  VadPort,
} from "./ports.js"
import type { AgentConfig } from "./types.js"

import { Conversation } from "./conversation.js"
import { SentenceChunker } from "./sentence-chunker.js"
import { TurnDetector } from "./turn-detector.js"

const STT_SAMPLE_RATE = 16000 // Whisper/VAD native rate; audio frames arrive at this rate
const PREROLL_FRAMES = 10 // ~0.32s kept before speech start (VAD reacts slightly late)
const MIN_UTTERANCE_SAMPLES = STT_SAMPLE_RATE * 0.3 // ignore <0.3s blips
const MAX_FRAME_QUEUE = 8 // drop frames beyond this depth to bound memory under load

/**
 * In-process realtime turn engine: VAD → STT → LLM → TTS → playback, with
 * barge-in. Emits a PipelineEvent stream consumed by the frontend.
 *
 * It depends only on ports (PipelineDependencies); concrete adapters are wired
 * in the composition root. Audio never leaves this process except the stateless
 * TTS synth call, so the VAD that triggers barge-in and the output it stops live
 * together — no cross-process hop on the interrupt path.
 */
export class TurnEngine extends EventEmitter {
  private vad: VadPort
  private stt: SttPort
  private tts: TtsPort
  private llm: LlmPort
  private detector = new TurnDetector()
  private conversation: Conversation
  private input?: AudioInputPort
  private output?: AudioOutputPort

  private mode: AgentState = "listening"
  private userAudio: number[] = []
  private preRoll: Float32Array[] = []
  private abort?: AbortController
  private frameChain: Promise<void> = Promise.resolve()
  private frameQueueDepth = 0
  private tUserStopped = 0
  // Monotonic turn counter: handleTurn checks this to detect stale turns.
  private turnId = 0

  constructor(
    private deps: PipelineDependencies,
    private config: AgentConfig,
  ) {
    super()
    this.vad = deps.createVad()
    this.stt = deps.createStt()
    this.tts = deps.createTts()
    this.llm = deps.createLlm()
    this.conversation = new Conversation(config.prompt)
  }

  private emitEvent(e: PipelineEvent): void {
    this.emit("event", e)
  }
  private setState(value: AgentState): void {
    this.emitEvent({ type: "state", value })
  }

  async start(): Promise<void> {
    await this.vad.load()
    await this.stt.load()
    await this.tts.load()
    this.conversation.reset()
    this.detector.reset()

    this.output = this.deps.createAudioOutput(this.config.outputDevice, this.tts.sampleRate)
    this.input = this.deps.createAudioInput(this.config.inputDevice)
    this.input.onFrame((frame: Float32Array) => {
      if (this.frameQueueDepth >= MAX_FRAME_QUEUE) return
      this.frameQueueDepth++
      this.frameChain = this.frameChain
        .then(() => this.onFrame(frame))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.emitEvent({ type: "error", message })
        })
        .finally(() => {
          this.frameQueueDepth--
        })
    })
    this.input.start()
    this.emitEvent({ type: "running", value: true })
    this.setState("listening")
  }

  private async onFrame(frame: Float32Array): Promise<void> {
    const prob = await this.vad.process(frame)
    const { started, ended } = this.detector.observe(prob)

    // pre-roll ring buffer (only matters before a turn begins)
    this.preRoll.push(frame)
    if (this.preRoll.length > PREROLL_FRAMES) this.preRoll.shift()

    if (started) {
      if (this.mode === "speaking" || this.mode === "thinking") this.bargeIn()
      this.mode = "listening"
      this.userAudio = []
      for (const f of this.preRoll) this.userAudio.push(...f)
      this.setState("listening")
    }

    if (this.detector.isSpeaking && this.mode === "listening") {
      this.userAudio.push(...frame)
    }

    if (ended && this.mode === "listening" && this.userAudio.length >= MIN_UTTERANCE_SAMPLES) {
      this.tUserStopped = Date.now()
      const audio = Float32Array.from(this.userAudio)
      this.userAudio = []
      const thisTurnId = ++this.turnId
      void this.handleTurn(audio, thisTurnId)
    }
  }

  /** Barge-in: abort the in-flight reply and silence the output immediately. */
  private bargeIn(): void {
    this.abort?.abort()
    this.output?.stop()
  }

  private async handleTurn(audio: Float32Array, turnId: number): Promise<void> {
    if (turnId !== this.turnId) return
    this.mode = "thinking"
    this.setState("thinking")
    // Set abort early so bargeIn() can interrupt STT if needed.
    this.abort = new AbortController()
    const signal = this.abort.signal
    let rawFull = "" // raw token stream → conversation history (faithful to the model)
    let spoken = "" // sentence-joined → transcript event shown to the user

    try {
      const text = await this.stt.transcribe(audio)
      if (!text || signal.aborted) {
        if (turnId === this.turnId) {
          this.mode = "listening"
          this.setState("listening")
        }
        return
      }
      this.emitEvent({ type: "transcript", role: "user", text })
      this.conversation.addUser(text)

      this.mode = "speaking"
      let firstAudio = true
      const chunker = new SentenceChunker()

      // Synthesize + play one sentence; returns false if interrupted.
      const speak = async (sentence: string): Promise<boolean> => {
        if (signal.aborted) return false
        spoken += (spoken ? " " : "") + sentence
        const { pcm } = await this.tts.synth(sentence)
        if (signal.aborted) return false
        if (firstAudio) {
          firstAudio = false
          this.setState("speaking")
          this.emitEvent({ type: "latency", ms: Date.now() - this.tUserStopped })
        }
        // Capture output ref before await so a concurrent close() doesn't race.
        const output = this.output
        if (output) await output.play(pcm)
        return true
      }

      let interrupted = false
      for await (const token of this.llm.stream(this.conversation.messages(), signal)) {
        if (signal.aborted) {
          interrupted = true
          break
        }
        rawFull += token
        for (const sentence of chunker.push(token)) {
          if (!(await speak(sentence))) {
            interrupted = true
            break
          }
        }
        if (interrupted) break
      }
      if (!interrupted && !signal.aborted) {
        const tail = chunker.flush()
        if (tail) await speak(tail)
      }
    } catch (err: unknown) {
      if (!signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        this.emitEvent({ type: "error", message })
      }
    }

    if (!signal.aborted) {
      if (spoken.trim()) this.emitEvent({ type: "transcript", role: "assistant", text: spoken.trim() })
      if (rawFull.trim()) {
        this.conversation.addAssistant(rawFull.trim())
      } else {
        console.error("TurnEngine: empty response from stream; conversation history not updated")
      }
    }
    // Only reset mode if this turn is still the current one and it owns "speaking".
    if (this.mode === "speaking" && turnId === this.turnId) {
      this.mode = "listening"
      this.setState("listening")
    }
  }

  async stop(): Promise<void> {
    this.bargeIn()
    this.input?.stop()
    this.output?.close()
    await this.stt.free()
    this.emitEvent({ type: "running", value: false })
    this.setState("idle")
  }
}
