import type { FileEntry, FileMeta, GrepHit, VFS } from "./types";

// Composite VFS: a writable base (the workspace) + read-only layers mounted under a prefix
// (e.g. "skills"). The agent sees everything through ONE filesystem via the normal file tools —
// exactly like Claude's sandbox where skills live alongside the working dir. Reads/list/grep
// merge all layers; writes go to the base (layer paths are read-only).

export type OverlayLayer = { prefix: string; vfs: VFS };

export class OverlayVFS implements VFS {
  constructor(
    private base: VFS,
    private layers: OverlayLayer[] = [],
  ) {}

  private route(path: string): { vfs: VFS; sub: string; isLayer: boolean } {
    for (const l of this.layers) {
      if (path === l.prefix || path.startsWith(l.prefix + "/")) {
        return { vfs: l.vfs, sub: path.slice(l.prefix.length + 1), isLayer: true };
      }
    }
    return { vfs: this.base, sub: path, isLayer: false };
  }

  async read(path: string): Promise<string | null> {
    const r = this.route(path);
    return r.vfs.read(r.sub);
  }
  async stat(path: string): Promise<FileEntry | null> {
    const r = this.route(path);
    return r.vfs.stat(r.sub);
  }
  async exists(path: string): Promise<boolean> {
    const r = this.route(path);
    return r.vfs.exists(r.sub);
  }

  async write(path: string, content: string): Promise<string> {
    const r = this.route(path);
    if (r.isLayer) throw new Error(`Read-only path '${path}'`);
    return this.base.write(path, content);
  }
  async writeIfVersion(path: string, content: string, expected: string): Promise<boolean> {
    const r = this.route(path);
    if (r.isLayer) return false;
    return this.base.writeIfVersion(path, content, expected);
  }
  async delete(path: string): Promise<boolean> {
    const r = this.route(path);
    if (r.isLayer) return false;
    return this.base.delete(path);
  }

  async list(): Promise<FileMeta[]> {
    const out: FileMeta[] = await this.base.list();
    for (const l of this.layers) {
      for (const m of await l.vfs.list()) out.push({ ...m, path: `${l.prefix}/${m.path}` });
    }
    return out;
  }
  async grep(pattern: string): Promise<GrepHit[]> {
    const out: GrepHit[] = await this.base.grep(pattern);
    for (const l of this.layers) {
      for (const h of await l.vfs.grep(pattern)) out.push({ ...h, path: `${l.prefix}/${h.path}` });
    }
    return out;
  }
}
