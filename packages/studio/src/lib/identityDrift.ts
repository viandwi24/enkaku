import type { DeviceIdentity } from './api'

/**
 * Plan 58 §3.5, §4.6, §5.8 — has the device's identity drifted from what the proxy's most recent
 * exit suggests? One boolean per field, so the panel can point at exactly which one disagrees
 * rather than a single "mismatch" flag (mirrors Plan 55's per-check `RouteCheck[]`, not one
 * collapsed `health`).
 *
 * Deliberately built from the SAME suggestion `POST /identity/sync` already returns, rather than
 * a second copy of the country/city lookup tables in the browser: Studio has no reason to know
 * `US -> America/New_York` itself when the core already computed it for the "sync" button, and
 * duplicating the tables here would be exactly the kind of drift-prone copy CLAUDE.md's
 * "single source of truth" rule warns about. `suggestion` is null when the device has no geo
 * observation yet (`E_NO_GEO_OBSERVATION`) — every field reads as "no drift" in that case, since
 * there is nothing to compare against yet, not evidence of a mismatch.
 */
export interface IdentityDrift {
  timezone: boolean
  locale: boolean
  gps: boolean
}

/** Plan 55 §3.3's own boundary, reused here: only country-level drift is actionable — comparing GPS as an exact match would flag every residential IP's few-km wobble within the same city. A fix more than roughly this many degrees from the suggestion counts as a different place, not noise. */
const GPS_DRIFT_THRESHOLD_DEGREES = 0.5

export function computeIdentityDrift(identity: DeviceIdentity, suggestion: DeviceIdentity | null): IdentityDrift {
  if (!suggestion) return { timezone: false, locale: false, gps: false }

  const timezone = suggestion.timezone !== undefined && identity.timezone !== suggestion.timezone
  const locale = suggestion.locale !== undefined && identity.locale !== suggestion.locale

  let gps = false
  if (suggestion.gps !== undefined) {
    gps = identity.gps === undefined
      || Math.abs(identity.gps.lat - suggestion.gps.lat) > GPS_DRIFT_THRESHOLD_DEGREES
      || Math.abs(identity.gps.lng - suggestion.gps.lng) > GPS_DRIFT_THRESHOLD_DEGREES
  }

  return { timezone, locale, gps }
}

/** True when any field has drifted — the panel's single "show the warning at all" gate. */
export function hasIdentityDrift(drift: IdentityDrift): boolean {
  return drift.timezone || drift.locale || drift.gps
}
