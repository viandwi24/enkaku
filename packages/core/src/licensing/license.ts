import { join } from 'node:path'
import { z } from 'zod'
import type { Logger } from '../util/logger'
import { limitsFor, type Edition, type EditionLimits } from './editions'

/**
 * Offline licence verification (plan 10 §4.3): the licence file holds a payload of
 * JSON plus an Ed25519 signature. The core only holds the public key, so
 * verification needs no activation server (no phone-home).
 */

export const LicensePayloadSchema = z.object({
  licenseId: z.string(),
  edition: z.enum(['community', 'pro', 'enterprise']),
  licensedTo: z.string(),
  seats: z.number().int().min(1).nullable(),
  issuedAt: z.number().int(),
  /** Unix seconds; null means perpetual. */
  expiresAt: z.number().int().nullable(),
})
export type LicensePayload = z.infer<typeof LicensePayloadSchema>

export const LicenseFileSchema = z.object({
  payload: LicensePayloadSchema,
  /** base64 Ed25519 signature over JSON.stringify(payload). */
  signature: z.string(),
})

export interface LicenseStatus {
  edition: Edition
  limits: EditionLimits
  valid: boolean
  reason?: string
  payload?: LicensePayload
}

const COMMUNITY: LicenseStatus = {
  edition: 'community',
  limits: limitsFor('community'),
  valid: true,
  reason: 'no licence file — community edition',
}

/**
 * The release public key (base64 SPKI). Filled in at the first release; until
 * then any licence counts as unverified and the core falls back to community.
 */
const LICENSE_PUBLIC_KEY_B64 = process.env.ENKAKU_LICENSE_PUBKEY ?? ''

export async function loadLicense(dataDir: string, log: Logger): Promise<LicenseStatus> {
  const path = process.env.ENKAKU_LICENSE_FILE ?? join(dataDir, 'license.json')
  const file = Bun.file(path)
  if (!(await file.exists())) return COMMUNITY

  const parsed = LicenseFileSchema.safeParse(await file.json().catch(() => null))
  if (!parsed.success) {
    log.warn(`the licence file is unreadable or malformed — falling back to community (${path})`)
    return { ...COMMUNITY, reason: 'invalid licence file' }
  }

  if (!LICENSE_PUBLIC_KEY_B64) {
    log.warn('the licence public key is not set — licences cannot be verified, using community')
    return { ...COMMUNITY, reason: 'no licence public key in this build' }
  }

  const verified = await verifySignature(parsed.data.payload, parsed.data.signature)
  if (!verified) {
    log.warn('the licence signature does not match — the file may have been altered; using community')
    return { ...COMMUNITY, reason: 'invalid licence signature' }
  }

  const { payload } = parsed.data
  if (payload.expiresAt !== null && payload.expiresAt * 1000 < Date.now()) {
    log.warn(`the licence expired (${new Date(payload.expiresAt * 1000).toISOString()}) — using community`)
    return { ...COMMUNITY, reason: 'the licence has expired', payload }
  }

  log.info(`verified ${payload.edition} licence for ${payload.licensedTo}`)
  return { edition: payload.edition, limits: limitsFor(payload.edition), valid: true, payload }
}

async function verifySignature(payload: LicensePayload, signatureB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      Buffer.from(LICENSE_PUBLIC_KEY_B64, 'base64'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      Buffer.from(signatureB64, 'base64'),
      new TextEncoder().encode(JSON.stringify(payload)),
    )
  } catch {
    return false
  }
}
