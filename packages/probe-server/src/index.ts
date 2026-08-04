#!/usr/bin/env bun
/**
 * The self-hosted probe endpoint (Plan 51 §4.3, §5.3) — see ../README.md for how to host it
 * (DNS delegation, ports/privilege, TLS). Entry point:
 *
 *   bun run packages/probe-server/src/index.ts
 *
 * or `bun run probe-server` from the repo root.
 */
import { startDnsServer } from './dns'
import { createProbeHandler } from './http'
import { httpUpstreamLocationSource, unconfiguredLocationSource, type LocationSource } from './location-source'

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

const httpPort = Number(env('PROBE_HTTP_PORT') ?? 8080)
const httpBind = env('PROBE_BIND') ?? '0.0.0.0'
const dnsZone = env('PROBE_DNS_ZONE')
const publicIpv4 = env('PROBE_PUBLIC_IPV4')
const dnsPort = Number(env('PROBE_DNS_PORT') ?? 53)
const dnsBind = env('PROBE_DNS_BIND') ?? '0.0.0.0'
const geoUpstreamUrl = env('PROBE_GEOIP_UPSTREAM_URL')
const trustProxyHeader = env('PROBE_TRUST_PROXY_HEADER') === '1'

function log(msg: string): void {
  console.log(`[probe-server] ${msg}`)
}

const location: LocationSource = geoUpstreamUrl ? httpUpstreamLocationSource(geoUpstreamUrl) : unconfiguredLocationSource
if (!geoUpstreamUrl) {
  log('PROBE_GEOIP_UPSTREAM_URL is not set — /geo will answer every field as unknown. See README.md to plug in a location source.')
}

const dns =
  dnsZone && publicIpv4
    ? await startDnsServer({ zone: dnsZone, publicIpv4, port: dnsPort, bindAddress: dnsBind, onLog: log })
    : undefined
if (dnsZone && !publicIpv4) {
  log('PROBE_DNS_ZONE is set but PROBE_PUBLIC_IPV4 is not — the DNS responder was NOT started. /resolver/:nonce will report nothing.')
} else if (!dnsZone) {
  log('PROBE_DNS_ZONE is not set — the dns check stays skip for every farm pointed at this server. See README.md to enable it.')
} else {
  log(`authoritative DNS responder listening on ${dnsBind}:${dnsPort} for *.${dnsZone}`)
}

const handle = createProbeHandler({
  location,
  dns,
  onLog: log,
  ...(trustProxyHeader
    ? {
        clientAddress: (req: Request) => {
          const xff = req.headers.get('x-forwarded-for')
          return xff?.split(',')[0]?.trim() || null
        },
      }
    : {}),
})

const server = Bun.serve({
  port: httpPort,
  hostname: httpBind,
  fetch: (req, srv) => handle(req, srv),
})

log(`http listening on ${httpBind}:${httpPort} (probe/geo/resolver/health)`)
if (trustProxyHeader) log('trusting X-Forwarded-For for client address — only correct behind a reverse proxy you control (see README.md)')

process.on('SIGINT', () => {
  server.stop()
  dns?.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  server.stop()
  dns?.close()
  process.exit(0)
})
