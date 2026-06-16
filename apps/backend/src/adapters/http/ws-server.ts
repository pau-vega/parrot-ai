import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerMessage, PipelineEvent } from "../../types";
import { isBrowserMessage } from "../../types";
import type { PipelineBackend } from "../../domain/ports";
import { LLM_MODEL } from "../../config/config";

const HEARTBEAT_MS = 30_000;

export interface WsServerOptions {
  port: number;
  frontendDir: string;
  defaultInputDevice: string;
  defaultOutputDevice: string;
}

/**
 * Driving adapter: serves the frontend and bridges browser WebSocket messages to
 * the PipelineBackend, broadcasting the pipeline's PipelineEvent stream back.
 * Depends on the PipelineBackend interface, not a concrete implementation.
 */
export function startWsServer(pipeline: PipelineBackend, opts: WsServerOptions): { close: (cb?: () => void) => void } {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  app.use(express.static(opts.frontendDir));

  const cachedDevices: { input: string[]; output: string[] } = { input: [], output: [] };
  let cachedPrompt = "";
  let isRunning = false;
  const agentState = {
    input_device: opts.defaultInputDevice,
    output_device: opts.defaultOutputDevice,
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
    // PipelineEvent (excluding "init") is defined as a subset of ServerMessage,
    // so this is sound by the type definitions in types.ts.
    broadcast(event);
  });

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
          if (cmd.input_device) agentState.input_device = cmd.input_device;
          if (cmd.output_device) agentState.output_device = cmd.output_device;
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

  pipeline.spawn();

  server.listen(opts.port, "127.0.0.1", () => {
    console.error(`Parrot AI listening on http://127.0.0.1:${opts.port}`);
  });

  return {
    close: (cb?: () => void): void => {
      clearInterval(heartbeat);
      server.close(cb);
    },
  };
}
