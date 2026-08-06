import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { kvEntries, type KvEntryRow } from '../db/schema'
import { decryptNamespacedSecret, encryptNamespacedSecret, secretHint } from '../secrets/store'
import { EnkakuError } from '../util/errors'

/**
 * The durable key/value store (plan 79 §3, §4.1, step 79.3) — global (the
 * whole farm) or device-scoped, namespaced so two plugins picking the key
 * `token` cannot collide, secrets encrypted at rest through
 * `secrets/store.ts`'s existing namespaced AEAD box (no second mechanism
 * invented, §3.4), and compare-and-swap so a concurrent writer learns it
 * lost instead of silently overwriting (§3.5).
 *
 * Every operation here is a plain, SYNCHRONOUS SQLite query — no `await`
 * inside a read-modify-write, so two "concurrent" callers within this one
 * process (the actual concurrency model: every kv call, from every job on
 * every device, funnels through this single core process over IPC/HTTP —
 * there is no second writer touching this file) can never interleave
 * mid-operation. `increment`/`setIfVersion` additionally wrap their
 * read-then-write in `db.transaction()`, so the same guarantee holds even if
 * a future caller opens a second connection onto the same file.
 */

export type KvScope = { kind: 'global' } | { kind: 'device'; stableId: string }

export interface KvEntry {
  key: string
  /** The decrypted plaintext for a secret, exactly like a plain value — `get()` is the ONLY thing
   * that ever calls this decrypted; `list()` never does (see its own comment). Never surfaced by
   * the HTTP API without the caller redacting it first (plan 79 §3.4, §4.4, criterion 4/10). */
  value: unknown
  secret: boolean
  /** Set only when `secret`. */
  hint: string | null
  version: number
  expiresAt: number | null
  updatedAt: number
}

export interface KvSetOptions {
  secret?: boolean
  ttlSec?: number
  /** Informational only — the job that made this write, if any. An addition beyond the plan's
   * own §4.1 `KvSetOptions` shape (which is otherwise unchanged), backing the `updated_by_job_id`
   * column (`db/schema.ts`). */
  updatedByJobId?: string | null
}

export interface KvListQuery {
  prefix?: string
  limit: number
  /** The last key returned by the previous page — plain, not opaque-encoded: a kv key is never
   * sensitive metadata, so there is nothing this needs to hide (a deviation from
   * `api/pagination.ts`'s base64 envelope, recorded here rather than silently — that helper's
   * `Page<T>` also carries a `total` field this store's own `Page<T>` deliberately does not, since
   * counting is not needed by anything that calls this). */
  cursor?: string | null
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface KvQuotas {
  maxValueBytes: number
  maxKeyLength: number
  maxEntriesPerNamespace: number
  maxEntriesPerDevice: number
}

export interface KvStore {
  get(scope: KvScope, namespace: string, key: string): KvEntry | null
  set(scope: KvScope, namespace: string, key: string, value: unknown, opts?: KvSetOptions): KvEntry
  /** `null` = lost the race: `expectedVersion` did not match the stored version (or the key does
   * not exist yet — there is nothing to compare against). The stored value is left unchanged. */
  setIfVersion(scope: KvScope, namespace: string, key: string, value: unknown, expectedVersion: number, opts?: KvSetOptions): KvEntry | null
  increment(scope: KvScope, namespace: string, key: string, by?: number): number
  /** `false` when the key does not exist, OR when `ifVersion` was given and did not match (the
   * caller lost the race) — the same "false = did not happen" reading either way; a caller that
   * needs to tell the two apart can `get()` first. */
  delete(scope: KvScope, namespace: string, key: string, opts?: { ifVersion?: number }): boolean
  /** Immediate keys under `namespace`, sorted ascending — a secret's `value` is ALWAYS `null` here
   * regardless of caller (§3.4, criterion 10): listing is a browsing operation, never a way to
   * discover a secret's plaintext by accident. `get()` is the only path that decrypts. */
  list(scope: KvScope, namespace: string, q: KvListQuery): Page<KvEntry>
  deleteNamespace(scope: KvScope, namespace: string): number
  /** Every value belonging to this device, across every namespace — called by device lifecycle
   * teardown (plan 47 §4.3, plan 79 §3.3, §4.6) inside the SAME transaction that already deletes
   * a forgotten device's jobs/artifacts/events. Returns the count deleted. */
  deleteDevice(stableId: string): number
  sweepExpired(now?: Date): number
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/

function toSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}

function nowSeconds(now?: Date): number {
  return toSeconds(now ?? new Date())
}

function scopeIdOf(scope: KvScope): string {
  return scope.kind === 'device' ? scope.stableId : ''
}

function scopeKindOf(scope: KvScope): 'global' | 'device' {
  return scope.kind
}

function assertValidKey(key: string, maxKeyLength: number): void {
  if (key.length === 0 || key.length > maxKeyLength) {
    throw new EnkakuError('E_KV_KEY_INVALID', `key must be 1-${maxKeyLength} characters, got ${key.length}`)
  }
  if (!KEY_PATTERN.test(key)) {
    throw new EnkakuError('E_KV_KEY_INVALID', `key "${key}" contains a character outside [A-Za-z0-9._:-] — no whitespace, no "/"`)
  }
}

/** Serialises `value` and checks the size cap — measured on the PLAINTEXT JSON, before encryption
 * (the settings' own description, and the honest number a caller can reason about — encryption
 * overhead is not the thing being budgeted). Throws `E_KV_VALUE_TOO_LARGE`, naming both numbers. */
function encodeValue(value: unknown, maxValueBytes: number): { json: string; bytes: number } {
  const json = JSON.stringify(value ?? null)
  const bytes = new TextEncoder().encode(json).length
  if (bytes > maxValueBytes) {
    throw new EnkakuError('E_KV_VALUE_TOO_LARGE', `value is ${bytes} bytes, over the maxValueBytes limit of ${maxValueBytes}`)
  }
  return { json, bytes }
}

function isExpired(row: KvEntryRow, now: number): boolean {
  return row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt <= now
}

function rowToEntry(row: KvEntryRow, dataDir: string): KvEntry {
  const raw = row.secret ? decryptNamespacedSecret(dataDir, 'kv', row.value) : row.value
  return {
    key: row.key,
    value: JSON.parse(raw) as unknown,
    secret: row.secret,
    hint: row.hint,
    version: row.version,
    expiresAt: row.expiresAt ?? null,
    updatedAt: toSeconds(row.updatedAt),
  }
}

/** `list()`'s own row → entry conversion — NEVER decrypts, regardless of caller (criterion 10). */
function rowToListEntry(row: KvEntryRow): KvEntry {
  return {
    key: row.key,
    value: row.secret ? null : (JSON.parse(row.value) as unknown),
    secret: row.secret,
    hint: row.hint,
    version: row.version,
    expiresAt: row.expiresAt ?? null,
    updatedAt: toSeconds(row.updatedAt),
  }
}

export function createKvStore(db: Db, dataDir: string, quotas: () => KvQuotas): KvStore {
  // Every helper below takes an explicit `handle` (defaulting to the outer `db`) rather than
  // closing over `db` directly, so `setIfVersion`/`increment` can pass the `tx` a
  // `db.transaction()` callback receives — real atomicity for their read-then-write, not just
  // "it happens to work because bun:sqlite has one connection" (plan 79 §3.5, criterion 6).
  const getRow = (handle: Db, scope: KvScope, namespace: string, key: string): KvEntryRow | null =>
    handle
      .select()
      .from(kvEntries)
      .where(and(eq(kvEntries.scope, scopeKindOf(scope)), eq(kvEntries.scopeId, scopeIdOf(scope)), eq(kvEntries.namespace, namespace), eq(kvEntries.key, key)))
      .get() ?? null

  const scanNamespace = (handle: Db, scope: KvScope, namespace: string): KvEntryRow[] =>
    handle
      .select()
      .from(kvEntries)
      .where(and(eq(kvEntries.scope, scopeKindOf(scope)), eq(kvEntries.scopeId, scopeIdOf(scope)), eq(kvEntries.namespace, namespace)))
      .all()

  const countDeviceEntries = (handle: Db, stableId: string): number =>
    handle
      .select()
      .from(kvEntries)
      .where(and(eq(kvEntries.scope, 'device'), eq(kvEntries.scopeId, stableId)))
      .all().length

  function writeRow(
    handle: Db,
    scope: KvScope,
    namespace: string,
    key: string,
    value: unknown,
    opts: KvSetOptions | undefined,
    existing: KvEntryRow | null,
  ): KvEntry {
    const q = quotas()
    assertValidKey(key, q.maxKeyLength)
    const { json } = encodeValue(value, q.maxValueBytes)

    if (!existing) {
      const namespaceUsage = scanNamespace(handle, scope, namespace).length
      if (namespaceUsage + 1 > q.maxEntriesPerNamespace) {
        throw new EnkakuError('E_KV_QUOTA_EXCEEDED', `namespace "${namespace}" already has ${namespaceUsage} entries, at the maxEntriesPerNamespace limit of ${q.maxEntriesPerNamespace}`)
      }
      if (scope.kind === 'device') {
        const deviceUsage = countDeviceEntries(handle, scope.stableId)
        if (deviceUsage + 1 > q.maxEntriesPerDevice) {
          throw new EnkakuError('E_KV_QUOTA_EXCEEDED', `device already has ${deviceUsage} kv entries, at the maxEntriesPerDevice limit of ${q.maxEntriesPerDevice}`)
        }
      }
    }

    const secret = opts?.secret ?? false
    const stored = secret ? encryptNamespacedSecret(dataDir, 'kv', json) : json
    const hint = secret ? secretHint(typeof value === 'string' ? value : json) : null
    const now = new Date()
    const expiresAt = opts?.ttlSec !== undefined ? nowSeconds(now) + opts.ttlSec : null
    const version = (existing?.version ?? 0) + 1

    if (!existing) {
      handle
        .insert(kvEntries)
        .values({
          id: crypto.randomUUID(),
          scope: scopeKindOf(scope),
          scopeId: scopeIdOf(scope),
          namespace,
          key,
          value: stored,
          secret,
          hint,
          version,
          expiresAt,
          updatedAt: now,
          updatedByJobId: opts?.updatedByJobId ?? null,
        })
        .run()
    } else {
      handle
        .update(kvEntries)
        .set({ value: stored, secret, hint, version, expiresAt, updatedAt: now, updatedByJobId: opts?.updatedByJobId ?? null })
        .where(eq(kvEntries.id, existing.id))
        .run()
    }

    return { key, value, secret, hint, version, expiresAt, updatedAt: toSeconds(now) }
  }

  return {
    get(scope, namespace, key) {
      const row = getRow(db, scope, namespace, key)
      if (!row) return null
      if (isExpired(row, nowSeconds())) return null
      return rowToEntry(row, dataDir)
    },

    set(scope, namespace, key, value, opts) {
      const existing = getRow(db, scope, namespace, key)
      return writeRow(db, scope, namespace, key, value, opts, existing)
    },

    setIfVersion(scope, namespace, key, value, expectedVersion, opts) {
      return db.transaction((tx) => {
        const existing = getRow(tx, scope, namespace, key)
        if (!existing || existing.version !== expectedVersion) return null
        return writeRow(tx, scope, namespace, key, value, opts, existing)
      })
    },

    increment(scope, namespace, key, by = 1) {
      return db.transaction((tx) => {
        const existing = getRow(tx, scope, namespace, key)
        let current = 0
        if (existing) {
          if (isExpired(existing, nowSeconds())) {
            current = 0
          } else {
            const raw = existing.secret ? decryptNamespacedSecret(dataDir, 'kv', existing.value) : existing.value
            const parsed = JSON.parse(raw) as unknown
            if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
              throw new EnkakuError('E_KV_NOT_NUMBER', `kv key "${key}" does not hold a number — increment refuses to overwrite it`)
            }
            current = parsed
          }
        }
        const next = current + by
        // Expired-and-still-present rows are treated as absent for the quota check too (they read
        // as null already, so a fresh write here is a logical create, not an overwrite).
        const treatedExisting = existing && !isExpired(existing, nowSeconds()) ? existing : null
        writeRow(tx, scope, namespace, key, next, undefined, treatedExisting)
        return next
      })
    },

    delete(scope, namespace, key, opts) {
      const existing = getRow(db, scope, namespace, key)
      if (!existing) return false
      if (opts?.ifVersion !== undefined && existing.version !== opts.ifVersion) return false
      db.delete(kvEntries).where(eq(kvEntries.id, existing.id)).run()
      return true
    },

    list(scope, namespace, q) {
      const now = nowSeconds()
      let rows = scanNamespace(db, scope, namespace).filter((r) => !isExpired(r, now))
      if (q.prefix) rows = rows.filter((r) => r.key.startsWith(q.prefix as string))
      rows.sort((a, b) => a.key.localeCompare(b.key))
      if (q.cursor) rows = rows.filter((r) => r.key > (q.cursor as string))
      const limit = Math.max(1, q.limit)
      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? (page[page.length - 1]?.key ?? null) : null
      return { items: page.map(rowToListEntry), nextCursor }
    },

    deleteNamespace(scope, namespace) {
      const rows = scanNamespace(db, scope, namespace)
      if (rows.length === 0) return 0
      db.delete(kvEntries)
        .where(and(eq(kvEntries.scope, scopeKindOf(scope)), eq(kvEntries.scopeId, scopeIdOf(scope)), eq(kvEntries.namespace, namespace)))
        .run()
      return rows.length
    },

    deleteDevice(stableId) {
      const count = countDeviceEntries(db, stableId)
      if (count === 0) return 0
      db.delete(kvEntries)
        .where(and(eq(kvEntries.scope, 'device'), eq(kvEntries.scopeId, stableId)))
        .run()
      return count
    },

    sweepExpired(now) {
      const cutoff = nowSeconds(now)
      const all = db.select().from(kvEntries).all()
      const expired = all.filter((r) => r.expiresAt !== null && r.expiresAt !== undefined && r.expiresAt <= cutoff)
      for (const row of expired) {
        db.delete(kvEntries).where(eq(kvEntries.id, row.id)).run()
      }
      return expired.length
    },
  }
}

/** The minimum length a decrypted secret must have before `buildSecretRedactor` will match it in a
 * log line (plan 79 §4.7) — below this, the false-positive rate on ordinary text makes the
 * redaction worse than useless (the plan's own reasoning, repeated here). */
const REDACT_MIN_LEN = 8

/**
 * Builds a best-effort text redactor over every SECRET currently readable in `scopes` under
 * `namespace` (plan 79 §4.7) — one call per job log line (`runner-port.ts`'s `redact`), which is
 * why this is bounded (`list`'s own page size) rather than scanning the whole farm. Longest
 * plaintext first, so a secret that happens to be a substring of a longer one is not partially
 * redacted before the longer match gets a chance. Returns the identity function when there is
 * nothing to redact, so a caller with no secrets pays no cost per line beyond one empty `list()`.
 */
export function buildSecretRedactor(store: KvStore, scopes: KvScope[], namespace: string): (text: string) => string {
  const pairs: { key: string; plaintext: string }[] = []
  for (const scope of scopes) {
    const page = store.list(scope, namespace, { limit: 500 })
    for (const item of page.items) {
      if (!item.secret) continue
      const entry = store.get(scope, namespace, item.key)
      if (!entry) continue
      const plaintext = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)
      if (plaintext.length >= REDACT_MIN_LEN) pairs.push({ key: item.key, plaintext })
    }
  }
  if (pairs.length === 0) return (text) => text
  pairs.sort((a, b) => b.plaintext.length - a.plaintext.length)
  return (text) => pairs.reduce((acc, p) => acc.split(p.plaintext).join(`«redacted:${p.key}»`), text)
}
