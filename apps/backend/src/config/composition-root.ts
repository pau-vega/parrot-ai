import type { PipelineBackend, PipelineDependencies } from "../domain/ports.js"

import { AudioInput, AudioOutput, deviceNames } from "../adapters/audio/naudiodon-audio.js"
import { DeepSeekLLM } from "../adapters/llm/deepseek-llm.js"
import { WhisperSTT } from "../adapters/stt/whisper-stt.js"
import { FileTranscriptRepository } from "../adapters/transcript/file-transcript-repository.js"
import { PiperTTS } from "../adapters/tts/piper-tts.js"
import { SileroVAD } from "../adapters/vad/silero-vad.js"
import { PipelineService } from "../application/pipeline-service.js"

// The only module that imports concrete adapters. Wires them into the domain
// behind the ports and returns the driving backend.
export function buildPipeline(): PipelineBackend {
  const deps: PipelineDependencies = {
    createAudioInput: (device) => new AudioInput(device),
    createAudioOutput: (device, rate) => new AudioOutput(device, rate),
    createVad: () => new SileroVAD(),
    createStt: () => new WhisperSTT(),
    createTts: () => new PiperTTS(),
    createLlm: () => new DeepSeekLLM(),
    transcripts: new FileTranscriptRepository(),
    deviceNames,
  }
  return new PipelineService(deps)
}
