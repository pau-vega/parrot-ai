import { resolve } from "path";
import { buildPipeline } from "./config/composition-root";
import { startWsServer } from "./adapters/http/ws-server";
import { DEFAULT_INPUT_DEVICE, DEFAULT_OUTPUT_DEVICE } from "./config/config";

// Load .env from the repo root so the in-process pipeline picks up keys
// (e.g. DEEPSEEK_API_KEY) via process.env. Optional: skipped if no file exists.
const ENV_FILE = resolve(__dirname, "../../../.env");
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // no .env file — rely on the ambient environment instead
}

const parsedPort = parseInt(process.env.PORT ?? "8000", 10);
const PORT = Number.isNaN(parsedPort) ? 8000 : parsedPort;
const FRONTEND_DIR = resolve(__dirname, "../../frontend");

const pipeline = buildPipeline();
const wsServer = startWsServer(pipeline, {
  port: PORT,
  frontendDir: FRONTEND_DIR,
  defaultInputDevice: DEFAULT_INPUT_DEVICE,
  defaultOutputDevice: DEFAULT_OUTPUT_DEVICE,
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  pipeline.kill();
  wsServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
