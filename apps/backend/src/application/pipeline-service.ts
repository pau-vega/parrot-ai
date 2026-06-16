import { EventEmitter } from "events"

import type { PipelineBackend, PipelineDependencies } from "../domain/ports.js"
import type { Session } from "../domain/types.js"
import type { PipelineEvent } from "../types.js"

import { DEFAULT_PROMPT } from "../config/config.js"
import { TurnEngine } from "../domain/turn-engine.js"

/**
 * Owns the pipeline lifecycle: builds a TurnEngine per start, forwards its
 * PipelineEvent stream, captures transcripts into a Session, and persists the
 * Session on stop. Emits the same `PipelineEvent` stream index.ts forwards to
 * the frontend unchanged.
 */
export class PipelineService extends EventEmitter implements PipelineBackend {
  private engine: TurnEngine | null = null
  private prompt = DEFAULT_PROMPT
  private alive = false
  private session: Session | null = null

  constructor(private deps: PipelineDependencies) {
    super()
  }

  spawn(): void {
    this.alive = true
    // `init` event: enumerate devices + advertise the prompt.
    try {
      this.emit("event", {
        type: "init",
        prompt: this.prompt,
        devices: { input: this.deps.deviceNames("input"), output: this.deps.deviceNames("output") },
      } satisfies PipelineEvent)
    } catch (err) {
      this.emit("event", { type: "error", message: String((err as Error)?.message ?? err) } satisfies PipelineEvent)
    }
    this.emit("event", { type: "running", value: false } satisfies PipelineEvent)
  }

  sendStart(inputDevice: string, outputDevice: string): void {
    if (this.engine) return // already running
    this.session = { startedAt: new Date().toISOString(), entries: [] }
    let engine: TurnEngine
    try {
      engine = new TurnEngine(this.deps, { prompt: this.prompt, inputDevice, outputDevice })
    } catch (err) {
      this.emit("event", { type: "error", message: String((err as Error)?.message ?? err) } satisfies PipelineEvent)
      this.session = null
      return
    }
    engine.on("event", (e: PipelineEvent) => {
      if (e.type === "transcript") {
        this.session?.entries.push({ role: e.role, text: e.text, ts: new Date().toISOString() })
      }
      this.emit("event", e)
    })
    this.engine = engine
    engine.start().catch((err) => {
      this.emit("event", { type: "error", message: String((err as Error)?.message ?? err) } satisfies PipelineEvent)
      this.engine = null
    })
  }

  sendStop(): void {
    const engine = this.engine
    this.engine = null
    const session = this.session
    this.session = null
    if (!engine) return
    engine.removeAllListeners("event")
    engine.stop().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.emit("event", { type: "error", message } satisfies PipelineEvent)
    })
    if (session && session.entries.length > 0) {
      this.deps.transcripts.save(session).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.emit("event", { type: "error", message } satisfies PipelineEvent)
      })
    }
  }

  sendSetPrompt(text: string): void {
    this.prompt = text // applies on the next start
  }

  kill(): void {
    this.alive = false
    this.sendStop()
  }

  isAlive(): boolean {
    return this.alive
  }
}
