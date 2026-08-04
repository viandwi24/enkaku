/**
 * A minimal authoritative DNS responder — the "authoritative-resolver hook" Plan 51 §4.3, §5.3
 * calls for: "Ask for a unique subdomain per probe and observe which resolver hits your
 * authoritative server. That is real DNS-leak detection... and it is impossible against someone
 * else's endpoint."
 *
 * Only ever authoritative for ONE zone (`opts.zone`, e.g. `dns.probe.example.com`), delegated to
 * this process by the operator's own DNS provider (see the README) — anything outside that zone
 * gets NXDOMAIN, never forwarded or recursed. Not a general-purpose resolver: it understands
 * exactly enough of RFC 1035 to answer an A query for `<nonce>.<zone>` with this server's own
 * configured address, and to record which source IP asked. That is the entire job — a probe
 * fetches `http://<nonce>.<zone>/probe` through the SOCKS5 upstream (`Socks5Client.kt` sends the
 * hostname via SOCKS5's own domain-name ATYP, so the PROXY resolves it, not the device) — if the
 * query that reaches this server comes from the proxy's own network, DNS is not leaking; if it
 * comes from somewhere else entirely (a device's real ISP resolver bypassing the tunnel), that is
 * exactly the leak this exists to catch.
 *
 * Built on `Bun.udpSocket` rather than `node:dgram` — this codebase's Bun-first convention
 * (CLAUDE.md), and it is what has a properly typed surface here (`node:dgram`'s ambient types
 * are incomplete on this toolchain).
 */

const HEADER_LEN = 12
const TYPE_A = 1
const CLASS_IN = 1

interface ParsedQuery {
  id: number
  qname: string
  qtype: number
}

/** Reads the question name/type out of a query datagram. Returns null for anything malformed — never throws into the caller. */
function parseQuery(buf: Buffer): ParsedQuery | null {
  if (buf.length < HEADER_LEN + 5) return null
  const id = buf.readUInt16BE(0)
  const qdcount = buf.readUInt16BE(4)
  if (qdcount < 1) return null

  const labels: string[] = []
  let offset = HEADER_LEN
  while (offset < buf.length) {
    const len = buf[offset]
    if (len === undefined) return null
    if (len === 0) {
      offset += 1
      break
    }
    // No pointer-compression support — a fresh query's own question name is never compressed
    // (there is nothing earlier in the packet to point at), so this is never a real limitation.
    if (len > 0x3f) return null
    offset += 1
    if (offset + len > buf.length) return null
    labels.push(buf.toString('ascii', offset, offset + len))
    offset += len
  }
  if (offset + 4 > buf.length) return null
  const qtype = buf.readUInt16BE(offset)
  return { id, qname: labels.join('.').toLowerCase(), qtype }
}

/**
 * Builds a response for `query`. `answerIpv4` is this server's own address to hand back for an A
 * query under our zone (so the probe's subsequent HTTP fetch has somewhere real to connect to);
 * `null` means NXDOMAIN — either the name is outside our zone, or we have nothing configured to
 * answer with.
 */
function buildResponse(query: ParsedQuery, rawQuestion: Buffer, answerIpv4: string | null): Buffer {
  const header = Buffer.alloc(HEADER_LEN)
  header.writeUInt16BE(query.id, 0)
  const answerable = answerIpv4 !== null && query.qtype === TYPE_A
  // QR=1 (response) AA=1 (authoritative) RCODE=0 (NOERROR) or 3 (NXDOMAIN) when nothing to answer.
  const flags = 0x8400 | (answerIpv4 === null ? 0x0003 : 0x0000)
  header.writeUInt16BE(flags, 2)
  header.writeUInt16BE(1, 4) // QDCOUNT — echo the one question back
  header.writeUInt16BE(answerable ? 1 : 0, 6) // ANCOUNT
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)

  if (!answerable) return Buffer.concat([header, rawQuestion])

  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]), // NAME — a pointer back to the question at offset 12
    Buffer.from([0x00, TYPE_A]),
    Buffer.from([0x00, CLASS_IN]),
    Buffer.from([0x00, 0x00, 0x00, 0x3c]), // TTL 60s — a probe answer is never worth caching longer
    Buffer.from([0x00, 0x04]), // RDLENGTH
    Buffer.from((answerIpv4 as string).split('.').map(Number)),
  ])
  return Buffer.concat([header, rawQuestion, answer])
}

export interface ResolverSighting {
  sourceIp: string
  at: number
}

export interface DnsServerOptions {
  /** The zone this server is authoritative for, e.g. `dns.probe.example.com` — lowercase, no trailing dot. */
  zone: string
  /** This server's own public IPv4 address, handed back as the A answer for `<nonce>.<zone>`. */
  publicIpv4: string
  port?: number
  bindAddress?: string
  /** How long a sighting is kept before it is pruned — default 5 minutes, generous for a check that runs within seconds of issuing the nonce. */
  sightingTtlMs?: number
  onLog?: (msg: string) => void
}

export interface DnsServerHandle {
  /** Looks up (and removes) a recorded sighting for `nonce` — one-shot, since a nonce is single-use by construction. */
  takeSighting(nonce: string): ResolverSighting | null
  close(): void
}

/**
 * Starts the authoritative responder. Binding UDP/53 needs root or `CAP_NET_BIND_SERVICE` on
 * Linux — see the README for how operators typically handle that (a reverse proxy cannot help
 * here; DNS delegation always points at port 53).
 */
export async function startDnsServer(opts: DnsServerOptions): Promise<DnsServerHandle> {
  const zone = opts.zone.toLowerCase().replace(/\.$/, '')
  const sightingTtlMs = opts.sightingTtlMs ?? 5 * 60_000
  const sightings = new Map<string, ResolverSighting>()
  const zoneSuffix = `.${zone}`

  const socket = await Bun.udpSocket({
    hostname: opts.bindAddress ?? '0.0.0.0',
    port: opts.port ?? 53,
    socket: {
      data(sock, data, port, address) {
        const query = parseQuery(data)
        if (!query) return // malformed — silently dropped, never worth a reply
        const rawQuestion = data.subarray(HEADER_LEN, data.length)

        const inZone = query.qname === zone || query.qname.endsWith(zoneSuffix)
        if (inZone) {
          const nonce = query.qname === zone ? '' : query.qname.slice(0, query.qname.length - zoneSuffix.length)
          if (nonce) {
            sightings.set(nonce, { sourceIp: address, at: Date.now() })
            opts.onLog?.(`resolver sighting: ${nonce} queried by ${address}`)
          }
        }

        const response = buildResponse(query, rawQuestion, inZone ? opts.publicIpv4 : null)
        sock.send(response, port, address)
      },
      error(_sock, err) {
        opts.onLog?.(`dns socket error, tolerated: ${String(err)}`)
      },
    },
  })

  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - sightingTtlMs
    for (const [nonce, sighting] of sightings) {
      if (sighting.at < cutoff) sightings.delete(nonce)
    }
  }, 60_000)
  pruneTimer.unref?.()

  return {
    takeSighting(nonce) {
      const found = sightings.get(nonce) ?? null
      if (found) sightings.delete(nonce)
      return found
    },
    close() {
      clearInterval(pruneTimer)
      socket.close()
    },
  }
}
