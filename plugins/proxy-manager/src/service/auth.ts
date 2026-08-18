import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Listener-side authentication — plan 117 §3.5, §4.4.
 *
 * ## Why this exists now, and did not before
 *
 * `listen-socks5.ts` used to say the choice was made together with the bind
 * rule: an unauthenticated proxy reachable off-host is an open relay, so v1
 * shipped loopback-only and offered no credential at all. Plan 117 makes the
 * bind rule conditional on its own premise instead (§3.5) — a non-loopback
 * bind is permitted **only** for a record that can prove who is dialling
 * it — which means the proof has to exist before the rule can be relaxed.
 * This file is that proof: a credential type, a comparison that does not leak
 * through timing, and the two wire formats a client presents it in. The bind
 * gate itself opens in a later step (117.7), deliberately after this one — see
 * plan 117 §3.5's ordering rule and §8's first risk row.
 *
 * ## Constant-time, and why hashing rather than padding
 *
 * `node:crypto`'s `timingSafeEqual` requires both buffers to be the same
 * length and throws otherwise. Comparing two strings of unknown, possibly
 * different lengths directly would mean branching on whether the lengths
 * already match before the constant-time comparison even runs — which leaks
 * the secret's length. Hashing both sides to a fixed-length digest first (the
 * same technique `packages/core/src/notify/webhook.ts` uses for a signature,
 * generalised here to values that are not already fixed-length hex) removes
 * that branch: `timingSafeEqual` always compares two 32-byte buffers, whatever
 * the inputs were.
 */

export interface ListenerCredential {
  username: string
  password: string
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = createHash('sha256').update(a, 'utf8').digest()
  const bufB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(bufA, bufB)
}

/**
 * Whether `candidate` is the credential a listener was configured with.
 *
 * Both fields are always compared — never short-circuited on the username —
 * so a wrong username and a wrong password take the same path and the same
 * time to refuse.
 */
export function credentialMatches(candidate: ListenerCredential, expected: ListenerCredential): boolean {
  const usernameOk = constantTimeEqual(candidate.username, expected.username)
  const passwordOk = constantTimeEqual(candidate.password, expected.password)
  return usernameOk && passwordOk
}

// ---------------------------------------------------------------------------
// HTTP — RFC 7617 Basic authentication: `407 Proxy Authentication Required`
// plus `Proxy-Authenticate` on the way out, `Proxy-Authorization` on the way
// in. `listen-http.ts` is the only caller.
// ---------------------------------------------------------------------------

/** The `Proxy-Authenticate` header value `listen-http.ts` sends with every `407`. */
export const PROXY_AUTHENTICATE_HEADER = 'Basic realm="proxy-manager"'

/** `{ username, password }` → the value that follows `Proxy-Authorization: `. Exported for the wire-format test this step leaves for 117.11. */
export function basicAuthHeaderValue(credential: ListenerCredential): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`
}

/** A `Proxy-Authorization` header's value → the credential it carries, or `null` for anything that is not a well-formed `Basic` credential. */
export function parseBasicAuthHeader(headerValue: string): ListenerCredential | null {
  const match = /^Basic\s+(\S+)$/i.exec(headerValue.trim())
  if (!match || !match[1]) return null
  let decoded: string
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return null
  }
  const sep = decoded.indexOf(':')
  if (sep === -1) return null
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) }
}

// ---------------------------------------------------------------------------
// SOCKS5 — RFC 1929's username/password sub-negotiation. Its own version byte
// is 0x01, not the RFC 1928 handshake's 0x05 — the detail plan 117 §4.4 calls
// out because a straight read of "SOCKS5" gets it wrong. `listen-socks5.ts`
// is the only caller.
// ---------------------------------------------------------------------------

const AUTH_VERSION = 0x01

/** RFC 1929 §2 status octets. */
export const AUTH_STATUS_SUCCESS = 0x00
export const AUTH_STATUS_FAILURE = 0x01

export interface Socks5AuthRequest {
  credential: ListenerCredential
  /** Total bytes consumed, so the caller knows where the CONNECT request begins. */
  length: number
}

/**
 * Parse `[VER][ULEN][UNAME][PLEN][PASSWD]`, or report that more bytes are
 * needed. Exported and pure, the same discipline `listen-socks5.ts`'s own
 * `parseSocks5Greeting`/`parseSocks5Request` follow: a hand-written protocol
 * parser is where this actually goes wrong, and it deserves a test that does
 * not need a socket.
 */
export function parseSocks5AuthRequest(buf: Buffer): { kind: 'need-more' } | { kind: 'bad' } | { kind: 'ok'; request: Socks5AuthRequest } {
  if (buf.length < 2) return { kind: 'need-more' }
  if (buf[0] !== AUTH_VERSION) return { kind: 'bad' }
  const ulen = buf[1] ?? 0
  if (buf.length < 2 + ulen + 1) return { kind: 'need-more' }
  const plen = buf[2 + ulen] ?? 0
  const total = 2 + ulen + 1 + plen
  if (buf.length < total) return { kind: 'need-more' }
  const username = buf.subarray(2, 2 + ulen).toString('utf8')
  const password = buf.subarray(3 + ulen, total).toString('utf8')
  return { kind: 'ok', request: { credential: { username, password }, length: total } }
}

/** `[0x01, 0x00]` for success, `[0x01, 0x01]` for failure. The caller closes the socket after writing a failure — RFC 1929 does not define what follows it. */
export function socks5AuthReply(ok: boolean): Buffer {
  return Buffer.from([AUTH_VERSION, ok ? AUTH_STATUS_SUCCESS : AUTH_STATUS_FAILURE])
}
