import { createHash } from "node:crypto";

// VFS = the world the agent edits. ASYNC interface so drivers can be in-memory, a JSON
// file, a real folder, or a database. The `version` is a CONTENT HASH — it answers exactly
// "is the file's content identical to what the AI last read?" (§14 staleness). It's computed
// lazily in stat() (i.e. only for files the agent actually reads/edits); list() never hashes.

export type FileMeta = { path: string; size: number; updatedAt: string };
export type FileEntry = { content: string; version: string; updatedAt: string };
export type GrepHit = { path: string; line: number; text: string };

export interface VFS {
  read(path: string): Promise<string | null>;
  /** Full entry incl. the content-hash version. Computing the hash here = only interacted files. */
  stat(path: string): Promise<FileEntry | null>;
  /** Write/overwrite; returns the new content-hash version. */
  write(path: string, content: string): Promise<string>;
  /** Optimistic lock: write only if the current content hash matches `expected`. */
  writeIfVersion(path: string, content: string, expected: string): Promise<boolean>;
  delete(path: string): Promise<boolean>;
  list(): Promise<FileMeta[]>;
  exists(path: string): Promise<boolean>;
  grep(pattern: string): Promise<GrepHit[]>;
}

// Content hash = the version. Equality-only (no ordering needed for staleness). sha1 is fine
// for change-detection (not security). Stored full; display short (git-style).
export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}
export function shortHash(v: string): string {
  return v.slice(0, 7);
}

// Serializable form for session export/import (version derived from content, so omitted).
export type VfsDump = { path: string; content: string; updatedAt: string }[];

export async function dumpVfs(vfs: VFS): Promise<VfsDump> {
  const out: VfsDump = [];
  for (const m of await vfs.list()) {
    const content = await vfs.read(m.path);
    if (content != null) out.push({ path: m.path, content, updatedAt: m.updatedAt });
  }
  return out;
}

export function grepEntries(entries: Iterable<[string, { content: string }]>, pattern: string): GrepHit[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return [];
  }
  const hits: GrepHit[] = [];
  for (const [path, f] of entries) {
    f.content.split("\n").forEach((text, i) => {
      if (re.test(text)) hits.push({ path, line: i + 1, text });
    });
  }
  return hits;
}
