// Ambient types for the Emscripten-built piper_phonemize module
// (@diffusionstudio/piper-wasm). It's a MODULARIZE factory whose CLI prints one
// JSON line per input item: { phoneme_ids, phonemes, text, ... }.
declare module "@diffusionstudio/piper-wasm/build/piper_phonemize.js" {
  interface PiperPhonemizeOptions {
    print?: (line: string) => void;
    printErr?: (line: string) => void;
    locateFile?: (path: string) => string;
  }
  interface PiperPhonemizeModule {
    callMain(args: string[]): number;
  }
  const createPiperPhonemize: (opts: PiperPhonemizeOptions) => Promise<PiperPhonemizeModule>;
  export = createPiperPhonemize;
}
