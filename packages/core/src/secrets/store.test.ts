import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { decryptNamespacedSecret, encryptNamespacedSecret, secretHint } from './store'

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'enkaku-secrets-test-'))
}

describe('namespaced secrets store (plan 65 §4.4)', () => {
  test('round-trips a secret under one namespace', () => {
    const dataDir = freshDataDir()
    const stored = encryptNamespacedSecret(dataDir, 'connector', 'sk-ant-abc123')
    expect(decryptNamespacedSecret(dataDir, 'connector', stored)).toBe('sk-ant-abc123')
  })

  test('a wrong key (different data dir) fails to decrypt rather than returning garbage', () => {
    const dataDirA = freshDataDir()
    const dataDirB = freshDataDir()
    const stored = encryptNamespacedSecret(dataDirA, 'connector', 'secret-value')
    expect(() => decryptNamespacedSecret(dataDirB, 'connector', stored)).toThrow()
  })

  test('namespace separation: a value encrypted under "network" cannot be decrypted under "connector"', () => {
    const dataDir = freshDataDir()
    const stored = encryptNamespacedSecret(dataDir, 'network', 'network-secret')
    expect(() => decryptNamespacedSecret(dataDir, 'connector', stored)).toThrow()
    // ...but decrypts fine under its own namespace, in the same data dir.
    expect(decryptNamespacedSecret(dataDir, 'network', stored)).toBe('network-secret')
  })

  test('a malformed stored value throws a coded error, never a partial plaintext', () => {
    const dataDir = freshDataDir()
    expect(() => decryptNamespacedSecret(dataDir, 'connector', 'not-even-three-parts')).toThrow()
  })

  test('secretHint never returns the plaintext, and is stable for the same input', () => {
    const hint = secretHint('sk-ant-api03-abcdefgh7Xq2')
    expect(hint).not.toContain('abcdefgh')
    expect(hint.endsWith('7Xq2')).toBe(true)
    expect(secretHint('sk-ant-api03-abcdefgh7Xq2')).toBe(hint)
  })

  test('secretHint masks short secrets entirely', () => {
    expect(secretHint('short')).toBe('••••')
  })

  /**
   * The regression this module caused on a real farm: generalising `credential-store.ts` renamed
   * the key file AND folded the namespace in as AAD. Neither was migrated, so every secret already
   * on disk stopped opening — `applyRoute` failed on every stored upstream, recovery exhausted its
   * bound, and devices sat `held` until an operator retyped the password by hand.
   */
  describe('pre-plan-65 secrets stay readable', () => {
    /** Exactly what `credential-store.ts` wrote before this module existed: legacy key file, no AAD. */
    function writeLegacySecret(dataDir: string, plaintext: string): Buffer {
      const key = randomBytes(32)
      writeFileSync(join(dataDir, 'network-credentials.key'), key, { mode: 0o600 })
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.from(
        [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.'),
      )
    }

    test('a secret written under the old key file, with no AAD, still decrypts', () => {
      const dataDir = freshDataDir()
      const stored = writeLegacySecret(dataDir, 'hunter2').toString()
      // No `secrets.key` exists yet, so this also exercises adopting the legacy key rather than
      // minting a fresh one — the step whose absence caused the data loss.
      expect(decryptNamespacedSecret(dataDir, 'network', stored)).toBe('hunter2')
    })

    test('...and still decrypts once a NEW key file has already been minted alongside it', () => {
      const dataDir = freshDataDir()
      // Mint `secrets.key` first (a farm that already ran the broken build), THEN drop a legacy
      // secret beside it. The new key cannot open it; the legacy fallback must.
      encryptNamespacedSecret(dataDir, 'connector', 'unrelated')
      const stored = writeLegacySecret(dataDir, 'hunter2').toString()
      expect(decryptNamespacedSecret(dataDir, 'network', stored)).toBe('hunter2')
    })

    test('a genuinely undecryptable value still throws — the fallbacks never invent a plaintext', () => {
      const dataDir = freshDataDir()
      const stored = encryptNamespacedSecret(dataDir, 'connector', 'secret-value')
      const [iv, tag, enc] = stored.split('.') as [string, string, string]
      const tampered = [iv, tag, Buffer.from('different-ciphertext').toString('base64')].join('.')
      expect(() => decryptNamespacedSecret(dataDir, 'connector', tampered)).toThrow()
    })
  })
})
