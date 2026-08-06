import { grepEntries, hashContent, type FileEntry, type FileMeta, type GrepHit, type VfsDump, type VFS } from "./types";

type Row = { content: string; updatedAt: string };

// In-memory VFS (Map). Version = content hash, computed on demand (stat). list() never hashes.
export class MemoryVFS implements VFS {
  private store = new Map<string, Row>();

  constructor(dump?: VfsDump) {
    if (dump) for (const f of dump) this.store.set(f.path, { content: f.content, updatedAt: f.updatedAt });
  }

  async read(path: string): Promise<string | null> {
    return this.store.get(path)?.content ?? null;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const r = this.store.get(path);
    return r ? { content: r.content, version: hashContent(r.content), updatedAt: r.updatedAt } : null;
  }

  async write(path: string, content: string): Promise<string> {
    this.store.set(path, { content, updatedAt: new Date().toISOString() });
    return hashContent(content);
  }

  async writeIfVersion(path: string, content: string, expected: string): Promise<boolean> {
    const cur = this.store.get(path);
    if (!cur || hashContent(cur.content) !== expected) return false;
    this.store.set(path, { content, updatedAt: new Date().toISOString() });
    return true;
  }

  async delete(path: string): Promise<boolean> {
    return this.store.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }

  async list(): Promise<FileMeta[]> {
    return [...this.store.entries()].map(([path, r]) => ({ path, size: r.content.length, updatedAt: r.updatedAt }));
  }

  async grep(pattern: string): Promise<GrepHit[]> {
    return grepEntries(this.store.entries(), pattern);
  }

  dump(): VfsDump {
    return [...this.store.entries()].map(([path, r]) => ({ path, content: r.content, updatedAt: r.updatedAt }));
  }
}
