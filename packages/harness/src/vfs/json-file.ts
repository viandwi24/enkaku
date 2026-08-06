import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { grepEntries, hashContent, type FileEntry, type FileMeta, type GrepHit, type VfsDump, type VFS } from "./types";

type Row = { content: string; updatedAt: string };

// Persists the WHOLE workspace to one JSON file. Version = content hash (lazy, in stat).
export class JsonFileVFS implements VFS {
  private store = new Map<string, Row>();
  private loaded = false;

  constructor(private filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const dump = JSON.parse(await readFile(this.filePath, "utf8")) as VfsDump;
      for (const f of dump) this.store.set(f.path, { content: f.content, updatedAt: f.updatedAt });
    } catch {
      /* no file yet */
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const dump: VfsDump = [...this.store.entries()].map(([path, r]) => ({ path, content: r.content, updatedAt: r.updatedAt }));
    await writeFile(this.filePath, JSON.stringify(dump, null, 2));
  }

  async read(path: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.store.get(path)?.content ?? null;
  }

  async stat(path: string): Promise<FileEntry | null> {
    await this.ensureLoaded();
    const r = this.store.get(path);
    return r ? { content: r.content, version: hashContent(r.content), updatedAt: r.updatedAt } : null;
  }

  async write(path: string, content: string): Promise<string> {
    await this.ensureLoaded();
    this.store.set(path, { content, updatedAt: new Date().toISOString() });
    await this.flush();
    return hashContent(content);
  }

  async writeIfVersion(path: string, content: string, expected: string): Promise<boolean> {
    await this.ensureLoaded();
    const cur = this.store.get(path);
    if (!cur || hashContent(cur.content) !== expected) return false;
    this.store.set(path, { content, updatedAt: new Date().toISOString() });
    await this.flush();
    return true;
  }

  async delete(path: string): Promise<boolean> {
    await this.ensureLoaded();
    const ok = this.store.delete(path);
    if (ok) await this.flush();
    return ok;
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.store.has(path);
  }

  async list(): Promise<FileMeta[]> {
    await this.ensureLoaded();
    return [...this.store.entries()].map(([path, r]) => ({ path, size: r.content.length, updatedAt: r.updatedAt }));
  }

  async grep(pattern: string): Promise<GrepHit[]> {
    await this.ensureLoaded();
    return grepEntries(this.store.entries(), pattern);
  }
}
