// Splits a stream of token deltas into sentence-sized chunks so TTS can start
// speaking before the full LLM reply lands. Extracted from the old llm.ts loop.

// Lazily match up to the first sentence terminator, plus an optional closing
// quote/bracket, followed by whitespace.
const SENTENCE_BOUNDARY = /^[\s\S]*?[.!?…]+["')\]]?\s/;

export class SentenceChunker {
  private buf = "";

  // Feed one token; return any sentences it completed (possibly several).
  push(token: string): string[] {
    this.buf += token;
    const out: string[] = [];
    let match = this.buf.match(SENTENCE_BOUNDARY);
    while (match) {
      const sentence = match[0];
      if (!sentence) break;
      out.push(sentence.trim());
      this.buf = this.buf.slice(sentence.length);
      match = this.buf.match(SENTENCE_BOUNDARY);
    }
    return out;
  }

  // Remaining buffered text as a final sentence, or null if empty. Clears the buffer.
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? rest : null;
  }
}
