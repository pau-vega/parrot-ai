import type { EventEmitter } from "events";
import type { PipelineEvent } from "./types";

/**
 * The seam between the Node control/UI layer and the realtime voice pipeline.
 * Implemented in-process by `NodePipelineBackend`. Emits "event" with a
 * `PipelineEvent` payload.
 */
export interface PipelineBackend extends EventEmitter {
  /** Boot the backend (init the in-process pipeline). */
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
  // Typed event channel — emits a single "event" with PipelineEvent.
  on(event: "event", listener: (e: PipelineEvent) => void): this;
}
