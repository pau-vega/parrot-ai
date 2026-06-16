// Domain value objects. No external/library types here — the wire protocol lives
// in src/types.ts; LLM/SDK shapes live in the adapters.

// What a session needs to run a turn engine.
export interface AgentConfig {
  prompt: string;
  inputDevice: string;
  outputDevice: string;
}

// A chat message in the conversation, kept lib-agnostic. Adapters map this to
// their SDK's message type at the boundary.
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// One persisted transcript line.
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

// A full conversation captured during one start→stop cycle.
export interface Session {
  startedAt: string;
  entries: TranscriptEntry[];
}
