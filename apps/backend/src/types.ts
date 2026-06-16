// Agent lifecycle state, shared by pipeline events and server messages.
export type AgentState = "idle" | "listening" | "thinking" | "speaking";

// Device lists exposed to the browser / emitted by the pipeline.
export interface DeviceList {
  input: string[];
  output: string[];
}

// Configuration snapshot sent to the browser on connect.
export interface HelloConfig {
  prompt: string;
  input_device: string;
  output_device: string;
  llm: string;
  stt: string;
  tts: string;
}

// Messages from browser → Node server
export type BrowserMessage =
  | { type: "start"; input_device: string; output_device: string }
  | { type: "stop" }
  | { type: "set_prompt"; text: string };

// Events shared between the pipeline and the browser (single source avoids drift).
type PipelineServerEvent =
  | { type: "state"; value: AgentState }
  | { type: "transcript"; role: "user" | "assistant"; text: string; ts?: string }
  | { type: "latency"; ms: number }
  | { type: "running"; value: boolean }
  | { type: "error"; message: string };

// Messages from Node server → browser
export type ServerMessage =
  | { type: "hello"; running: boolean; devices: DeviceList; config: HelloConfig }
  | PipelineServerEvent;

// Events from the pipeline → Node (NodePipelineBackend emits these).
// Defined as {init} | PipelineServerEvent so the two types stay in sync:
// any new non-init pipeline event must also be a valid ServerMessage.
export type PipelineEvent =
  | { type: "init"; prompt: string; devices: DeviceList }
  | PipelineServerEvent;

// Narrowing guard for JSON parsed off a browser WebSocket message.
// Validates required fields for each variant, not just the discriminant.
export function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const v = value as Record<string, unknown>;
  switch (v["type"]) {
    case "start":
      return typeof v["input_device"] === "string" && typeof v["output_device"] === "string";
    case "stop":
      return true;
    case "set_prompt":
      return typeof v["text"] === "string";
    default:
      return false;
  }
}
