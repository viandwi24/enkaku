import { mkdir, readdir, readFile, stat as fsStat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { hashContent, type FileEntry, type FileMeta, type GrepHit, type VFS } from "./types";

// Maps the workspace onto a REAL folder. Version = content hash, computed in stat() (reads
// the file). list()/grep walk the dir for metadata but only stat() hashes — so we hash only
// files the agent actually reads/edits. Detects external edits (content differs -> hash differs)
// and ignores no-op rewrites (same content -> same hash). Node-only.
export class FsVFS implements VFS {
  constructor(private root: string) {}

  private abs(p: string): string {
    return join(this.root, p);
  }
  private rel(full: string): string {
    return relative(this.root, full).split(sep).join("/");
  }
  private async walk(dir: string, out: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (e.isFile()) out.push(this.rel(full));
    }
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), "utf8");
    } catch {
      return null;
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    try {
      const s = await fsStat(this.abs(path));
      const content = await readFile(this.abs(path), "utf8");
      return { content, version: hashContent(content), updatedAt: new Date(s.mtimeMs).toISOString() };
    } catch {
      return null;
    }
  }

  async write(path: string, content: string): Promise<string> {
    const a = this.abs(path);
    await mkdir(dirname(a), { recursive: true });
    await writeFile(a, content);
    return hashContent(content);
  }

  async writeIfVersion(path: string, content: string, expected: string): Promise<boolean> {
    const cur = await this.read(path);
    if (cur == null || hashContent(cur) !== expected) return false;
    await this.write(path, content);
    return true;
  }

  async delete(path: string): Promise<boolean> {
    try {
      await unlink(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsStat(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<FileMeta[]> {
    const paths: string[] = [];
    await this.walk(this.root, paths);
    const out: FileMeta[] = [];
    for (const p of paths) {
      try {
        const s = await fsStat(this.abs(p)); // metadata only — no content read, no hash
        out.push({ path: p, size: s.size, updatedAt: new Date(s.mtimeMs).toISOString() });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async grep(pattern: string): Promise<GrepHit[]> {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return [];
    }
    const paths: string[] = [];
    await this.walk(this.root, paths);
    const hits: GrepHit[] = [];
    for (const p of paths) {
      const content = await this.read(p);
      if (content == null) continue;
      content.split("\n").forEach((text, i) => {
        if (re.test(text)) hits.push({ path: p, line: i + 1, text });
      });
    }
    return hits;
  }
}
