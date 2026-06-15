import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { resolve } from "path";
import type { PipelineCommand, PipelineEvent } from "./types";
import { isPipelineEvent } from "./types";

const REPO_ROOT = resolve(__dirname, "../../../");
const PYTHON_BIN = resolve(REPO_ROOT, ".venv/bin/python");
const PIPELINE_SCRIPT = resolve(REPO_ROOT, "python/pipeline.py");

/**
 * Manages the long-lived Python pipeline child process.
 *
 * The Python process is a persistent IPC server: it boots once, emits `init`
 * (devices + default prompt), then loops on stdin waiting for commands. It is
 * NOT killed on "stop" — only the in-process agent task is cancelled. The
 * process is killed only on backend shutdown (`kill`).
 */
const MIN_HEALTHY_MS = 5_000; // an exit sooner than this counts as a crash-loop failure
const MAX_RESTARTS = 5; // give up after this many consecutive fast crashes

export class PipelineProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private shuttingDown = false;
  private restarts = 0;
  private startedAt = 0;

  spawn(): void {
    this.startedAt = Date.now();
    this.proc = spawn(PYTHON_BIN, [PIPELINE_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "inherit"], // stderr inherited: Python logs stay off the IPC channel
      env: { ...process.env },
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // non-JSON stdout line — ignore
        return;
      }
      if (isPipelineEvent(parsed)) {
        this.emit("event", parsed);
      } else {
        console.error("[pipeline] dropping unrecognized stdout JSON:", trimmed);
      }
    });

    this.proc.on("error", (err) => {
      console.error("[pipeline] spawn error:", err.message);
      this.emit("event", { type: "error", message: err.message } satisfies PipelineEvent);
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this.shuttingDown) return;

      this.emit("event", { type: "running", value: false } satisfies PipelineEvent);

      // Crash-loop guard: a healthy run resets the counter; rapid repeated
      // exits (e.g. missing DEEPSEEK_API_KEY raising at import) back off and
      // eventually give up instead of hammering the respawn.
      const uptime = Date.now() - this.startedAt;
      this.restarts = uptime < MIN_HEALTHY_MS ? this.restarts + 1 : 0;

      if (this.restarts > MAX_RESTARTS) {
        console.error(`[pipeline] crash-looping (code=${code}, signal=${signal}); giving up`);
        this.emit("event", {
          type: "error",
          message: "Pipeline keeps crashing on startup. Check DEEPSEEK_API_KEY and the Python venv.",
        } satisfies PipelineEvent);
        return;
      }

      // restarts >= 1 here (incremented above on a fast exit), so the exponent
      // is >= 0: 1s, 2s, 4s, 8s, capped at 8s.
      const delay = Math.min(1000 * 2 ** (this.restarts - 1), 8000);
      console.error(
        `[pipeline] exited (code=${code}, signal=${signal}); respawning in ${delay}ms (attempt ${this.restarts})`,
      );
      this.emit("event", {
        type: "error",
        message: "Pipeline process exited; restarting.",
      } satisfies PipelineEvent);
      setTimeout(() => {
        if (!this.shuttingDown) this.spawn(); // re-emits `init`, restoring devices + prompt
      }, delay).unref();
    });
  }

  sendStart(inputDevice: string, outputDevice: string): void {
    this.write({ type: "start", input_device: inputDevice, output_device: outputDevice });
  }

  sendStop(): void {
    this.write({ type: "stop" });
  }

  sendSetPrompt(text: string): void {
    this.write({ type: "set_prompt", text });
  }

  /** Terminate the Python process. Called only on backend shutdown. */
  kill(): void {
    this.shuttingDown = true;
    if (!this.proc) return;
    this.proc.stdin?.end(); // EOF makes ipc_reader return and main() exit cleanly
    const proc = this.proc;
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000).unref();
  }

  isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  private write(cmd: PipelineCommand): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    }
  }
}
