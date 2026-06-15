import OpenAI from "openai";
import { LLM_BASE_URL, LLM_MODEL, LLM_MAX_TOKENS } from "../config";

/**
 * DeepSeek (OpenAI-compatible) streaming chat. Mirrors the Python config:
 * deepseek-chat, max_tokens=160. Streams tokens and yields complete sentences as
 * soon as they form, so TTS can start speaking before the full reply lands.
 */
export class LLMClient {
  private client: OpenAI;
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  constructor(private systemPrompt: string) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");
    this.client = new OpenAI({ apiKey, baseURL: LLM_BASE_URL });
    this.reset();
  }

  reset(): void {
    this.history = [{ role: "system", content: this.systemPrompt }];
  }

  /**
   * Stream a reply to `userText`, yielding sentence-sized chunks. `signal`
   * aborts the request on barge-in. The full reply is appended to history.
   */
  async *respond(userText: string, signal: AbortSignal): AsyncGenerator<string> {
    this.history.push({ role: "user", content: userText });
    const stream = await this.client.chat.completions.create(
      {
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        messages: this.history,
        stream: true,
      },
      { signal },
    );

    let full = "";
    let buf = "";
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content ?? "";
      if (!delta) continue;
      full += delta;
      buf += delta;
      // Flush on sentence boundaries so speech can begin mid-reply.
      const match = buf.match(/^[\s\S]*?[.!?…]+["')\]]?\s/);
      if (match) {
        yield match[0].trim();
        buf = buf.slice(match[0].length);
      }
    }
    if (buf.trim()) yield buf.trim();
    if (full.trim()) this.history.push({ role: "assistant", content: full.trim() });
  }
}
