import type { FileEntry, FileMeta, GrepHit, VFS } from '@enkaku/harness'
import { EnkakuError } from '../../util/errors'
import { normaliseScopePrefix, pathWithinAnyPrefix } from '../../workspace/path'
import type { WorkspaceListEntry, WorkspaceStore } from '../../workspace/store'

/**
 * `EnkakuVFS implements VFS` — a DRIVER over Plan 64's workspace store, exactly the way upstream
 * drives its own `VFS` interface with `PostgresVFS` (`bitorex-algo/packages/server/src/quant/
 * postgres-vfs.ts:9`). Plan 64's store keeps everything it already had — path validation, quotas,
 * compare-and-swap, the `workspace_files` table, the Studio browser; this class is the ONLY new
 * thing, and it is a thin translation layer, not a second store (plan 77 §3.1, goal 1).
 *
 * `version` — the harness's `VFS` interface calls this a "content hash" (`vfs/types.ts`) and hashes
 * with sha1 (`hashContent`) purely for change detection, never as a security claim. Plan 64's store
 * already computes a sha256 for exactly the same equality-only purpose (compare-and-swap on
 * `hash`). `EnkakuVFS` returns the STORE'S sha256 as the `version` string here — the interface says
 * "content hash", not "sha1" — and `hashContent`/`shortHash` from `@enkaku/harness` are never
 * called by this file. Recorded here, once, so nobody "fixes" this mismatch later by rehashing
 * every row (plan 77 §3.1).
 *
 * `writeIfVersion` IS Plan 64's compare-and-swap (`store.write` with `ifMatch`) — mapped directly,
 * not reimplemented (plan 77 §3.1's table). Plain `write` has no such parameter in the `VFS`
 * interface (it always succeeds, creating or overwriting unconditionally) while Plan 64's store
 * REQUIRES `ifMatch` to overwrite an existing path (`E_EXISTS` otherwise) — bridged below by reading
 * the current hash first and retrying on a race, never by weakening the store's own CAS guarantee.
 */

export interface EnkakuVfsScope {
  read: readonly string[]
  write: readonly string[]
}

export interface EnkakuVfsOptions {
  /**
   * Chroots this VFS instance under a subtree of the workspace (e.g. `/skills`) so every path the
   * `VFS` interface exposes or accepts is RELATIVE to it — matching the shape upstream's own
   * per-project VFS drivers use (a bare `"checkout/SKILL.md"`, never an absolute path). Defaults to
   * `/`: paths pass through unchanged, matching every other `fs.*` capability's absolute-path
   * convention (`/scripts/hello.ts`). `agent/harness/skills.ts` is the one caller that sets this.
   */
  root?: string
  /** Recorded as `createdBy`/`updatedBy` on writes — `"agent:<id>"` or `"user:<id>"`, matching
   * `capability/fs.ts`'s own convention (`null` records nothing, matching an unauthenticated write). */
  actor?: string | null
  /**
   * Refused for `write`/`writeIfVersion`/`delete`, REGARDLESS of `scope.write` (plan 77 §3.4,
   * §4.4, criterion 11) — `capability/file-tools.ts` sets this to `['/skills/']` for a caller
   * inside a running agent, the same hard rule `capability/fs.ts`'s own `assertWritable` enforces
   * for `fs.write`/`.delete`/`.move`: an agent must never be able to rewrite its own instructions
   * mid-run, even if an operator ever widens that agent's configured write scope to include `/`.
   */
  writeExcludePrefixes?: readonly string[]
}

const MAX_WRITE_RETRIES = 10

function isNotFound(err: unknown): boolean {
  return err instanceof EnkakuError && err.code === 'E_NOT_FOUND'
}

function isConflict(err: unknown): boolean {
  return err instanceof EnkakuError && (err.code === 'E_STALE' || err.code === 'E_EXISTS')
}

export class EnkakuVFS implements VFS {
  private readonly root: string

  constructor(
    private readonly store: WorkspaceStore,
    private readonly scope: EnkakuVfsScope,
    private readonly opts: EnkakuVfsOptions = {},
  ) {
    this.root = opts.root ? normaliseScopePrefix(opts.root) : '/'
  }

  private toAbsolute(path: string): string {
    if (this.root === '/') return path.startsWith('/') ? path : `/${path}`
    const rel = path.replace(/^\/+/, '')
    return `${this.root}${rel}`
  }

  private toRelative(absPath: string): string {
    if (this.root === '/') return absPath
    return absPath.startsWith(this.root) ? absPath.slice(this.root.length) : absPath
  }

  private assertReadable(absPath: string): void {
    if (!pathWithinAnyPrefix(absPath, this.scope.read)) {
      throw new EnkakuError('E_OUT_OF_SCOPE', `"${absPath}" is outside this VFS's read scope`)
    }
  }

  private assertWritable(absPath: string): void {
    if (!pathWithinAnyPrefix(absPath, this.scope.write)) {
      throw new EnkakuError('E_OUT_OF_SCOPE', `"${absPath}" is outside this VFS's write scope`)
    }
    if (this.opts.writeExcludePrefixes && pathWithinAnyPrefix(absPath, this.opts.writeExcludePrefixes)) {
      throw new EnkakuError('E_OUT_OF_SCOPE', `"${absPath}" is read-only through this VFS`)
    }
  }

  /** Scope prefixes actually reachable through THIS instance — the intersection of the caller's
   * grant with this VFS's own root, so `list`/`grep` (which have no per-call path argument) never
   * walk outside either boundary. Disjoint prefixes contribute nothing. */
  private effectiveReadPrefixes(): string[] {
    const out = new Set<string>()
    for (const raw of this.scope.read) {
      let prefix: string
      try {
        prefix = normaliseScopePrefix(raw)
      } catch {
        continue
      }
      if (prefix.startsWith(this.root)) out.add(prefix)
      else if (this.root.startsWith(prefix)) out.add(this.root)
    }
    return [...out]
  }

  async read(path: string): Promise<string | null> {
    const abs = this.toAbsolute(path)
    this.assertReadable(abs)
    try {
      const file = this.store.read(abs)
      return new TextDecoder().decode(file.content)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const abs = this.toAbsolute(path)
    this.assertReadable(abs)
    try {
      const file = this.store.read(abs)
      return { content: new TextDecoder().decode(file.content), version: file.hash, updatedAt: new Date(file.updatedAt * 1000).toISOString() }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.toAbsolute(path)
    this.assertReadable(abs)
    try {
      this.store.read(abs)
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  /**
   * Unconditional write (the `VFS` interface's own contract: create or overwrite, no staleness
   * parameter) atop a store that REQUIRES `ifMatch` to overwrite. Reads the current hash first and
   * retries on a concurrent writer's race (`E_STALE`/`E_EXISTS`) — this widens nothing: the store's
   * own compare-and-swap still runs on every attempt, this function just keeps retrying until ITS
   * OWN write wins, which is what "unconditional" means from this interface's point of view.
   */
  async write(path: string, content: string): Promise<string> {
    const abs = this.toAbsolute(path)
    this.assertWritable(abs)
    const bytes = new TextEncoder().encode(content)
    const actor = this.opts.actor ?? null
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      let ifMatch: string | null = null
      try {
        ifMatch = this.store.read(abs).hash
      } catch (err) {
        if (!isNotFound(err)) throw err
        ifMatch = null
      }
      try {
        const meta = this.store.write(abs, { content: bytes, actor, ifMatch })
        return meta.hash
      } catch (err) {
        if (isConflict(err)) continue // a concurrent writer raced us — retry against the new state
        throw err
      }
    }
    throw new EnkakuError('E_STALE', `"${abs}" could not be written after ${MAX_WRITE_RETRIES} concurrent attempts — try again`)
  }

  async writeIfVersion(path: string, content: string, expected: string): Promise<boolean> {
    const abs = this.toAbsolute(path)
    this.assertWritable(abs)
    const bytes = new TextEncoder().encode(content)
    try {
      this.store.write(abs, { content: bytes, actor: this.opts.actor ?? null, ifMatch: expected })
      return true
    } catch (err) {
      if (isConflict(err)) return false
      throw err
    }
  }

  async delete(path: string): Promise<boolean> {
    const abs = this.toAbsolute(path)
    this.assertWritable(abs)
    try {
      this.store.delete(abs)
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async list(): Promise<FileMeta[]> {
    const out: WorkspaceListEntry[] = []
    const seen = new Set<string>()
    const walk = (prefix: string): void => {
      for (const entry of this.store.list(prefix)) {
        if (entry.kind === 'file') {
          if (pathWithinAnyPrefix(entry.path, this.scope.read) && !seen.has(entry.path)) {
            seen.add(entry.path)
            out.push(entry)
          }
        } else {
          walk(entry.path)
        }
      }
    }
    for (const prefix of this.effectiveReadPrefixes()) walk(prefix)
    return out.map((e) => ({ path: this.toRelative(e.path), size: e.size ?? 0, updatedAt: new Date((e.updatedAt ?? 0) * 1000).toISOString() }))
  }

  async grep(pattern: string): Promise<GrepHit[]> {
    const seen = new Set<string>()
    const hits: GrepHit[] = []
    for (const prefix of this.effectiveReadPrefixes()) {
      const { hits: found } = this.store.grep(prefix, pattern)
      for (const h of found) {
        if (!pathWithinAnyPrefix(h.path, this.scope.read)) continue
        const key = `${h.path}:${h.line}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push({ path: this.toRelative(h.path), line: h.line, text: h.text })
      }
    }
    return hits
  }
}
