import { EventEmitter } from "events";
import type { PipelineEvent } from "./types";
import { DEFAULT_PROMPT } from "./config";
import { deviceNames } from "./rt/audio";
import { Orchestrator } from "./rt/orchestrator";

/**
 * The full Node realtime pipeline. Emits a `PipelineEvent` stream that index.ts
 * forwards to the frontend unchanged.
 */
export class NodePipelineBackend extends EventEmitter {
  private orch: Orchestrator | null = null;
  private prompt = DEFAULT_PROMPT;
  private alive = false;

  spawn(): void {
    this.alive = true;
    // `init` event: enumerate devices + advertise the prompt.
    try {
      this.emit("event", {
        type: "init",
        prompt: this.prompt,
        devices: { input: deviceNames("input"), output: deviceNames("output") },
      } satisfies PipelineEvent);
    } catch (err) {
      this.emit("event", { type: "error", message: String((err as Error)?.message ?? err) } satisfies PipelineEvent);
    }
    this.emit("event", { type: "running", value: false } satisfies PipelineEvent);
  }

  sendStart(inputDevice: string, outputDevice: string): void {
    if (this.orch) return; // already running
    const orch = new Orchestrator(this.prompt, inputDevice, outputDevice);
    orch.on("event", (e: PipelineEvent) => this.emit("event", e));
    this.orch = orch;
    orch.start().catch((err) => {
      this.emit("event", { type: "error", message: String((err as Error)?.message ?? err) } satisfies PipelineEvent);
      this.orch = null;
    });
  }

  sendStop(): void {
    const orch = this.orch;
    this.orch = null;
    if (!orch) return;
    orch.removeAllListeners("event");
    orch.stop().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("event", { type: "error", message } satisfies PipelineEvent);
    });
  }

  sendSetPrompt(text: string): void {
    this.prompt = text; // applies on the next start
  }

  kill(): void {
    this.alive = false;
    this.sendStop();
  }

  isAlive(): boolean {
    return this.alive;
  }
}
