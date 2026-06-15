import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../");

/**
 * Single source of truth for the non-realtime pipeline config.
 *
 * The realtime path (STT → VAD → LLM → TTS → audio) still lives in Python for
 * now (see the migration plan), but the values that parameterize it — and the
 * persona prompt — are owned here. Node passes them to the Python child as env
 * vars on spawn (see PythonPipelineBackend), so there is one place to edit them.
 *
 * The persona prompt lives in `prompts/default-es.txt` so both this file and the
 * standalone Python `agent.py` read the SAME text (no duplicate-prompt drift).
 */

// Persona prompt: Spanish on purpose (Whisper language=ES + es_ES Piper voice).
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

/**
 * Env vars passed down to the Python child so it reads config from here rather
 * than hardcoding it. Keys mirror what `python/shared.py` reads with these as
 * defaults, so a directly-launched `agent.py` still works without Node.
 */
export function pythonEnv(): Record<string, string> {
  return {
    PARROT_PROMPT: DEFAULT_PROMPT,
    WHISPER_MODEL,
    WHISPER_COMPUTE,
    PIPER_VOICE,
    LLM_BASE_URL,
    LLM_MODEL,
    LLM_MAX_TOKENS: String(LLM_MAX_TOKENS),
    PARROT_INPUT_DEVICE: DEFAULT_INPUT_DEVICE,
    PARROT_OUTPUT_DEVICE: DEFAULT_OUTPUT_DEVICE,
  };
}
