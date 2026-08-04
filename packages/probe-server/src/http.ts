import { GeoObservationSchema, type GeoObservation } from '@enkaku/protocol'
import type { DnsServerHandle } from './dns'
import type { LocationSource } from './location-source'

/**
 * The self-hosted probe endpoint Plan 51 §4.3 describes: three small routes a device (through
 * the tunnel) or the farm host (directly) calls, all answering questions a third-party IP-echo
 * service structurally cannot (Plan 51 §3.3):
 *
 * - `GET /probe` — what source address does this request look like it came from, right now.
 *   This is what `EgressProbe.kt`'s tunnelled leg fetches; `packages/core/src/api/guest-agent.ts`
 *   parses the JSON body for an `ip`/`address`/`origin` field (`summariseEgress()`).
 * - `GET /geo?ip=<address>` — Plan 55's pluggable geo lookup, documented as `network.geoProvider`'s
 *   response shape (`GeoProviderResponseSchema` in `@enkaku/protocol`). Answers with whatever the
 *   configured `LocationSource` can attribute — honestly null per field when it cannot.
 * - `GET /resolver/:nonce` — Plan 51 §5.3's DNS hook: was a query for `<nonce>.<dnsZone>` ever
 *   seen by the DNS responder in `dns.ts`, and from where. One-shot (a sighting is consumed by
 *   the read) since a nonce only ever means anything once.
 * - `GET /health` — plain liveness, for whatever process supervisor is running this.
 *
 * Deliberately NOT built on Hono (unlike the rest of this codebase's HTTP surfaces): the one
 * thing this handler needs that Hono's Bun adapter does not hand over directly is the real TCP
 * peer address, and `Bun.serve`'s own `server.requestIP(req)` gives that with no extra layer to
 * get out of the way of. See the README for why that matters when this sits behind a reverse
 * proxy (it usually should, for TLS).
 */

/** A request nonce (Plan 51 §4.3: "so a cached response cannot be mistaken for a live one") — not a secret, just needs to be unpredictable enough that nobody serves a stale answer under it. */
function makeNonce(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export interface ProbeHttpDeps {
  location: LocationSource
  dns?: DnsServerHandle
  /**
   * Read the real client address off a request. Defaults to `server.requestIP(req)?.address` —
   * the raw TCP peer, trustworthy with no configuration. Overridable so an operator running this
   * behind a reverse proxy that terminates TLS can instead trust `X-Forwarded-For`'s first hop —
   * see the README for why that is a DELIBERATE trust decision, not a default.
   */
  clientAddress?: (req: Request, server: { requestIP(req: Request): { address: string } | null }) => string | null
  onLog?: (msg: string) => void
}

function defaultClientAddress(req: Request, server: { requestIP(req: Request): { address: string } | null }): string | null {
  return server.requestIP(req)?.address ?? null
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
}

export function createProbeHandler(deps: ProbeHttpDeps) {
  const clientAddress = deps.clientAddress ?? defaultClientAddress

  return async function handle(req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') return json({ ok: true })

    if (url.pathname === '/probe') {
      const address = clientAddress(req, server)
      return json({ address, nonce: makeNonce(), at: Math.floor(Date.now() / 1000) })
    }

    if (url.pathname === '/geo') {
      const address = url.searchParams.get('ip') ?? clientAddress(req, server)
      if (!address) return json({ error: 'no address to look up — pass ?ip=, or call this behind a plain connection' }, { status: 400 })
      const fields = await deps.location.lookup(address)
      return json(fields)
    }

    const resolverMatch = /^\/resolver\/([^/]+)$/.exec(url.pathname)
    if (resolverMatch) {
      const nonce = resolverMatch[1] as string
      if (!deps.dns) {
        return json({ nonce, seenFrom: null, at: null, note: 'this probe server was started with no DNS responder — see PROBE_DNS_ZONE in the README' })
      }
      const sighting = deps.dns.takeSighting(nonce)
      return json({ nonce, seenFrom: sighting?.sourceIp ?? null, at: sighting ? Math.floor(sighting.at / 1000) : null })
    }

    return json({ error: 'not found' }, { status: 404 })
  }
}

/**
 * Builds the `GeoObservation` a farm's `network.geoProvider` caller expects from a `/geo`
 * response — exported so a test (or another script) can validate a live response against the
 * exact schema the core's checks parse it with, address/at filled in by the caller.
 */
export function parseGeoResponse(address: string, at: number, body: unknown): GeoObservation {
  const fields = body as { country: string | null; region: string | null; city: string | null; asn: number | null; isp: string | null }
  return GeoObservationSchema.parse({ address, at, ...fields })
}
