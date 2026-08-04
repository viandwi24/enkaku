import type { GeoProviderResponse } from '@enkaku/protocol'

/**
 * Plan 51 §4.3, §5.3 and Plan 55 §3.2: the probe endpoint sees a request's source address, but
 * seeing an address is not the same as knowing its city — that needs a location DATABASE or
 * SERVICE, and hardcoding one vendor here would repeat exactly the mistake Plan 51 §4.1 and Plan
 * 55 §3.1 refuse for geo-targeting syntax. So this is its own seam: `/geo` in `http.ts` calls
 * whatever `LocationSource` this process was built with, and a farm that has not configured one
 * gets an honest "unknown" for every field rather than this file guessing at a vendor.
 */
export interface LocationSource {
  /** Resolves one IP into whatever fields it can attribute — nullable, never guessed, per field. */
  lookup(address: string): Promise<GeoProviderResponse>
}

const UNKNOWN: GeoProviderResponse = { country: null, region: null, city: null, asn: null, isp: null }

/** The honest default: no location source configured, every field unknown. Never a guess. */
export const unconfiguredLocationSource: LocationSource = {
  async lookup(): Promise<GeoProviderResponse> {
    return UNKNOWN
  },
}

/**
 * Adapts a third-party "IP → location" HTTP API into a `LocationSource`, for an operator who
 * would rather point this at an existing service than run a local database. Defaults to
 * ip-api.com's free JSON shape (`{status,country,countryCode,regionName,city,as,isp}`) purely as
 * a reference — nothing about `/geo`'s own contract depends on that vendor, and `fieldsFrom` can
 * be swapped for any other response shape without touching `http.ts`.
 *
 * NOT the recommended production path (rate-limited, third-party, no SLA) — it exists so
 * `PROBE_GEOIP_UPSTREAM_URL` has a working default to point at while evaluating this endpoint,
 * not as an endorsement. A MaxMind-style local database reader is a better fit for real traffic
 * and can be dropped in by implementing `LocationSource` directly — see the README.
 */
export function httpUpstreamLocationSource(
  baseUrl: string,
  fieldsFrom: (body: unknown) => GeoProviderResponse = ipApiDotComFields,
): LocationSource {
  return {
    async lookup(address: string): Promise<GeoProviderResponse> {
      const url = baseUrl.replace('{ip}', encodeURIComponent(address))
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
        if (!res.ok) return UNKNOWN
        return fieldsFrom(await res.json())
      } catch {
        // A failed upstream lookup degrades to "unknown", never a guess (Plan 55 §3.2) — the
        // caller (`http.ts`) is what turns a fully-unknown response into the `geo` check's own
        // `unknown` state; this function itself never throws.
        return UNKNOWN
      }
    },
  }
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function ipApiDotComFields(body: unknown): GeoProviderResponse {
  if (typeof body !== 'object' || body === null) return UNKNOWN
  const rec = body as Record<string, unknown>
  const asMatch = typeof rec.as === 'string' ? /^AS(\d+)/.exec(rec.as) : null
  return {
    country: asNullableString(rec.countryCode) ?? asNullableString(rec.country),
    region: asNullableString(rec.regionName),
    city: asNullableString(rec.city),
    asn: asMatch ? Number(asMatch[1]) : null,
    isp: asNullableString(rec.isp),
  }
}
