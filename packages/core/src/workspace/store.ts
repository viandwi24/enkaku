import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { workspaceFiles, type WorkspaceFileRow } from '../db/schema'
import { createLogger, type Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { createFsContentDriver, createInlineDriver, type ContentDriver } from './drivers'
import { normaliseScopePrefix, normaliseWorkspacePath, scopeOfPath } from './path'

/**
 * The workspace store (plan 64 §3.3, §3.4, §4.1, step 64.3; driver seam
 * added by plan 115 §3.1, §3.4, step 115.1) — read, write, list, delete,
 * move, with compare-and-swap writes and per-scope quotas. Every operation
 * is a plain SQLite query against `workspaceFiles` PLUS, for a write or a
 * delete, a call to a `ContentDriver` (`./drivers`) that this file picks by
 * policy — NOTHING here ever calls `node:fs` directly (§3.1/plan 115 §3.2 —
 * the store's own tests run with the data directory read-only to prove it).
 * That property used to mean the store never touched real bytes at all; it
 * now means the store never touches them ITSELF — the driver does, and an
 * `inline` row (every row written before plan 115, and any small text row
 * written after it) never reaches a driver capable of real I/O in the first
 * place, which is exactly why that read-only test still passes unchanged.
 */

export interface WorkspaceQuotas {
  maxFileBytes: number
  maxFilesPerScope: number
  maxTotalBytesPerScope: number
  /**
   * The routing threshold (plan 115 §3.4) — content at or under this size
   * AND recognised as text stays `inline`; anything else goes to the `fs`
   * driver. Optional so a caller (chiefly the store's own pre-114 tests)
   * that never sets it gets `DEFAULT_INLINE_MAX_BYTES` instead of `undefined`
   * silently meaning "always inline" or "never inline".
   */
  inlineMaxBytes?: number
}

export interface WorkspaceStoreOptions {
  /**
   * Root directory for the `fs` driver's content-addressed blobs (plan 115
   * §3.3, §9 Q1) — a plain constructor parameter, not yet a farm setting;
   * wiring computes `<dataDir>/workspace-content/` and passes it here, which
   * is what keeps raising Q1 to a setting later a wiring change rather than
   * a redesign. Falls back to a relative default that real boot always
   * overrides — reachable only if a caller never sets it AND actually writes
   * content over `inlineMaxBytes`, which none of the store's own tests do.
   */
  fsContentRoot?: string
  log?: Logger
}

const DEFAULT_INLINE_MAX_BYTES = 65_536
/**
 * Where the `fs` content driver writes when a caller does not say — and it is deliberately in the
 * OS temp directory rather than the process's own working directory.
 *
 * It used to be the RELATIVE path `.enkaku-workspace-content`, which meant "wherever this process
 * happens to have been started". `daemon.ts` always passes an explicit root, so a real farm was
 * never affected — but every one of the ~26 test constructions took the default, and a binary write
 * from any of them dropped real files into the repository root, untracked and not gitignored, where
 * they could be committed by accident. One turned up exactly that way.
 *
 * An absolute temp path makes a forgetful caller harmless instead of messy. The warning below is
 * what stops it from being silently ACCEPTABLE: a production caller that reaches this default has a
 * wiring bug, and content in a temp directory does not survive a reboot.
 */
const DEFAULT_FS_CONTENT_ROOT = join(tmpdir(), 'enkaku-workspace-content')

/**
 * Text-vs-binary judgement (moved here from `capability/fs.ts`, which now
 * imports it, per plan 115's "reuse the store's own judgement rather than
 * inventing a second one" — this IS what decides `fs.write`'s wire encoding
 * AND, since plan 115, which driver a write lands on, so it belongs to the
 * store rather than to one capability that happens to call it).
 */
export function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/javascript' ||
    contentType === 'application/typescript' ||
    contentType.endsWith('+json') ||
    contentType.endsWith('+xml')
  )
}

export interface WorkspaceFileMeta {
  path: string
  contentType: string
  size: number
  hash: string
  createdBy: string | null
  updatedBy: string | null
  createdAt: number
  updatedAt: number
}

export interface WorkspaceFileContent extends WorkspaceFileMeta {
  content: Uint8Array
}

export type WorkspaceEntryKind = 'file' | 'dir'

/** One row of `fs.list` (plan 64 §4.2) — a directory entry is synthesised
 * from the paths under it; it is never a row of its own (§3.2). */
export interface WorkspaceListEntry {
  path: string
  kind: WorkspaceEntryKind
  size: number | null
  hash: string | null
  updatedAt: number | null
}

export interface WorkspaceWriteInput {
  content: Uint8Array
  contentType?: string
  /** Required to overwrite an existing file; forbidden (must be omitted/null) to create one (plan 64 §3.4). */
  ifMatch?: string | null
  actor: string | null
}

export interface WorkspaceDeleteInput {
  /** Optional CAS token — when given, a mismatch refuses with `E_STALE` exactly like a write. */
  ifMatch?: string | null
}

export interface WorkspaceMoveInput {
  /** Required — CAS on the SOURCE (plan 64 §4.2). */
  ifMatch: string
  actor?: string | null
}

/** One `grep` match (plan 77 §3.2, §4.2) — mirrors the harness's own `GrepHit` shape
 * (`packages/harness/src/vfs/types.ts`) so `EnkakuVFS.grep` is a plain pass-through. */
export interface WorkspaceGrepHit {
  path: string
  line: number
  text: string
}

export interface WorkspaceGrepResult {
  hits: WorkspaceGrepHit[]
  /** True when more matches existed under `prefix` than the cap returned — a truthful "more
   * matches were not shown" rather than a silent truncation (plan 77 §3.2, criterion 4). */
  truncated: boolean
}

export interface WorkspaceStore {
  /** Immediate children of `prefix` only (files and synthesised directories) — the shape Studio's lazily-loaded tree needs (plan 64 §4.5). */
  list(prefix: string): WorkspaceListEntry[]
  read(path: string): WorkspaceFileContent
  write(path: string, input: WorkspaceWriteInput): WorkspaceFileMeta
  delete(path: string, input?: WorkspaceDeleteInput): void
  move(from: string, to: string, input: WorkspaceMoveInput): WorkspaceFileMeta
  /**
   * Search file contents by regex under `prefix` (plan 77 §3.2, §4.2) — the ONE method the
   * harness's `VFS` interface needs that Plan 64 did not already have. A single scan over the
   * scoped rows rather than N reads, added HERE (the table owner) rather than in a driver that
   * would otherwise read every file itself. Every caller passes the scope it is allowed to see
   * (`fs.grep`'s `assertInScope`, `EnkakuVFS`'s own scope) — this function itself does not know
   * about actors or grants, exactly like `list` above; `prefix` IS the boundary.
   */
  grep(prefix: string, pattern: string): WorkspaceGrepResult
}

function toSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

/** A generous cap, not a tuning knob — large enough that a real search never bumps into it in
 * practice, small enough that a pathological pattern over a big workspace cannot build an
 * unbounded response (plan 77 §3.2). */
const GREP_MAX_HITS = 200

function rowToMeta(row: WorkspaceFileRow): WorkspaceFileMeta {
  return {
    path: row.path,
    contentType: row.contentType,
    size: row.size,
    hash: row.hash,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: toSeconds(row.createdAt),
    updatedAt: toSeconds(row.updatedAt),
  }
}

export function createWorkspaceStore(db: Db, quotas: () => WorkspaceQuotas, opts: WorkspaceStoreOptions = {}): WorkspaceStore {
  const log = opts.log ?? createLogger('workspace.store')
  const inlineDriver = createInlineDriver()
  if (opts.fsContentRoot && !isAbsolute(opts.fsContentRoot)) {
    throw new EnkakuError('E_BAD_CONFIG', `workspace fsContentRoot must be an absolute path, got "${opts.fsContentRoot}" — a relative root writes wherever the process was started`)
  }
  if (!opts.fsContentRoot) {
    opts.log?.warn?.(`workspace: no fsContentRoot was given — falling back to ${DEFAULT_FS_CONTENT_ROOT}, which does not survive a reboot. A farm should pass one (daemon.ts does).`)
  }
  const fsDriver = createFsContentDriver(opts.fsContentRoot ?? DEFAULT_FS_CONTENT_ROOT)
  const driverFor = (storage: string): ContentDriver => (storage === 'fs' ? fsDriver : inlineDriver)

  /** Small text stays `inline`; anything larger, or anything not text, goes to the `fs` driver
   * (plan 115 §3.4) — the caller never picks, so the day an `s3` driver exists nothing above the
   * store has to be taught about it. */
  const driverForWrite = (size: number, contentType: string, inlineMaxBytes: number): ContentDriver =>
    size <= inlineMaxBytes && isTextContentType(contentType) ? inlineDriver : fsDriver

  const bytesFor = (row: WorkspaceFileRow): Uint8Array => {
    if (row.storage === 'inline') return new Uint8Array(row.content)
    if (!row.locator) throw new EnkakuError('E_INTERNAL', `workspace row "${row.path}" has storage "${row.storage}" but no locator`)
    return driverFor(row.storage).get(row.locator)
  }

  const getRow = (path: string): WorkspaceFileRow | null =>
    db.select().from(workspaceFiles).where(eq(workspaceFiles.path, path)).get() ?? null

  /**
   * Every row under `prefix` (a normalised scope, always ending in `/`, or
   * the bare `/` for everything) — used for quota accounting. Deliberately
   * NOT exposed as the public `list()`, which only ever returns one level
   * (plan 64 §4.5's "lazily loaded per prefix").
   */
  const scanUnder = (prefix: string): WorkspaceFileRow[] => {
    const all = db.select().from(workspaceFiles).all()
    return prefix === '/' ? all : all.filter((r) => r.path.startsWith(prefix))
  }

  const scopeUsage = (scope: string): { fileCount: number; totalBytes: number } => {
    const rows = scanUnder(scope)
    return { fileCount: rows.length, totalBytes: rows.reduce((sum, r) => sum + r.size, 0) }
  }

  return {
    list(prefixRaw) {
      const prefix = normaliseScopePrefix(prefixRaw)
      const rows = scanUnder(prefix)
      const byChild = new Map<string, WorkspaceListEntry>()
      for (const row of rows) {
        const rest = row.path.slice(prefix.length) // e.g. "sub/dir/file.ts" or "file.ts"
        const slash = rest.indexOf('/')
        if (slash === -1) {
          byChild.set(row.path, { path: row.path, kind: 'file', size: row.size, hash: row.hash, updatedAt: toSeconds(row.updatedAt) })
        } else {
          const dirPath = prefix + rest.slice(0, slash) + '/'
          if (!byChild.has(dirPath)) byChild.set(dirPath, { path: dirPath, kind: 'dir', size: null, hash: null, updatedAt: null })
        }
      }
      return [...byChild.values()].sort((a, b) => a.path.localeCompare(b.path))
    },

    read(pathRaw) {
      const path = normaliseWorkspacePath(pathRaw)
      const row = getRow(path)
      if (!row) throw new EnkakuError('E_NOT_FOUND', `no such workspace file: ${path}`)
      return { ...rowToMeta(row), content: bytesFor(row) }
    },

    write(pathRaw, input) {
      const path = normaliseWorkspacePath(pathRaw)
      const q = quotas()
      const size = input.content.byteLength
      if (size > q.maxFileBytes) {
        throw new EnkakuError(
          'E_QUOTA',
          `"${path}" is ${size} bytes, over the maxFileBytes limit of ${q.maxFileBytes} — raise "workspace.maxFileBytes" in Settings to allow larger files`,
        )
      }

      const existing = getRow(path)
      const ifMatch = input.ifMatch ?? null
      const now = new Date()
      const hash = sha256(input.content)
      const inlineMaxBytes = q.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES

      if (!existing) {
        // ifMatch is FORBIDDEN when creating (§3.4) — there is nothing yet to compare against.
        if (ifMatch !== null) {
          throw new EnkakuError(
            'E_STALE',
            `"${path}" does not exist yet — ifMatch ("${ifMatch}") only applies when overwriting an existing file`,
            { expected: ifMatch, actual: null },
          )
        }
        const scope = scopeOfPath(path)
        const usage = scopeUsage(scope)
        if (usage.fileCount + 1 > q.maxFilesPerScope) {
          throw new EnkakuError(
            'E_QUOTA',
            `scope "${scope}" already has ${usage.fileCount} files, at the maxFilesPerScope limit of ${q.maxFilesPerScope} — raise "workspace.maxFilesPerScope" in Settings to allow more files`,
          )
        }
        if (usage.totalBytes + size > q.maxTotalBytesPerScope) {
          throw new EnkakuError(
            'E_QUOTA',
            `scope "${scope}" already holds ${usage.totalBytes} bytes; this write would exceed the maxTotalBytesPerScope limit of ${q.maxTotalBytesPerScope} — raise "workspace.maxTotalBytesPerScope" in Settings to allow more`,
          )
        }
        const contentType = input.contentType ?? 'text/plain'
        const driver = driverForWrite(size, contentType, inlineMaxBytes)
        const { locator } = driver.put(input.content, hash)
        db.insert(workspaceFiles)
          .values({
            id: crypto.randomUUID(),
            path,
            content: driver.id === 'inline' ? Buffer.from(input.content) : Buffer.alloc(0),
            contentType,
            size,
            hash,
            storage: driver.id,
            locator: driver.id === 'inline' ? null : locator,
            createdBy: input.actor,
            updatedBy: input.actor,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        return { path, contentType, size, hash, createdBy: input.actor, updatedBy: input.actor, createdAt: toSeconds(now), updatedAt: toSeconds(now) }
      }

      // Overwrite — CAS (acceptance #3, #4).
      if (ifMatch === null) {
        throw new EnkakuError('E_EXISTS', `"${path}" already exists — pass ifMatch with its current hash ("${existing.hash}") to overwrite it`)
      }
      if (ifMatch !== existing.hash) {
        throw new EnkakuError(
          'E_STALE',
          `"${path}" changed since you read it (expected hash "${ifMatch}", current hash "${existing.hash}")`,
          { expected: ifMatch, actual: existing.hash },
        )
      }
      const scope = scopeOfPath(path)
      const usage = scopeUsage(scope)
      const newTotal = usage.totalBytes - existing.size + size
      if (newTotal > q.maxTotalBytesPerScope) {
        throw new EnkakuError(
          'E_QUOTA',
          `scope "${scope}" would hold ${newTotal} bytes, over the maxTotalBytesPerScope limit of ${q.maxTotalBytesPerScope} — raise "workspace.maxTotalBytesPerScope" in Settings to allow more`,
        )
      }
      const contentType = input.contentType ?? existing.contentType
      // Overwriting NEVER touches the OLD blob (if any) — an overwrite that moves a file off `fs`,
      // or onto a new hash, orphans the previous locator exactly like the crash case §8 already
      // names ("wasted disk, never a wrong answer"); only `delete()` below reclaims one, and only
      // once nothing else references it.
      const driver = driverForWrite(size, contentType, inlineMaxBytes)
      const { locator } = driver.put(input.content, hash)
      db.update(workspaceFiles)
        .set({
          content: driver.id === 'inline' ? Buffer.from(input.content) : Buffer.alloc(0),
          contentType,
          size,
          hash,
          storage: driver.id,
          locator: driver.id === 'inline' ? null : locator,
          updatedBy: input.actor,
          updatedAt: now,
        })
        .where(eq(workspaceFiles.id, existing.id))
        .run()
      return { path, contentType, size, hash, createdBy: existing.createdBy, updatedBy: input.actor, createdAt: toSeconds(existing.createdAt), updatedAt: toSeconds(now) }
    },

    delete(pathRaw, input) {
      const path = normaliseWorkspacePath(pathRaw)
      const existing = getRow(path)
      if (!existing) throw new EnkakuError('E_NOT_FOUND', `no such workspace file: ${path}`)
      const ifMatch = input?.ifMatch ?? null
      if (ifMatch !== null && ifMatch !== existing.hash) {
        throw new EnkakuError(
          'E_STALE',
          `"${path}" changed since you read it (expected hash "${ifMatch}", current hash "${existing.hash}")`,
          { expected: ifMatch, actual: existing.hash },
        )
      }
      db.delete(workspaceFiles).where(eq(workspaceFiles.id, existing.id)).run()

      // Refcounted unlink (plan 115 §3.3) — the row is ALREADY gone above, so this query sees only
      // the OTHER rows. `inline` never reaches here: its `delete()` is a no-op and its bytes died
      // with the row just removed.
      if (existing.storage !== 'inline' && existing.locator) {
        const stillReferenced = db
          .select({ id: workspaceFiles.id })
          .from(workspaceFiles)
          .where(and(eq(workspaceFiles.storage, existing.storage), eq(workspaceFiles.locator, existing.locator)))
          .get()
        if (!stillReferenced) {
          try {
            driverFor(existing.storage).delete(existing.locator)
          } catch (err) {
            // An orphaned blob wastes a byte; a row that survives a delete the operator asked for
            // is a bug (§3.3) — so a failed unlink is logged, never thrown.
            log.warn(`failed to unlink workspace content for "${path}" (storage=${existing.storage}, locator=${existing.locator})`, {
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    },

    move(fromRaw, toRaw, input) {
      const from = normaliseWorkspacePath(fromRaw)
      const to = normaliseWorkspacePath(toRaw)
      const source = getRow(from)
      if (!source) throw new EnkakuError('E_NOT_FOUND', `no such workspace file: ${from}`)
      if (input.ifMatch !== source.hash) {
        throw new EnkakuError(
          'E_STALE',
          `"${from}" changed since you read it (expected hash "${input.ifMatch}", current hash "${source.hash}")`,
          { expected: input.ifMatch, actual: source.hash },
        )
      }
      if (getRow(to)) throw new EnkakuError('E_EXISTS', `"${to}" already exists — move refuses to overwrite it`)

      const destScope = scopeOfPath(to)
      if (destScope !== scopeOfPath(from)) {
        const q = quotas()
        const usage = scopeUsage(destScope)
        if (usage.fileCount + 1 > q.maxFilesPerScope) {
          throw new EnkakuError(
            'E_QUOTA',
            `scope "${destScope}" already has ${usage.fileCount} files, at the maxFilesPerScope limit of ${q.maxFilesPerScope} — raise "workspace.maxFilesPerScope" in Settings to allow more files`,
          )
        }
        if (usage.totalBytes + source.size > q.maxTotalBytesPerScope) {
          throw new EnkakuError(
            'E_QUOTA',
            `scope "${destScope}" already holds ${usage.totalBytes} bytes; this move would exceed the maxTotalBytesPerScope limit of ${q.maxTotalBytesPerScope} — raise "workspace.maxTotalBytesPerScope" in Settings to allow more`,
          )
        }
      }

      const now = new Date()
      const updatedBy = input.actor ?? null
      db.update(workspaceFiles).set({ path: to, updatedBy, updatedAt: now }).where(eq(workspaceFiles.id, source.id)).run()
      return {
        path: to,
        contentType: source.contentType,
        size: source.size,
        hash: source.hash,
        createdBy: source.createdBy,
        updatedBy,
        createdAt: toSeconds(source.createdAt),
        updatedAt: toSeconds(now),
      }
    },

    grep(prefixRaw, pattern) {
      const prefix = normaliseScopePrefix(prefixRaw)
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        // An unparseable pattern finds nothing rather than throwing — the caller (a model, most
        // often) can retry with a different pattern; matches the harness's own `grepEntries`
        // behaviour (`packages/harness/src/vfs/types.ts`) so `EnkakuVFS` needs no special case.
        return { hits: [], truncated: false }
      }
      const rows = [...scanUnder(prefix)].sort((a, b) => a.path.localeCompare(b.path))
      const hits: WorkspaceGrepHit[] = []
      let truncated = false
      for (const row of rows) {
        if (truncated) break
        const text = new TextDecoder().decode(row.content) // best-effort; a binary file just won't match anything sensible
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue
          if (hits.length >= GREP_MAX_HITS) {
            truncated = true
            break
          }
          hits.push({ path: row.path, line: i + 1, text: lines[i]! })
        }
      }
      return { hits, truncated }
    },
  }
}
