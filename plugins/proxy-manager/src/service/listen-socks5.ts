import { createListener, type Listener, type ListenerOptions } from './listener'

/**
 * The SOCKS5 listener — RFC 1928, with RFC 1929's method in the negotiation
 * vocabulary and deliberately not selected.
 *
 * ## Why this ships even though the owner's own case does not need it
 *
 * Plan 112 §3.4: an app on a phone that is going to be pointed at a bridge is
 * far more likely to speak SOCKS5 than the HTTP proxy protocol, and the
 * `vpn-helper` engine the network layer will eventually use is itself a SOCKS5
 * client. Shipping only the HTTP listener would make the payoff of folding
 * this into the farm unreachable, which is the point of the plan.
 *
 * ## Method negotiation, and why NO AUTHENTICATION is the only method offered
 *
 * There is no listener-side authentication in v1, and §3.9 is why: an
 * unauthenticated proxy reachable off-host is an open relay, so the bind is
 * loopback-only and the two questions are settled together (§9 Q2 asks whether
 * to build both). Offering RFC 1929 and then accepting **any** credentials
 * would be worse than not offering it: it would look like authentication.
 *
 * So the greeting is answered with X'00' when the client offers it, and with
 * X'FF' — the RFC's own "no acceptable methods" — when it does not. A client
 * configured with a username and password for the bridge itself offers both
 * X'00' and X'02' and is served; one configured to *require* X'02' is refused
 * by name rather than by a dropped socket.
 *
 * ## BIND and UDP ASSOCIATE
 *
 * Refused with reply X'07', *command not supported* — the RFC's own answer,
 * not a dropped connection (§3.4, criterion 7). `BIND` has no meaning for a
 * bridge. UDP cannot cross `adb reverse` at all (plan 109 §3.4 limit 1), so a
 * UDP association would be a promise the mechanism can never keep.
 */

const VERSION = 0x05

/** RFC 1928 §3 method identifiers. */
export const METHOD_NO_AUTH = 0x00
export const METHOD_USERNAME_PASSWORD = 0x02
export const METHOD_NONE_ACCEPTABLE = 0xff

/** RFC 1928 §4 commands. */
export const CMD_CONNECT = 0x01
export const CMD_BIND = 0x02
export const CMD_UDP_ASSOCIATE = 0x03

/** RFC 1928 §5 address types. */
export const ATYP_IPV4 = 0x01
export const ATYP_DOMAIN = 0x03
export const ATYP_IPV6 = 0x04

/** RFC 1928 §6 reply codes — the ones this listener can produce. */
export const REPLY_SUCCEEDED = 0x00
export const REPLY_GENERAL_FAILURE = 0x01
export const REPLY_CONNECTION_REFUSED = 0x05
export const REPLY_COMMAND_NOT_SUPPORTED = 0x07
export const REPLY_ADDRESS_TYPE_NOT_SUPPORTED = 0x08

/**
 * A reply, with BND.ADDR fixed at `0.0.0.0:0`.
 *
 * The RFC wants the address the server bound on the client's behalf; for a
 * CONNECT through a bridge there is no such address that means anything to the
 * client, and every SOCKS5 proxy in practice answers zeroes. A client that
 * used it would be using a value no implementation supplies.
 */
export function socks5Reply(code: number): Buffer {
  return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

export interface Socks5Request {
  command: number
  atyp: number
  host: string
  port: number
  /** Total bytes consumed, so the caller knows where the tunnel's own bytes begin. */
  length: number
}

/**
 * Parse an RFC 1928 request, or report that more bytes are needed.
 *
 * Exported and pure: every address type and every refusal deserves a test that
 * does not need a socket, and the framing is where a hand-written protocol
 * parser actually goes wrong.
 */
export function parseSocks5Request(buf: Buffer): { kind: 'need-more' } | { kind: 'bad' } | { kind: 'ok'; request: Socks5Request } {
  if (buf.length < 4) return { kind: 'need-more' }
  if (buf[0] !== VERSION) return { kind: 'bad' }
  const command = buf[1] ?? 0
  const atyp = buf[3] ?? 0

  let host: string
  let cursor: number
  if (atyp === ATYP_IPV4) {
    if (buf.length < 10) return { kind: 'need-more' }
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
    cursor = 8
  } else if (atyp === ATYP_DOMAIN) {
    const len = buf[4] ?? 0
    if (buf.length < 5 + len + 2) return { kind: 'need-more' }
    host = buf.subarray(5, 5 + len).toString('utf8')
    cursor = 5 + len
  } else if (atyp === ATYP_IPV6) {
    if (buf.length < 22) return { kind: 'need-more' }
    const groups: string[] = []
    for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(4 + i * 2).toString(16))
    host = groups.join(':')
    cursor = 20
  } else {
    return { kind: 'bad' }
  }

  return { kind: 'ok', request: { command, atyp, host, port: buf.readUInt16BE(cursor), length: cursor + 2 } }
}

/**
 * Parse the greeting, or report that more bytes are needed.
 *
 * `[VER][NMETHODS][METHODS…]`. Returns the method list so the caller decides —
 * the choice of method is policy (see this file's header) and does not belong
 * in a parser.
 */
export function parseSocks5Greeting(buf: Buffer): { kind: 'need-more' } | { kind: 'bad' } | { kind: 'ok'; methods: number[]; length: number } {
  if (buf.length < 2) return { kind: 'need-more' }
  if (buf[0] !== VERSION) return { kind: 'bad' }
  const count = buf[1] ?? 0
  if (buf.length < 2 + count) return { kind: 'need-more' }
  return { kind: 'ok', methods: [...buf.subarray(2, 2 + count)], length: 2 + count }
}

/** A head larger than this before the request is complete is a client that is not speaking SOCKS5. */
const MAX_HANDSHAKE_BYTES = 1024

export function createSocks5Listener(opts: Omit<ListenerOptions, 'writeOverflowRefusal'>): Promise<Listener> {
  return createListener(
    {
      ...opts,
      // Nothing useful can be said: before the greeting there is no protocol
      // state a client would understand, and X'FF' would claim we read a
      // greeting we have not. A cap refusal is logged and the socket closes.
      writeOverflowRefusal: undefined,
    },
    (client, api) => {
      let stage: 'greet' | 'request' | 'done' = 'greet'
      let buf = Buffer.alloc(0)

      function onData(chunk: Buffer): void {
        if (stage === 'done') return
        buf = Buffer.concat([buf, chunk])
        if (buf.length > MAX_HANDSHAKE_BYTES) {
          stage = 'done'
          client.removeListener('data', onData)
          api.refuse('handshake-too-large', { code: 'E_PROXY_CLIENT_PROTOCOL' })
          return
        }

        if (stage === 'greet') {
          const greeting = parseSocks5Greeting(buf)
          if (greeting.kind === 'need-more') return
          if (greeting.kind === 'bad') {
            stage = 'done'
            client.removeListener('data', onData)
            api.refuse('not-socks5', { code: 'E_PROXY_CLIENT_PROTOCOL' })
            return
          }
          if (!greeting.methods.includes(METHOD_NO_AUTH)) {
            stage = 'done'
            client.removeListener('data', onData)
            client.end(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]))
            api.refuse(
              greeting.methods.includes(METHOD_USERNAME_PASSWORD) ? 'listener-auth-not-supported' : 'no-acceptable-method',
              { code: 'E_PROXY_CLIENT_PROTOCOL' },
            )
            return
          }
          buf = buf.subarray(greeting.length)
          stage = 'request'
          client.write(Buffer.from([VERSION, METHOD_NO_AUTH]))
          if (buf.length === 0) return
        }

        const parsed = parseSocks5Request(buf)
        if (parsed.kind === 'need-more') return
        if (parsed.kind === 'bad') {
          stage = 'done'
          client.removeListener('data', onData)
          client.end(socks5Reply(REPLY_ADDRESS_TYPE_NOT_SUPPORTED))
          api.refuse('address-type-not-supported', { code: 'E_PROXY_CLIENT_PROTOCOL' })
          return
        }

        stage = 'done'
        client.removeListener('data', onData)
        const request = parsed.request
        const leftover = buf.subarray(request.length)

        if (request.command !== CMD_CONNECT) {
          client.end(socks5Reply(REPLY_COMMAND_NOT_SUPPORTED))
          api.refuse(request.command === CMD_BIND ? 'bind-not-supported' : 'udp-associate-not-supported', {
            code: 'E_PROXY_CLIENT_PROTOCOL',
            destPort: request.port,
            destHost: request.host,
          })
          return
        }

        api.open(
          { host: request.host, port: request.port },
          {
            onReady: () => client.write(socks5Reply(REPLY_SUCCEEDED)),
            onFailure: (err) => {
              client.end(socks5Reply(err.code === 'E_PROXY_UPSTREAM_UNREACHABLE' ? REPLY_CONNECTION_REFUSED : REPLY_GENERAL_FAILURE))
            },
            leftover,
          },
        )
      }

      client.on('data', onData)
    },
  )
}
