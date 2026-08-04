import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices, networkCredentials, type NetworkCredentialRow } from '../db/schema'
import { EnkakuError } from '../util/errors'

/**
 * A small named-credential store for `vpn-helper` upstreams (plan 52 §4.2, §5.1), replacing the
 * plaintext `username`/`password` plan 44 stored inline in `devices.network_route`. A secret
 * here is encrypted at rest with a key derived from a file that lives next to `enkaku.db` in the
 * data directory, created on first use with file mode `0600`.
 *
 * This is NOT a KMS, and it does not claim to be one: anyone with read access to the data
 * directory can read the key file sitting right beside the database and decrypt every secret.
 * The honest claim — repeated in `devices.network_route`'s schema comment and in Studio — is
 * that a secret here is "not readable by grepping the database", nothing stronger. A farm that
 * needs real secret management should not treat this as one.
 */

const KEY_FILE = 'network-credentials.key'
const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32

/** One cached key per data dir — re-reading a 32-byte file off disk on every encrypt/decrypt would be silly, and the key never changes while a process runs. */
const keyCache = new Map<string, Buffer>()

function loadOrCreateKey(dataDir: string): Buffer {
  const cached = keyCache.get(dataDir)
  if (cached) return cached
  const path = join(dataDir, KEY_FILE)
  let key: Buffer
  if (existsSync(path)) {
    const raw = readFileSync(path)
    // A key file that is not exactly 32 bytes is corrupt (truncated write, wrong file) — refusing
    // to use it is safer than silently deriving something from the wrong number of bytes. This
    // throws `E_CREDENTIAL_KEY_CORRUPT` the first time anything touches the credential store,
    // rather than failing the whole daemon at boot — every credential encrypted under the
    // original key becomes undecryptable either way, and that is a per-credential problem to
    // surface, not a reason to refuse starting the core.
    if (raw.length !== KEY_BYTES) {
      throw new EnkakuError('E_CREDENTIAL_KEY_CORRUPT', `${path} is not a valid ${KEY_BYTES}-byte key file`)
    }
    key = raw
  } else {
    key = randomBytes(KEY_BYTES)
    writeFileSync(path, key, { mode: 0o600 })
    // Belt-and-braces: `writeFileSync`'s `mode` option is not honoured on every platform/umask
    // combination when the file already exists from a previous (failed) run.
    chmodSync(path, 0o600)
  }
  keyCache.set(dataDir, key)
  return key
}

/** Encrypts `plaintext` with the farm key for `dataDir`. Format: `iv.tag.ciphertext`, each segment base64. */
export function encryptSecret(dataDir: string, plaintext: string): string {
  const key = loadOrCreateKey(dataDir)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

/** The inverse of `encryptSecret`. Throws a coded error on anything malformed or tampered — never returns a partial/garbage plaintext. */
export function decryptSecret(dataDir: string, stored: string): string {
  const key = loadOrCreateKey(dataDir)
  const parts = stored.split('.')
  if (parts.length !== 3) throw new EnkakuError('E_CREDENTIAL_CORRUPT', 'stored credential is malformed')
  const [ivB64, tagB64, encB64] = parts as [string, string, string]
  try {
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const enc = Buffer.from(encB64, 'base64')
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new EnkakuError('E_CREDENTIAL_CORRUPT', `credential could not be decrypted: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface NetworkCredentialSummary {
  id: string
  name: string
  username?: string
  createdAt: number
  createdBy: string | null
}

function toSummary(row: NetworkCredentialRow): NetworkCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    ...(row.username !== null && row.username !== undefined ? { username: row.username } : {}),
    createdAt: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : 0,
    createdBy: row.createdBy ?? null,
  }
}

export interface CredentialStoreDeps {
  db: Db
  dataDir: string
}

/**
 * CRUD plus resolution over `network_credentials` (plan 52 §4.2). `list()` returns
 * `NetworkCredentialSummary`, which structurally cannot carry a secret — that is what every HTTP
 * handler in `guest-agent.ts` returns to a client. `findByName()` returns the raw row (encrypted
 * `secret` field included) for existence checks and as `create`/`upsert`'s own building block; no
 * call site in this codebase reads `.secret` off its result directly — only `resolve()` below
 * ever decrypts one, and its result must never be persisted, logged, or returned from an HTTP
 * handler.
 */
export function createCredentialStore(deps: CredentialStoreDeps) {
  const { db, dataDir } = deps

  function list(): NetworkCredentialSummary[] {
    return db.select().from(networkCredentials).all().map(toSummary)
  }

  function findByName(name: string): NetworkCredentialRow | null {
    return db.select().from(networkCredentials).where(eq(networkCredentials.name, name)).get() ?? null
  }

  /** A name not already taken, starting from `base` and appending `-2`, `-3`, ... on collision — used by the inline-credential migration, which cannot ask an operator to pick a name. */
  function uniqueName(base: string): string {
    let candidate = base
    let n = 2
    while (findByName(candidate)) {
      candidate = `${base}-${n}`
      n += 1
    }
    return candidate
  }

  function create(input: { name: string; username?: string; secret: string; createdBy?: string | null }): NetworkCredentialSummary {
    if (findByName(input.name)) throw new EnkakuError('E_CREDENTIAL_NAME_TAKEN', `a credential named "${input.name}" already exists`)
    const id = crypto.randomUUID()
    db.insert(networkCredentials)
      .values({
        id,
        name: input.name,
        username: input.username ?? null,
        secret: encryptSecret(dataDir, input.secret),
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
      })
      .run()
    const inserted = db.select().from(networkCredentials).where(eq(networkCredentials.id, id)).get()
    if (!inserted) throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', 'credential vanished immediately after insert')
    return toSummary(inserted)
  }

  /**
   * Creates the named credential if it does not exist, or overwrites its username/secret in
   * place if it does — used for a device's own deterministically-named credential
   * (`device-<id>`, plan 52 §5.1's normalization of an inline `PUT /network` request) so
   * re-submitting inline credentials for the same device updates its one private entry instead
   * of accumulating a fresh orphan on every PUT.
   */
  function upsert(input: { name: string; username?: string; secret: string; createdBy?: string | null }): NetworkCredentialSummary {
    const existing = findByName(input.name)
    if (!existing) return create(input)
    db.update(networkCredentials)
      .set({ username: input.username ?? null, secret: encryptSecret(dataDir, input.secret) })
      .where(eq(networkCredentials.id, existing.id))
      .run()
    const updated = db.select().from(networkCredentials).where(eq(networkCredentials.id, existing.id)).get()
    if (!updated) throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', 'credential vanished immediately after update')
    return toSummary(updated)
  }

  /** Resolves a name into the actual secret — the ONE function in this module that ever returns a decrypted value. Only ever called right before building the wire config for `route.apply()`; the result must never be persisted, logged, or returned from an HTTP handler. */
  function resolve(name: string): { username?: string; password: string } {
    const row = findByName(name)
    if (!row) throw new EnkakuError('E_CREDENTIAL_NOT_FOUND', `no stored credential named "${name}"`)
    return { ...(row.username !== null ? { username: row.username } : {}), password: decryptSecret(dataDir, row.secret) }
  }

  /** Every device whose persisted route currently references `name` — used to refuse deleting a credential still in use (a device would otherwise be left pointing at nothing on its next restore). */
  function devicesUsing(name: string): string[] {
    return db
      .select()
      .from(devices)
      .all()
      .filter((row) => {
        const parsed = row.networkRoute as { config?: { credentialRef?: string } } | null
        return parsed?.config?.credentialRef === name
      })
      .map((row) => row.id)
  }

  function remove(name: string): void {
    const inUse = devicesUsing(name)
    if (inUse.length > 0) {
      throw new EnkakuError('E_CREDENTIAL_IN_USE', `credential "${name}" is still referenced by ${inUse.length} device(s) — remove or repoint their routes first`)
    }
    db.delete(networkCredentials).where(eq(networkCredentials.name, name)).run()
  }

  return { list, findByName, uniqueName, create, upsert, resolve, devicesUsing, remove }
}

export type CredentialStore = ReturnType<typeof createCredentialStore>
