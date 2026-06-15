// Minimal ambient types for naudiodon-neo (ships no TypeScript types).
declare module "naudiodon-neo" {
  import { Readable, Writable } from "stream";

  export interface Device {
    id: number;
    name: string;
    maxInputChannels: number;
    maxOutputChannels: number;
    defaultSampleRate: number;
  }
  export function getDevices(): Device[];

  export const SampleFormat16Bit: number;

  export interface IoOptions {
    channelCount: number;
    sampleFormat: number;
    sampleRate: number;
    deviceId: number;
    closeOnError?: boolean;
  }

  // AudioIO is a Readable (inOptions) or Writable (outOptions) stream.
  export class AudioIO extends Readable implements Pick<Writable, "write"> {
    constructor(opts: { inOptions?: IoOptions; outOptions?: IoOptions });
    start(): void;
    quit(cb?: () => void): void;
    abort(cb?: () => void): void;
    write(chunk: Buffer): boolean;
  }
}
