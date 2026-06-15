import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../");

/**
 * Single source of truth for the pipeline config: the persona prompt plus the
 * model/voice/LLM/device defaults the rt/ modules and the server read.
 *
 * The persona prompt lives in `prompts/default-es.txt` so it's editable in one
 * place and not duplicated in code.
 */

// Persona prompt: Spanish on purpose (Whisper language=es + es_ES Piper voice).
export const DEFAULT_PROMPT = readFileSync(
  resolve(REPO_ROOT, "prompts/default-es.txt"),
  "utf8",
).trim();

// Default device names. Two distinct BlackHole devices keep the two call
// directions separate, so there is no echo (see CLAUDE.md).
export const DEFAULT_INPUT_DEVICE = "BlackHole 2ch"; // Aircall's output lands here (agent HEARS)
export const DEFAULT_OUTPUT_DEVICE = "BlackHole 16ch"; // routed to Aircall's mic (agent SPEAKS)

// STT (faster-whisper): base+int8 = faster than small on Mac CPU; small if accuracy lacking.
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "base";
export const WHISPER_COMPUTE = process.env.WHISPER_COMPUTE ?? "int8";

// TTS (Piper): auto-downloaded on first use, cached in python/.
export const PIPER_VOICE = process.env.PIPER_VOICE ?? "es_ES-davefx-medium";

// LLM (DeepSeek, OpenAI-compatible). Use deepseek-chat; NEVER the reasoner (R1).
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
export const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS ?? "160", 10); // short voice replies
