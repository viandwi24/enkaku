import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices, networkCredentials, type NetworkCredentialRow } from '../db/schema'
import { decryptNamespacedSecret, encryptNamespacedSecret, isLegacySecret } from '../secrets/store'
import { EnkakuError } from '../util/errors'

/**
 * A small named-credential store for `vpn-helper` upstreams (plan 52 §4.2, §5.1), replacing the
 * plaintext `username`/`password` plan 44 stored inline in `devices.network_route`. A secret
 * here is encrypted at rest under the `'network'` namespace of `../secrets/store.ts`'s shared
 * AES-256-GCM store (generalised from this module's own original design by plan 65 §4.4 — same
 * key file, same behaviour, now also used by connector credentials).
 *
 * This is NOT a KMS, and it does not claim to be one: anyone with read access to the data
 * directory can read the key file sitting right beside the database and decrypt every secret.
 * The honest claim — repeated in `devices.network_route`'s schema comment and in Studio — is
 * that a secret here is "not readable by grepping the database", nothing stronger. A farm that
 * needs real secret management should not treat this as one.
 *
 * `encryptSecret`/`decryptSecret` keep their pre-plan-65 signatures (no `namespace` parameter)
 * so every existing call site — `api/guest-agent.ts` chief among them — needs no change; they
 * are thin wrappers pinned to the `'network'` namespace.
 */

/** Encrypts `plaintext` with the farm key for `dataDir`, under the `'network'` namespace. Format: `iv.tag.ciphertext`, each segment base64. Re-codes `E_SECRET_KEY_CORRUPT` back to `E_CREDENTIAL_KEY_CORRUPT` for the same reason `decryptSecret` does below. */
export function encryptSecret(dataDir: string, plaintext: string): string {
  try {
    return encryptNamespacedSecret(dataDir, 'network', plaintext)
  } catch (err) {
    if (err instanceof EnkakuError && err.code === 'E_SECRET_KEY_CORRUPT') {
      throw new EnkakuError('E_CREDENTIAL_KEY_CORRUPT', err.message)
    }
    throw err
  }
}

/**
 * The inverse of `encryptSecret`. Throws a coded error on anything malformed or tampered — never
 * returns a partial/garbage plaintext. Re-codes the shared store's generic `E_SECRET_CORRUPT` /
 * `E_SECRET_KEY_CORRUPT` back to this module's original `E_CREDENTIAL_*` codes, because
 * `api/guest-agent.ts`'s `ERROR_STATUS` map (untouched by plan 65, per the task's constraints)
 * keys on those exact strings.
 */
export function decryptSecret(dataDir: string, stored: string): string {
  try {
    return decryptNamespacedSecret(dataDir, 'network', stored)
  } catch (err) {
    if (err instanceof EnkakuError && err.code === 'E_SECRET_KEY_CORRUPT') {
      throw new EnkakuError('E_CREDENTIAL_KEY_CORRUPT', err.message)
    }
    if (err instanceof EnkakuError && err.code === 'E_SECRET_CORRUPT') {
      throw new EnkakuError('E_CREDENTIAL_CORRUPT', err.message)
    }
    throw err
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
    const password = decryptSecret(dataDir, row.secret)
    // Heals a secret written before plan 65 folded the namespace in as AAD (see
    // `decryptNamespacedSecret`'s own comment for what that broke). Re-encrypting on the first
    // successful legacy read means the fallback is reached once per credential, ever — and a
    // failure here is deliberately swallowed: the caller already HAS the password it asked for,
    // and refusing to route a device because a housekeeping write failed would turn a fixed bug
    // back into the outage it was fixing.
    if (isLegacySecret(dataDir, 'network', row.secret)) {
      try {
        db.update(networkCredentials).set({ secret: encryptSecret(dataDir, password) }).where(eq(networkCredentials.id, row.id)).run()
      } catch {
        // Intentionally ignored — see above.
      }
    }
    return { ...(row.username !== null ? { username: row.username } : {}), password }
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
