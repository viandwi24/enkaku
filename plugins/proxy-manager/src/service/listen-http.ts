import { createListener, type Listener, type ListenerOptions } from './listener'

/**
 * The HTTP proxy listener — `gost -L "http://:9902"`, in about eighty lines.
 *
 * ## An HTTP proxy must serve TWO request forms, and this is the finding that
 * made the feasibility probe fail on its first run
 *
 * Bun's `fetch({ proxy })` — and every real HTTP-proxy client — sends
 * `CONNECT host:port HTTP/1.1` only for **https** targets. For an **http**
 * target it sends **absolute-form**: `GET http://host:port/path HTTP/1.1`. A
 * CONNECT-only bridge answers that with `405`, which means it passes every
 * https test and dies silently on plain http (plan 112 §0.2).
 *
 * So both forms are handled here, they are separate acceptance criteria (§6.4,
 * §6.5) and separate tests, and neither substitutes for the other. Absolute
 * form is served by **rewriting the request line to origin-form** and replaying
 * the rest of the head upstream before piping.
 *
 * ## Two things the probe's forty lines got away with and this cannot
 *
 * 1. **The head can arrive in more than one TCP segment.** The probe reads
 *    `once('data')` and parses whatever turned up. That works on loopback with
 *    a small head and fails on a request with many headers, or a slow client,
 *    or a client that writes the request line and the headers separately —
 *    intermittently, and never in a test. Here the head is accumulated until
 *    `\r\n\r\n`, bounded by `MAX_HEAD_BYTES`.
 * 2. **Bytes past the head belong to the tunnel.** A client may pipeline a
 *    request body, or (rarely) a TLS ClientHello, behind the head in the same
 *    segment. They are handed to `open({ leftover })`, which pushes them back
 *    onto the client before piping. The probe dropped them.
 *
 * ## One limit, stated rather than discovered
 *
 * On the absolute-form path only the FIRST request line is rewritten; after
 * that the connection is a pipe. A client that sends a second absolute-form
 * request for a **different host** on the same connection reaches the first
 * host's origin server. RFC 7230 §5.3.2 requires an origin server to accept
 * absolute-form, so the request is still well-formed — it simply goes
 * somewhere the client did not mean. `gost` behaves the same way in the same
 * mode. Making it correct means parsing every request on the connection and
 * re-dialling per host, which is a real HTTP proxy rather than a bridge, and
 * is not what this plan is.
 */

/** A head larger than this is refused rather than buffered — a client that never sends `\r\n\r\n` must not grow memory. */
const MAX_HEAD_BYTES = 64 * 1024

const CONNECT_LINE = /^CONNECT (\S+):(\d+) HTTP\/1\.[01]$/
const ABSOLUTE_LINE = /^([A-Z]+) http:\/\/([^/?#:\s]+)(?::(\d+))?(\S*) HTTP\/1\.[01]$/

export interface ParsedRequestLine {
  form: 'connect' | 'absolute'
  method: string
  host: string
  port: number
  /** Origin-form target for the rewritten request line. Empty for a CONNECT. */
  target: string
}

/**
 * Parse a proxy request line, or `null` for anything this listener does not
 * serve. Exported because it is the whole of the §0.2 finding and deserves its
 * own test rather than being reachable only through a socket.
 */
export function parseProxyRequestLine(line: string): ParsedRequestLine | null {
  const connect = CONNECT_LINE.exec(line)
  if (connect) {
    const port = Number(connect[2])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    return { form: 'connect', method: 'CONNECT', host: connect[1] ?? '', port, target: '' }
  }
  const absolute = ABSOLUTE_LINE.exec(line)
  if (absolute) {
    const port = absolute[3] === undefined ? 80 : Number(absolute[3])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    return { form: 'absolute', method: absolute[1] ?? 'GET', host: absolute[2] ?? '', port, target: absolute[4] || '/' }
  }
  return null
}

/** The rewritten head an absolute-form request is replayed upstream as. Pure, so the rewrite has a test of its own. */
export function toOriginForm(parsed: ParsedRequestLine, head: string): string {
  const firstBreak = head.indexOf('\r\n')
  const rest = firstBreak === -1 ? '\r\n\r\n' : head.slice(firstBreak)
  return `${parsed.method} ${parsed.target} HTTP/1.1${rest}`
}

export function createHttpListener(opts: Omit<ListenerOptions, 'writeOverflowRefusal'>): Promise<Listener> {
  return createListener(
    {
      ...opts,
      // We know this listener speaks HTTP, so a client turned away by the cap
      // gets an answer it can render instead of a bare RST.
      writeOverflowRefusal: (client) => {
        client.write('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      },
    },
    (client, api) => {
      let head = Buffer.alloc(0)
      let done = false

      function onData(chunk: Buffer): void {
        if (done) return
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) {
          if (head.length > MAX_HEAD_BYTES) {
            done = true
            client.removeListener('data', onData)
            client.end('HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            api.refuse('head-too-large', { code: 'E_PROXY_CLIENT_PROTOCOL' })
          }
          return
        }
        done = true
        client.removeListener('data', onData)

        const headText = head.subarray(0, end + 4).toString('latin1')
        const leftover = head.subarray(end + 4)
        const lineEnd = headText.indexOf('\r\n')
        const parsed = parseProxyRequestLine(lineEnd === -1 ? headText : headText.slice(0, lineEnd))

        if (!parsed) {
          // 405 is the honest answer: this is a proxy, and what arrived is not
          // a proxy request. A browser pointed at it directly lands here.
          client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          api.refuse('not-a-proxy-request', { code: 'E_PROXY_CLIENT_PROTOCOL' })
          return
        }

        api.open(
          { host: parsed.host, port: parsed.port },
          {
            onReady: (upstream) => {
              if (parsed.form === 'connect') {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
              } else {
                upstream.write(toOriginForm(parsed, headText))
              }
            },
            onFailure: () => {
              // No credential and no upstream detail: a 502 body is read by
              // whoever holds the client, which for a device is an app.
              client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            },
            // A CONNECT's leftover is the tunnel's first bytes; an
            // absolute-form request's leftover is its body. Both are the
            // caller's, and both are pushed back rather than dropped.
            leftover,
          },
        )
      }

      client.on('data', onData)
    },
  )
}
