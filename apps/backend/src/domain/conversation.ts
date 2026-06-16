import type { ChatMessage } from "./types";

// Conversation history aggregate: owns the message list the LLM port is fed.
// Extracted from the old llm.ts so history is domain state, not adapter state.
export class Conversation {
  private history: ChatMessage[] = [];

  constructor(private systemPrompt: string) {
    this.reset();
  }

  reset(): void {
    this.history = [{ role: "system", content: this.systemPrompt }];
  }

  addUser(text: string): void {
    this.history.push({ role: "user", content: text });
  }

  addAssistant(text: string): void {
    this.history.push({ role: "assistant", content: text });
  }

  messages(): readonly ChatMessage[] {
    return [...this.history];
  }
}
