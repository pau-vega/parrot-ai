// Ports: the interfaces the domain depends on. Adapters in src/adapters/*
// implement these; the composition root (src/config/composition-root.ts) wires
// concrete adapters into the domain. The domain imports nothing concrete.

import type { PipelineEvent } from "../types";
import type { ChatMessage, Session } from "./types";

// Driven ports (the domain calls these) ------------------------------------

export interface AudioInputPort {
  start(): void;
  stop(): void;
  // Emits fixed 512-sample float32 frames at 16kHz mono.
  onFrame(handler: (frame: Float32Array) => void): void;
}

export interface AudioOutputPort {
  // Write PCM in slices; resolves when done or stopped (barge-in).
  play(pcm: Buffer): Promise<void>;
  stop(): void;
  close(): void;
}

export interface VadPort {
  load(): Promise<void>;
  // One 512-sample frame → speech probability [0,1]. Turn-taking hysteresis
  // lives in the domain (TurnDetector), not here.
  process(frame: Float32Array): Promise<number>;
  reset(): void;
}

export interface SttPort {
  load(): Promise<void>;
  transcribe(audio: Float32Array): Promise<string>;
  free(): Promise<void>;
}

export interface LlmPort {
  // Stateless: given the full message list, stream raw token deltas. Conversation
  // history (Conversation) and sentence chunking (SentenceChunker) live in the domain.
  stream(messages: readonly ChatMessage[], signal: AbortSignal): AsyncGenerator<string>;
}

export interface TtsResult {
  sampleRate: number;
  pcm: Buffer;
}

export interface TtsPort {
  readonly sampleRate: number;
  load(): Promise<void>;
  synth(text: string): Promise<TtsResult>;
}

export interface TranscriptRepositoryPort {
  save(session: Session): Promise<void>;
}

// The dependency bundle the application injects into a TurnEngine. Audio is
// session-scoped (needs a device name / rate at start time), so it's a factory;
// the model adapters are also built per session to preserve per-start model reload.
export interface PipelineDependencies {
  createAudioInput(device: string): AudioInputPort;
  createAudioOutput(device: string, sampleRate: number): AudioOutputPort;
  createVad(): VadPort;
  createStt(): SttPort;
  createTts(): TtsPort;
  createLlm(): LlmPort;
  transcripts: TranscriptRepositoryPort;
  deviceNames(kind: "input" | "output"): string[];
}

// Driving port: the surface index.ts / the WS adapter drive. Formalizes the
// previously implicit NodePipelineBackend shape.
export interface PipelineBackend {
  spawn(): void;
  sendStart(inputDevice: string, outputDevice: string): void;
  sendStop(): void;
  sendSetPrompt(text: string): void;
  kill(): void;
  isAlive(): boolean;
  on(event: "event", listener: (e: PipelineEvent) => void): this;
}
