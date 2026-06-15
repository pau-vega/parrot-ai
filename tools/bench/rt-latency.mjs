#!/usr/bin/env node
/**
 * Phase 1c — realtime round-trip latency benchmark (the Phase 2 GATE).
 *
 * Measures the candidate full-Node stack on THIS Mac, end to end:
 *
 *   naudiodon capture → smart-whisper (whisper.cpp, Metal) → DeepSeek stream
 *   → Piper binary → naudiodon playback
 *
 * and reports the same metric the Python pipeline emits today:
 * `UserStoppedSpeaking → BotStartedSpeaking` in ms (median over N turns).
 *
 * GATE: Phase 2 (the real port) proceeds only if the median here is ≤ the
 * current Python baseline. Read the Python baseline from the live
 * `{type:"latency"}` events in the running app before trusting this number.
 *
 * This script is intentionally NOT wired into the app or the workspace. It pulls
 * heavy native deps (naudiodon, smart-whisper) and downloads models, so it is
 * run by hand once, as a go/no-go check — not on every build.
 *
 * ── Setup (run once, from repo root) ─────────────────────────────────────────
 *   # native audio + whisper.cpp bindings (PortAudio is bundled with naudiodon)
 *   pnpm --dir tools/bench add naudiodon smart-whisper openai
 *   # whisper model (base, matches Python config) — see smart-whisper docs
 *   # piper binary + es_ES-davefx-medium voice (reuse python/*.onnx)
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   export DEEPSEEK_API_KEY=...
 *   node tools/bench/rt-latency.mjs --turns 10
 *
 * Speak a short Spanish phrase after each "listening…" prompt; the script prints
 * per-turn latency and the final median.
 */

const TURNS = parseInt(argFlag("--turns", "10"), 10);
const INPUT_DEVICE = process.env.PARROT_INPUT_DEVICE ?? "BlackHole 2ch";
const OUTPUT_DEVICE = process.env.PARROT_OUTPUT_DEVICE ?? "BlackHole 16ch";

function argFlag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Lazy, friendly dependency loading: this script is meant to be run standalone
// after the one-time setup above, so a missing dep should explain itself rather
// than throw a raw MODULE_NOT_FOUND.
async function loadDeps() {
  const missing = [];
  let naudiodon, SmartWhisper, OpenAI;
  try { naudiodon = (await import("naudiodon")).default; } catch { missing.push("naudiodon"); }
  try { SmartWhisper = (await import("smart-whisper")).Whisper; } catch { missing.push("smart-whisper"); }
  try { OpenAI = (await import("openai")).default; } catch { missing.push("openai"); }
  if (!process.env.DEEPSEEK_API_KEY) missing.push("env DEEPSEEK_API_KEY");
  if (missing.length) {
    console.error("rt-latency: missing prerequisites:\n  - " + missing.join("\n  - "));
    console.error("\nSee the setup block at the top of tools/bench/rt-latency.mjs.");
    process.exit(2);
  }
  return { naudiodon, SmartWhisper, OpenAI };
}

async function main() {
  const { naudiodon } = await loadDeps();

  // Sanity: confirm both BlackHole devices resolve by substring (same pairing
  // rule as python/shared.py device_index) before measuring anything.
  const devices = naudiodon.getDevices();
  const find = (name, kind) =>
    devices.find(
      (d) =>
        d.name.toLowerCase().includes(name.toLowerCase()) &&
        (kind === "input" ? d.maxInputChannels : d.maxOutputChannels) > 0,
    );
  const inDev = find(INPUT_DEVICE, "input");
  const outDev = find(OUTPUT_DEVICE, "output");
  if (!inDev || !outDev) {
    console.error(
      `rt-latency: device not found (in="${INPUT_DEVICE}" -> ${inDev?.name ?? "MISSING"}, ` +
        `out="${OUTPUT_DEVICE}" -> ${outDev?.name ?? "MISSING"}).`,
    );
    process.exit(2);
  }
  console.error(`devices ok: in=${inDev.name} out=${outDev.name}`);

  // NOTE: the per-turn capture→STT→LLM→TTS→playback loop is implemented as the
  // first task of Phase 2 (apps/backend/src/rt/*). This harness imports those
  // modules once they exist; until then it validates deps + devices only.
  console.error(
    `\nrt-latency scaffold ready. Per-turn measurement lands with the Phase 2 rt/ modules.\n` +
      `Planned: ${TURNS} turns, report median(UserStoppedSpeaking → BotStartedSpeaking) ms.`,
  );
  void median; // used once the measurement loop is wired in
}

main().catch((err) => {
  console.error("rt-latency: fatal:", err?.message ?? err);
  process.exit(1);
});
