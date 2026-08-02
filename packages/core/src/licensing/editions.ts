/**
 * Per-edition limits in one place (plan 10 §4.3) — ONE location, not scattered across
 * the code. No licence means the community edition.
 *
 * An honest threat model: this is a fence for *honest customers* (clarity about
 * what they are entitled to), not anti-crack DRM. No obfuscation, no mandatory
 * phone-home.
 */
export type Edition = 'community' | 'pro' | 'enterprise'

export interface EditionLimits {
  /** null means no limit. */
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
