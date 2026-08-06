import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EnkakuError } from '../util/errors'

/**
 * A small NAMESPACED secrets store (plan 65 §4.4), generalising
 * `network/credential-store.ts`'s original design (plan 52 §4.2) so a
 * second kind of caller — connector credentials (plan 65 §3.6) — can share
 * the exact same mechanism as network credentials, under one key file per
 * data directory rather than one per namespace: the honest claim stays
 * IDENTICAL either way ("not readable by grepping the database", not real
 * key management — see the module comment this text is copied from), and
 * splitting the key file per namespace would only multiply the same
 * disclosure without adding anything.
 *
 * `namespace` is folded in as AEAD associated data, so a value encrypted
 * under one namespace label fails to decrypt under another even though both
 * share the same underlying key — a network credential accidentally read
 * back through the connector namespace (or vice versa, from a copy-paste
 * bug) fails loudly (`E_SECRET_CORRUPT`) instead of silently "working".
 *
 * This is NOT a KMS, and does not claim to be one: anyone with read access
 * to the data directory can read the key file sitting right beside
 * `enkaku.db` and decrypt every secret. The honest claim — repeated in
 * `network/credential-store.ts`, `db/schema.ts`, and every place this is
 * surfaced in Studio — is that a secret here is "not readable by grepping
 * the database", nothing stronger.
 */

export type SecretNamespace = 'network' | 'connector' | 'webhook'

const KEY_FILE = 'secrets.key'
/**
 * The file `network/credential-store.ts` used before this module generalised it. Renaming the key
 * file was NOT a rename: on an existing farm `secrets.key` simply did not exist, so the branch
 * below minted a fresh random key and every secret already on disk became undecryptable. Observed
 * in the wild — `applyRoute` failed on every stored upstream, automatic recovery exhausted its
 * bound, and devices sat `held` until an operator retyped the password by hand. The module comment
 * claimed "same key file, same behaviour"; it was a different file, and the behaviour was neither.
 *
 * Kept as a read fallback so an upgraded farm heals instead of losing its secrets.
 */
const LEGACY_KEY_FILE = 'network-credentials.key'
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
    // throws `E_SECRET_KEY_CORRUPT` the first time anything touches the secrets store, rather than
    // failing the whole daemon at boot — every secret encrypted under the original key becomes
    // undecryptable either way, and that is a per-secret problem to surface, not a reason to
    // refuse starting the core.
    if (raw.length !== KEY_BYTES) {
      throw new EnkakuError('E_SECRET_KEY_CORRUPT', `${path} is not a valid ${KEY_BYTES}-byte key file`)
    }
    key = raw
  } else {
    // ADOPT the pre-rename key rather than minting a new one — see `LEGACY_KEY_FILE`. Generating
    // a fresh key here on a farm that already has secrets is not "first use", it is data loss.
    const legacy = legacyKey(dataDir)
    key = legacy ?? randomBytes(KEY_BYTES)
    writeFileSync(path, key, { mode: 0o600 })
    // Belt-and-braces: `writeFileSync`'s `mode` option is not honoured on every platform/umask
    // combination when the file already exists from a previous (failed) run.
    chmodSync(path, 0o600)
  }
  keyCache.set(dataDir, key)
  return key
}

/** The pre-rename key, when a farm still has one and it is well-formed. Never created, only read. */
function legacyKey(dataDir: string): Buffer | null {
  const path = join(dataDir, LEGACY_KEY_FILE)
  if (!existsSync(path)) return null
  const raw = readFileSync(path)
  return raw.length === KEY_BYTES ? raw : null
}

/** Encrypts `plaintext` under `namespace` with the farm key for `dataDir`. Format: `iv.tag.ciphertext`, each segment base64. */
export function encryptNamespacedSecret(dataDir: string, namespace: SecretNamespace, plaintext: string): string {
  const key = loadOrCreateKey(dataDir)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  cipher.setAAD(Buffer.from(namespace, 'utf8'))
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

/**
 * The inverse of `encryptNamespacedSecret`. Throws a coded error on anything malformed, tampered,
 * or decrypted under the wrong namespace — never returns a partial/garbage plaintext.
 *
 * **Reads pre-namespace secrets too.** Before this module existed, `credential-store.ts` wrote the
 * identical `iv.tag.ciphertext` format under the identical key but with **no** AAD. Folding the
 * namespace in as AAD (see this file's header) silently invalidated every one of those: the GCM
 * tag no longer verifies, so `applyRoute` failed on every stored upstream, automatic recovery
 * exhausted its bound, and devices sat `held` until an operator retyped the password by hand —
 * which is exactly how it was reported. The refactor's own comment promised "same key file, same
 * behaviour"; the key file was the same and the behaviour was not.
 *
 * So a failed AAD-verified open falls back to opening it the old way. Callers that can write
 * (`credential-store.ts`) re-encrypt on the way past, so each legacy secret heals once and the
 * fallback stops being reached; nothing is silently downgraded, because the fallback only ever
 * *reads*.
 */
export function decryptNamespacedSecret(dataDir: string, namespace: SecretNamespace, stored: string): string {
  const key = loadOrCreateKey(dataDir)
  const parts = stored.split('.')
  if (parts.length !== 3) throw new EnkakuError('E_SECRET_CORRUPT', 'stored secret is malformed')
  const [ivB64, tagB64, encB64] = parts as [string, string, string]
  const open = (k: Buffer, aad: string | null): string => {
    const decipher = createDecipheriv(ALGO, k, Buffer.from(ivB64, 'base64'))
    if (aad !== null) decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const enc = Buffer.from(encB64, 'base64')
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  }
  try {
    return open(key, namespace)
  } catch (err) {
    // Two independent things changed when this module generalised `credential-store.ts`: the key
    // FILE was renamed (see `LEGACY_KEY_FILE` — the one that actually cost a farm its secrets) and
    // the namespace became AAD. Either alone breaks an existing ciphertext, so every combination
    // is tried before declaring a secret unreadable. Read-only: nothing here re-encrypts.
    const legacy = legacyKey(dataDir)
    for (const [k, aad] of [
      [key, null],
      ...(legacy ? ([[legacy, namespace], [legacy, null]] as const) : []),
    ] as [Buffer, string | null][]) {
      try {
        return open(k, aad)
      } catch {
        // try the next combination
      }
    }
    // Reported against the CURRENT format — the compatibility reads are not the contract, and
    // surfacing one of their errors instead would point at the wrong thing.
    throw new EnkakuError('E_SECRET_CORRUPT', `secret could not be decrypted: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** True when `stored` only opens the pre-namespace way — the signal a caller uses to re-encrypt it once and be done. */
export function isLegacySecret(dataDir: string, namespace: SecretNamespace, stored: string): boolean {
  const parts = stored.split('.')
  if (parts.length !== 3) return false
  try {
    decryptNamespacedSecretStrict(dataDir, namespace, stored)
    return false
  } catch {
    try {
      decryptNamespacedSecret(dataDir, namespace, stored)
      return true
    } catch {
      return false
    }
  }
}

/** `decryptNamespacedSecret` without the legacy fallback — the namespace binding as originally specified. */
function decryptNamespacedSecretStrict(dataDir: string, namespace: SecretNamespace, stored: string): string {
  const key = loadOrCreateKey(dataDir)
  const [ivB64, tagB64, encB64] = stored.split('.') as [string, string, string]
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'))
  decipher.setAAD(Buffer.from(namespace, 'utf8'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8')
}

/** A short, non-reversible hint for display — e.g. `sk-ant-…7Xq2` — never enough to reconstruct the secret. */
export function secretHint(plaintext: string): string {
  if (plaintext.length <= 8) return '••••'
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-4)}`
}

/** Exposed purely so tests can assert the key file name without hardcoding it twice. */
export const SECRETS_KEY_FILE = KEY_FILE
