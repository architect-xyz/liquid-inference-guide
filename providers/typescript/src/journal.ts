import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * An append-only file of award claims. A claim is flushed to disk before any
 * upstream request, so a restart cannot run the same award twice.
 */
export class Journal {
  private readonly claimed = new Set<string>();
  private fd: number | undefined;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line !== "") this.claimed.add(line);
      }
    }
    this.fd = openSync(path, "a");
  }

  private static key(providerId: string, awardId: string): string {
    return JSON.stringify([providerId, awardId]);
  }

  contains(providerId: string, awardId: string): boolean {
    return this.claimed.has(Journal.key(providerId, awardId));
  }

  /** Returns true for the first claim of an award and false for every repeat. */
  claim(providerId: string, awardId: string): boolean {
    const key = Journal.key(providerId, awardId);
    if (this.claimed.has(key)) return false;
    if (this.fd === undefined) throw new Error("journal is closed");
    writeSync(this.fd, `${key}\n`);
    fsyncSync(this.fd);
    this.claimed.add(key);
    return true;
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
