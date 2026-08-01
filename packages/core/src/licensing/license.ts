import { join } from 'node:path'
import { z } from 'zod'
import type { Logger } from '../util/logger'
import { limitsFor, type Edition, type EditionLimits } from './editions'

/**
 * Verifikasi lisensi offline (plan 10 §4.3): file lisensi berisi payload
 * JSON + signature Ed25519. Core hanya memegang public key, jadi verifikasi
 * tidak butuh server aktivasi (no phone-home).
 */

export const LicensePayloadSchema = z.object({
  licenseId: z.string(),
  edition: z.enum(['community', 'pro', 'enterprise']),
  licensedTo: z.string(),
  seats: z.number().int().min(1).nullable(),
  issuedAt: z.number().int(),
  /** Unix detik; null = perpetual. */
  expiresAt: z.number().int().nullable(),
})
export type LicensePayload = z.infer<typeof LicensePayloadSchema>

export const LicenseFileSchema = z.object({
  payload: LicensePayloadSchema,
  /** base64 signature Ed25519 atas JSON.stringify(payload). */
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
  reason: 'tanpa file lisensi — edisi community',
}

/**
 * Public key rilis (base64 SPKI). Diisi saat rilis pertama; sampai itu
 * lisensi apa pun dianggap tidak terverifikasi dan core jatuh ke community.
 */
const LICENSE_PUBLIC_KEY_B64 = process.env.ENKAKU_LICENSE_PUBKEY ?? ''

export async function loadLicense(dataDir: string, log: Logger): Promise<LicenseStatus> {
  const path = process.env.ENKAKU_LICENSE_FILE ?? join(dataDir, 'license.json')
  const file = Bun.file(path)
  if (!(await file.exists())) return COMMUNITY

  const parsed = LicenseFileSchema.safeParse(await file.json().catch(() => null))
  if (!parsed.success) {
    log.warn(`file lisensi tidak terbaca/format salah — jatuh ke community (${path})`)
    return { ...COMMUNITY, reason: 'file lisensi tidak valid' }
  }

  if (!LICENSE_PUBLIC_KEY_B64) {
    log.warn('public key lisensi belum di-set — lisensi tidak bisa diverifikasi, memakai community')
    return { ...COMMUNITY, reason: 'public key lisensi belum tersedia di build ini' }
  }

  const verified = await verifySignature(parsed.data.payload, parsed.data.signature)
  if (!verified) {
    log.warn('signature lisensi tidak cocok — file mungkin diubah; memakai community')
    return { ...COMMUNITY, reason: 'signature lisensi tidak valid' }
  }

  const { payload } = parsed.data
  if (payload.expiresAt !== null && payload.expiresAt * 1000 < Date.now()) {
    log.warn(`lisensi kedaluwarsa (${new Date(payload.expiresAt * 1000).toISOString()}) — memakai community`)
    return { ...COMMUNITY, reason: 'lisensi kedaluwarsa', payload }
  }

  log.info(`lisensi ${payload.edition} untuk ${payload.licensedTo} terverifikasi`)
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
