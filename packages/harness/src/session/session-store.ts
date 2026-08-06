import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { FileChange, Turn, TurnMeta, Usage } from "../types";
import type { VfsDump } from "../vfs/types";

// Session-level persistence: a full snapshot (history + turns + workspace files). Enables
// load existing session, export/import, and progressive save. Drivers are pluggable; apps
// can implement SessionStore over Postgres.

export type SessionSnapshot = {
  id: string;
  title?: string;
  workingHistory: ModelMessage[]; // loaded to the model next turn (from last summary checkpoint)
  fullLog: ModelMessage[]; // durable, append-only — ALL messages from the start (never compacted)
  turns: Turn[]; // rendered conversation (for UI restore)
  lastRead: Record<string, string>; // §14 read-state (path -> content hash) — staleness survives resume
  usage: Usage;
  turnMeta: TurnMeta[]; // per-turn billing + audit
  fileChanges: FileChange[]; // file change index
  vfs?: VfsDump; // ephemeral drivers (MemoryVFS) only; persistent drivers (fs/db) are their own source
  updatedAt: string;
};

export interface SessionStore {
  save(snap: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private map = new Map<string, SessionSnapshot>();
  async save(snap: SessionSnapshot): Promise<void> {
    this.map.set(snap.id, structuredClone(snap));
  }
  async load(id: string): Promise<SessionSnapshot | null> {
    const s = this.map.get(id);
    return s ? structuredClone(s) : null;
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

// One JSON file per session under `dir`.
export class JsonSessionStore implements SessionStore {
  constructor(private dir: string) {}
  private file(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }
  async save(snap: SessionSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(snap.id), JSON.stringify(snap, null, 2));
  }
  async load(id: string): Promise<SessionSnapshot | null> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as SessionSnapshot;
    } catch {
      return null;
    }
  }
  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5)));
    } catch {
      return [];
    }
  }
  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
