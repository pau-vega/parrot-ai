import type { EventEmitter } from "events";
import type { PipelineEvent } from "./types";

/**
 * The stable seam between the Node control/UI layer and whatever runs the
 * realtime voice pipeline.
 *
 * Today the only implementation is `PythonPipelineBackend` (spawns the Pipecat
 * child process). Phase 2 of the migration adds an in-process `NodePipelineBackend`
 * behind this same interface; `index.ts` selects one via the PIPELINE_BACKEND env
 * var. Both emit the identical `PipelineEvent` stream, so the frontend never changes.
 *
 * Emits: "event" with a `PipelineEvent` payload.
 */
export interface PipelineBackend extends EventEmitter {
  /** Boot the backend (spawn the child / init the in-process pipeline). */
  spawn(): void;
  /** Start a call bound to the two named audio devices. */
  sendStart(inputDevice: string, outputDevice: string): void;
  /** Cancel the running agent task (does NOT tear down the backend). */
  sendStop(): void;
  /** Update the system prompt (applies on the next start). */
  sendSetPrompt(text: string): void;
  /** Tear the backend down. Called only on server shutdown. */
  kill(): void;
  /** Whether the backend is currently alive. */
  isAlive(): boolean;
  // Typed event channel — both backends emit a single "event" with PipelineEvent.
  on(event: "event", listener: (e: PipelineEvent) => void): this;
}

export type PipelineBackendKind = "python" | "node";

/** Resolve the configured backend kind from the environment (default: python). */
export function backendKind(): PipelineBackendKind {
  return process.env.PIPELINE_BACKEND === "node" ? "node" : "python";
}
