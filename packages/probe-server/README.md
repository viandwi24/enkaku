# probe-server

The self-hosted probe endpoint Plan 51 §4.3 requires: a small farm-controlled service that
answers what a third-party IP-echo site structurally cannot — which resolver actually looked a
name up (real DNS-leak detection), and, paired with Plan 55, a location for an exit address. Its
absence must never become a false `ok`: every check that depends on it (`egress`, `geo`, `dns`)
stays `skip` until it is configured, naming what to set.

This is infrastructure the *farm operator* runs — not the core, not the guest agent, and not
part of `bun run dev`. It is a standalone process, typically on a small public VM, reachable by
devices through their SOCKS5 upstream.

## Run it

```bash
bun run probe-server
# or directly:
bun run packages/probe-server/src/index.ts
```

## What each check needs

| Check | Needs | Env var |
|---|---|---|
| `egress` | `probeUrl` reachable through the tunnel | `network.probeUrl` (core-side, `ENKAKU_NETWORK_PROBE_URL`) → this server's `/probe` |
| `geo` | a location source configured here, and an expectation declared on the route | `PROBE_GEOIP_UPSTREAM_URL` here; `network.geoProvider` (core-side) → this server's `/geo` |
| `dns` | a delegated zone this server is authoritative for | `PROBE_DNS_ZONE` + `PROBE_PUBLIC_IPV4` here; `ENKAKU_NETWORK_PROBE_DNS_ZONE` (core-side) |

The core-side settings live in the farm's own config (`docs/guide/install.md`'s environment
reference) or, for `network.geoProvider`, in **Settings → Network** — they are what tell the core
this server exists at all. This README only covers running the server itself.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PROBE_HTTP_PORT` | `8080` | HTTP port for `/probe`, `/geo`, `/resolver/:nonce`, `/health`. |
| `PROBE_BIND` | `0.0.0.0` | HTTP bind address. |
| `PROBE_DNS_ZONE` | unset | The zone this server is authoritative for, e.g. `dns.probe.example.com`. Unset → the `dns` check stays `skip`. |
| `PROBE_PUBLIC_IPV4` | unset | This server's own public IPv4 — handed back as the A answer for `<nonce>.<zone>` so the device's subsequent HTTP fetch has somewhere real to land. Required alongside `PROBE_DNS_ZONE`. |
| `PROBE_DNS_PORT` | `53` | UDP port for the DNS responder. See "Binding port 53" below. |
| `PROBE_DNS_BIND` | `0.0.0.0` | DNS bind address. |
| `PROBE_GEOIP_UPSTREAM_URL` | unset | A third-party IP→location API URL template (`{ip}` substituted), used as `/geo`'s backing `LocationSource`. Unset → `/geo` answers every field `null`, honestly. Defaults to expecting ip-api.com's free JSON shape; see "Plugging in a location source" to use anything else. |
| `PROBE_TRUST_PROXY_HEADER` | unset (`0`) | `1` to read the client address from `X-Forwarded-For`'s first hop instead of the raw TCP peer. Only correct when a reverse proxy YOU control sets that header and nothing upstream of it can be spoofed — see "Running behind TLS" below. |

## DNS delegation

`dns` only becomes real once your DNS provider delegates a subdomain to this server as its
authoritative nameserver. At your DNS provider (not this app), for a zone `probe.example.com` you
already control:

```
dns.probe.example.com.  NS  <this server's hostname or a glue A record pointing at PROBE_PUBLIC_IPV4>
```

Then set `PROBE_DNS_ZONE=dns.probe.example.com` and `PROBE_PUBLIC_IPV4=<this server's address>`
here, and `ENKAKU_NETWORK_PROBE_DNS_ZONE=dns.probe.example.com` on the core. Once that
propagates, a query for anything under `dns.probe.example.com` reaches this process directly —
never through your provider's own resolvers, which is the whole point: the core builds a
one-time nonce subdomain per check (`<nonce>.dns.probe.example.com`), asks the device to fetch it
through the tunnel, and then asks this server's `/resolver/<nonce>` who actually queried for it.

### Binding port 53

DNS delegation always points at port 53 — a reverse proxy cannot help here, and there is no
"path" the way there is for HTTP. On Linux, either run this process as root (simplest, weakest),
or grant the capability instead of the whole process:

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(which bun)"
```

(that grants it to every `bun` invocation on the host — a dedicated non-root user plus a
container/VM with only this service on it is the safer version of the same idea). In a container
platform that will not grant `CAP_NET_BIND_SERVICE`, run the DNS responder on `PROBE_DNS_PORT`
5353 instead and NAT/forward UDP 53 → 5353 at the host/firewall layer — the responder itself does
not care which port it is told to bind.

## Running behind TLS

`egress.probe`'s request schema (`EgressProbeRequestSchema` in `@enkaku/protocol`) accepts `http:`
or `https:`. Plain HTTP is fine for the `/probe`/`/resolver` round trips — they carry only an
opaque nonce and an IP address, nothing secret — and it is what this README defaults to, because
it sidesteps a real correctness trap: putting a typical HTTP reverse proxy in front for TLS means
the proxy's own IP is what `server.requestIP()` sees here, not the real client's, unless the
proxy is configured to preserve it.

If you want TLS anyway (e.g. `probeUrl` needs to look like a normal HTTPS endpoint for other
reasons), you have two honest options:

1. **Terminate TLS at a TCP-passthrough proxy** that preserves the source address (nginx's
   `stream` module with `proxy_protocol`, or Caddy's `layer4` plugin) — this server does not
   currently parse the PROXY protocol header itself, so a TCP-passthrough front end needs one
   that either forwards the raw TCP connection unmodified or that this process is later taught to
   speak PROXY protocol to.
2. **Terminate TLS at an ordinary HTTP reverse proxy** that sets `X-Forwarded-For`, and set
   `PROBE_TRUST_PROXY_HEADER=1` here. This is a deliberate trust decision: `X-Forwarded-For` is
   trivially spoofable by anyone who can reach this server directly, so this option is only
   correct when the proxy is the ONLY thing allowed to reach `PROBE_HTTP_PORT` (bind this
   process to `127.0.0.1` / a private network, and firewall the rest).

Do not set `PROBE_TRUST_PROXY_HEADER=1` on a server reachable directly from the internet on
`PROBE_HTTP_PORT` — every `egress`/`geo`/`dns` result becomes attacker-controlled the moment that
header can be spoofed.

## Plugging in a location source

`/geo`'s answer comes from whatever `LocationSource` `src/index.ts` was built with
(`src/location-source.ts`):

```ts
export interface LocationSource {
  lookup(address: string): Promise<GeoProviderResponse>  // { country, region, city, asn, isp }, each nullable
}
```

The shipped default (`PROBE_GEOIP_UPSTREAM_URL`) calls a third-party HTTP API per lookup — fine
for evaluating the feature, not recommended for real fleet traffic (rate limits, an external
dependency, no SLA). A local MaxMind GeoLite2 (or any other) database reader is a better fit:
implement `LocationSource` against it and pass that instance to `createProbeHandler()` in
`index.ts` instead of `httpUpstreamLocationSource(...)`. Nothing else in this codebase depends
on which implementation answers `/geo` — `GeoProviderResponseSchema` (`@enkaku/protocol`) is the
only contract the core relies on.

An unconfigured location source (`unconfiguredLocationSource`, the default with no env var set)
answers every field `null` rather than guessing — the core's `geo` check turns a fully-null
response into `unknown`, never a false `pass`.
