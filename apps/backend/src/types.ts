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

// Messages from Node server → browser (unchanged from original protocol)
export type ServerMessage =
  | { type: "hello"; running: boolean; devices: DeviceList; config: HelloConfig }
  | { type: "state"; value: AgentState }
  | { type: "transcript"; role: "user" | "assistant"; text: string; ts?: string }
  | { type: "latency"; ms: number }
  | { type: "running"; value: boolean }
  | { type: "error"; message: string };

// Events from Python pipeline → Node (stdout JSON lines)
export type PipelineEvent =
  | { type: "init"; prompt: string; devices: DeviceList }
  | { type: "state"; value: AgentState }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "latency"; ms: number }
  | { type: "running"; value: boolean }
  | { type: "error"; message: string };

// Commands from Node → Python pipeline (stdin JSON lines)
export type PipelineCommand =
  | { type: "start"; input_device: string; output_device: string }
  | { type: "stop" }
  | { type: "set_prompt"; text: string };

// Known PipelineEvent discriminants — used to validate untrusted stdout JSON.
const PIPELINE_EVENT_TYPES = new Set<PipelineEvent["type"]>([
  "init",
  "state",
  "transcript",
  "latency",
  "running",
  "error",
]);

// Narrowing guard for JSON parsed off the Python stdout IPC channel.
export function isPipelineEvent(value: unknown): value is PipelineEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    PIPELINE_EVENT_TYPES.has((value as { type: PipelineEvent["type"] }).type)
  );
}

// Known BrowserMessage discriminants — used to validate untrusted WS JSON.
const BROWSER_MESSAGE_TYPES = new Set<BrowserMessage["type"]>(["start", "stop", "set_prompt"]);

// Narrowing guard for JSON parsed off a browser WebSocket message.
export function isBrowserMessage(value: unknown): value is BrowserMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    BROWSER_MESSAGE_TYPES.has((value as { type: BrowserMessage["type"] }).type)
  );
}
