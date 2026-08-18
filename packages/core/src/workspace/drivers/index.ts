import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The content driver seam (plan 115 §3.1, §4.1) — SQLite keeps the catalogue
 * (`workspace_files`: path, size, hash, content type, `storage`, `locator`),
 * a driver keeps the bytes. `store.ts` decides WHICH driver a write lands on
 * (§3.4) and calls it; it still never touches `node:fs` itself (§3.2, §8's
 * first risk row) — this module is where that property moves TO, not where
 * it disappears.
 *
 * Deliberately synchronous, unlike the plan's own `§4.1` sketch (which shows
 * `Promise`-returning methods so a future `s3` driver reads naturally). Bun
 * ships a complete synchronous `node:fs` and every existing workspace
 * consumer — `capability/fs.ts`, `scripts/build.ts`'s import-graph walk,
 * `api/recordings.ts`, `agent/harness/enkaku-vfs.ts`, `plugins/auto-rebuild.ts`
 * — is built on `WorkspaceStore` being synchronous, the same way the store's
 * own SQLite calls are (`db.select()...get()`, never awaited). Making `put`/
 * `get`/`delete` return real promises would force `read`/`write`/`delete` on
 * `WorkspaceStore` to become `async`, rippling through every one of those
 * files — several of which other steps of this same plan (115.3-115.6) are
 * actively extending. `fs` I/O on a local content-addressed store has no
 * correctness need for async today; when a real `s3` driver is built (§2's
 * explicit non-goal), that is the point to widen the seam, not now. Recorded
 * here, once, rather than silently diverging from the plan's code block.
 */
export interface ContentDriver {
  readonly id: 'inline' | 'fs' | 's3'
  put(content: Uint8Array, hash: string): { locator: string }
  get(locator: string): Uint8Array
  /** The caller (the store) decides whether another row still references
   * `locator` BEFORE calling this — the driver never checks referential
   * integrity itself, it just unlinks what it is told to (§3.3). */
  delete(locator: string): void
}

/**
 * `inline` (plan 115 §3.2) — today's behaviour, expressed as a driver rather
 * than special-cased around. `put` returns the EMPTY locator: the store
 * keeps writing bytes into the row's own `content` column exactly as it
 * always has, so `get`/`delete` are never reached through this driver at
 * all — the store reads/drops `content` directly for an `inline` row. They
 * exist only so `inline` satisfies `ContentDriver` uniformly; calling either
 * would be a bug in the caller (the store), not a legitimate path.
 */
export function createInlineDriver(): ContentDriver {
  return {
    id: 'inline',
    put() {
      return { locator: '' }
    },
    get() {
      throw new Error('inline driver: get() is unreachable — inline content lives in the row, never behind a locator')
    },
    delete() {
      // no-op: nothing to unlink. Inline content is deleted WITH the row.
    },
  }
}

/**
 * `fs` (plan 115 §3.3) — content-addressed at `<root>/<aa>/<sha256>`, where
 * the hash is the one the store already computes for compare-and-swap (W7:
 * not a second hashing pass). Three consequences, all of them the reason for
 * this layout rather than a name-derived path:
 *
 *  - A rename never touches this driver — the store's `move()` only updates
 *    the `path` column, so a rename cannot half-fail with the row and the
 *    disk disagreeing.
 *  - The same bytes written twice land on the same file — `put` is a no-op
 *    once the content address already exists, so two rows can share one
 *    locator.
 *  - No operator-supplied filename is EVER joined to `root` — the only thing
 *    ever joined to it is a hex digest the store computed itself, so path
 *    traversal is structurally absent here rather than defended against.
 */
export function createFsContentDriver(root: string): ContentDriver {
  const pathFor = (hash: string): string => join(root, hash.slice(0, 2), hash)

  return {
    id: 'fs',
    put(content, hash) {
      const dest = pathFor(hash)
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, content)
      }
      return { locator: hash }
    },
    get(locator) {
      return new Uint8Array(readFileSync(pathFor(locator)))
    },
    delete(locator) {
      unlinkSync(pathFor(locator))
    },
  }
}
