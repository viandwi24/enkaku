/**
 * Batas per-edisi terpusat (plan 10 §4.3) — SATU tempat, tidak tersebar di
 * kode. Tanpa lisensi = edisi community.
 *
 * Threat model jujur: ini pagar untuk *customer jujur* (kejelasan hak pakai),
 * bukan DRM anti-crack. Tidak ada obfuscation, tidak ada phone-home wajib.
 */
export type Edition = 'community' | 'pro' | 'enterprise'

export interface EditionLimits {
  /** null = tanpa batas. */
  maxDevices: number | null
  maxUsers: number | null
  cloudTunnel: boolean
  prioritySupport: boolean
}

export const EDITION_LIMITS: Record<Edition, EditionLimits> = {
  community: { maxDevices: 5, maxUsers: 2, cloudTunnel: false, prioritySupport: false },
  pro: { maxDevices: 50, maxUsers: 25, cloudTunnel: true, prioritySupport: false },
  enterprise: { maxDevices: null, maxUsers: null, cloudTunnel: true, prioritySupport: true },
}

export function limitsFor(edition: Edition): EditionLimits {
  return EDITION_LIMITS[edition]
}

export function withinDeviceLimit(edition: Edition, deviceCount: number): boolean {
  const max = EDITION_LIMITS[edition].maxDevices
  return max === null || deviceCount <= max
}
