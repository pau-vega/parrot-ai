import OpenAI from "openai";
import { LLM_BASE_URL, LLM_MODEL, LLM_MAX_TOKENS } from "../../config/config";
import type { ChatMessage } from "../../domain/types";
import type { LlmPort } from "../../domain/ports";

/**
 * DeepSeek (OpenAI-compatible) streaming chat. Stateless: yields raw token deltas.
 * History (Conversation) and sentence chunking (SentenceChunker) live in the domain.
 */
export class DeepSeekLLM implements LlmPort {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");
    this.client = new OpenAI({ apiKey, baseURL: LLM_BASE_URL });
  }

  async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
      },
      { signal },
    );
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content ?? "";
      if (delta) yield delta;
    }
  }
}
