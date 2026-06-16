// Turn-taking hysteresis over a stream of VAD probabilities: start fast, end
// after a hangover so short pauses don't end a turn. Extracted from vad.ts so it
// is pure and unit-testable, independent of the ONNX model.

export interface TurnEdge {
  started: boolean;
  ended: boolean;
}

export class TurnDetector {
  private _speaking = false;
  private silenceFrames = 0;

  get isSpeaking(): boolean {
    return this._speaking;
  }

  constructor(
    private startThreshold = 0.5,
    private endThreshold = 0.35,
    private hangoverFrames = 24, // ~0.77s of sub-threshold frames ends a turn
  ) {}

  // Feed one frame's speech probability; returns start/end edge flags.
  observe(prob: number): TurnEdge {
    let started = false;
    let ended = false;
    if (!this._speaking) {
      if (prob >= this.startThreshold) {
        this._speaking = true;
        this.silenceFrames = 0;
        started = true;
      }
    } else {
      if (prob < this.endThreshold) {
        if (++this.silenceFrames >= this.hangoverFrames) {
          this._speaking = false;
          this.silenceFrames = 0;
          ended = true;
        }
      } else {
        this.silenceFrames = 0;
      }
    }
    return { started, ended };
  }

  reset(): void {
    this._speaking = false;
    this.silenceFrames = 0;
  }
}
