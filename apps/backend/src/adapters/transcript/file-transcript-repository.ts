import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import type { Session } from "../../domain/types";
import type { TranscriptRepositoryPort } from "../../domain/ports";

const REPO_ROOT = resolve(__dirname, "../../../../../");
const DIR = resolve(REPO_ROOT, "transcripts");

// ponytail: dumb one-file-per-session JSON. Swap for a DB adapter only if a
// query/search need appears.
export class FileTranscriptRepository implements TranscriptRepositoryPort {
  async save(session: Session): Promise<void> {
    await mkdir(DIR, { recursive: true });
    const name = `${session.startedAt.replace(/[:.]/g, "-")}.json`;
    await writeFile(resolve(DIR, name), JSON.stringify(session, null, 2), "utf8");
  }
}
