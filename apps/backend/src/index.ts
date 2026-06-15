import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { resolve } from "path";
import { PythonPipelineBackend } from "./pipeline";
import { NodePipelineBackend } from "./node-backend";
import { backendKind } from "./backend";
import type { PipelineBackend } from "./backend";
import { DEFAULT_INPUT_DEVICE, DEFAULT_OUTPUT_DEVICE, LLM_MODEL } from "./config";
import type { ServerMessage, PipelineEvent } from "./types";
import { isBrowserMessage } from "./types";

// Load .env from the repo root so the spawned Python pipeline inherits keys
// (e.g. DEEPSEEK_API_KEY) via process.env. Optional: skipped if no file exists.
const ENV_FILE = resolve(__dirname, "../../../.env");
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // no .env file — rely on the ambient environment instead
}

const PORT = parseInt(process.env.PORT ?? "8000", 10);
const FRONTEND_DIR = resolve(__dirname, "../../frontend");
const HEARTBEAT_MS = 30_000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.static(FRONTEND_DIR));

// --- pipeline process -------------------------------------------------------

function createBackend(): PipelineBackend {
  // Full in-process Node pipeline (Phase 2) vs the Python child process.
  return backendKind() === "node" ? new NodePipelineBackend() : new PythonPipelineBackend();
}

const pipeline = createBackend();

const cachedDevices: { input: string[]; output: string[] } = { input: [], output: [] };
let cachedPrompt = "";
let isRunning = false;
const agentState = {
  input_device: DEFAULT_INPUT_DEVICE,
  output_device: DEFAULT_OUTPUT_DEVICE,
};

pipeline.on("event", (event: PipelineEvent) => {
  if (event.type === "init") {
    cachedDevices.input = event.devices.input;
    cachedDevices.output = event.devices.output;
    cachedPrompt = event.prompt;
    return;
  }
  if (event.type === "running") {
    isRunning = event.value;
  }
  // `event` is narrowed to exclude "init" above; the remaining variants are
  // all structurally valid ServerMessage members, so no cast is needed.
  broadcast(event);
});

// --- WebSocket --------------------------------------------------------------

// Heartbeat liveness, tracked off-socket so no cast/monkey-patch is needed.
const aliveSockets = new WeakMap<WebSocket, boolean>();

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

wss.on("connection", (ws: WebSocket) => {
  aliveSockets.set(ws, true);
  ws.on("error", console.error);
  ws.on("pong", () => {
    aliveSockets.set(ws, true);
  });

  const hello: ServerMessage = {
    type: "hello",
    running: isRunning,
    devices: { ...cachedDevices },
    config: {
      prompt: cachedPrompt,
      input_device: agentState.input_device,
      output_device: agentState.output_device,
      llm: LLM_MODEL,
      stt: "whisper · es",
      tts: "piper",
    },
  };
  ws.send(JSON.stringify(hello));

  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isBrowserMessage(parsed)) return;
    const cmd = parsed;

    switch (cmd.type) {
      case "start":
        agentState.input_device = cmd.input_device || agentState.input_device;
        agentState.output_device = cmd.output_device || agentState.output_device;
        pipeline.sendStart(agentState.input_device, agentState.output_device);
        break;
      case "stop":
        pipeline.sendStop();
        break;
      case "set_prompt":
        cachedPrompt = cmd.text;
        pipeline.sendSetPrompt(cmd.text);
        break;
    }
  });
});

// Heartbeat: terminate connections that stop responding to pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (aliveSockets.get(ws) === false) {
      ws.terminate();
      continue;
    }
    aliveSockets.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

// --- boot + graceful shutdown -----------------------------------------------

pipeline.spawn();

server.listen(PORT, "127.0.0.1", () => {
  console.error(`Parrot AI listening on http://127.0.0.1:${PORT}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  pipeline.kill();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
