import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../../");

// Single source of truth for the pipeline config: persona prompt + model/voice/LLM/device defaults.

// Persona prompt lives in prompts/default-es.txt; Spanish on purpose (Whisper language=es + es_ES Piper voice).
export const DEFAULT_PROMPT = readFileSync(
  resolve(REPO_ROOT, "prompts/default-es.txt"),
  "utf8",
).trim();

// Default device names. Two distinct BlackHole devices keep the two call
// directions separate, so there is no echo (see CLAUDE.md).
export const DEFAULT_INPUT_DEVICE = "BlackHole 2ch"; // Aircall's output lands here (agent HEARS)
export const DEFAULT_OUTPUT_DEVICE = "BlackHole 16ch"; // routed to Aircall's mic (agent SPEAKS)

// STT (smart-whisper / whisper.cpp): base model, Metal GPU on Mac.
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "base";

// TTS (Piper, pure Node): WASM phonemizer + onnxruntime-node VITS inference.
export const PIPER_VOICE = process.env.PIPER_VOICE ?? "es_ES-davefx-medium";

// LLM (DeepSeek, OpenAI-compatible). Use deepseek-chat; NEVER the reasoner (R1).
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
const parsedMaxTokens = parseInt(process.env.LLM_MAX_TOKENS ?? "160", 10);
export const LLM_MAX_TOKENS = Number.isNaN(parsedMaxTokens) ? 160 : parsedMaxTokens; // short voice replies
