import { describe, expect, test } from 'bun:test'
import {
  AUTH_STATUS_FAILURE,
  AUTH_STATUS_SUCCESS,
  PROXY_AUTHENTICATE_HEADER,
  basicAuthHeaderValue,
  credentialMatches,
  parseBasicAuthHeader,
  parseSocks5AuthRequest,
  socks5AuthReply,
} from './auth'

/**
 * Plan 117 step 117.11 — listener-side authentication, §4.4: the two wire
 * formats, in isolation, with no socket. `listen-socks5.test.ts` and
 * `listen-http.test.ts` prove the FOUR client behaviours criterion 6 asks
 * for, end to end through a real listener; this file proves the parsers and
 * the credential comparison they are built on, the same "no hand-written
 * protocol parser reaches a socket untested" discipline the rest of this
 * pack already follows for `listen-socks5.ts`'s own framing.
 */

describe('credentialMatches — constant-time, and both fields checked regardless of which is wrong', () => {
  const expected = { username: 'ops', password: 'super-secret-listener-pass' }

  test('the right pair matches', () => {
    expect(credentialMatches({ username: 'ops', password: 'super-secret-listener-pass' }, expected)).toBe(true)
  })

  test('a wrong username, a wrong password, or both — all refused', () => {
    expect(credentialMatches({ username: 'nope', password: 'super-secret-listener-pass' }, expected)).toBe(false)
    expect(credentialMatches({ username: 'ops', password: 'wrong' }, expected)).toBe(false)
    expect(credentialMatches({ username: 'nope', password: 'wrong' }, expected)).toBe(false)
  })

  test('empty is not a wildcard', () => {
    expect(credentialMatches({ username: '', password: '' }, expected)).toBe(false)
    expect(credentialMatches({ username: '', password: '' }, { username: '', password: '' })).toBe(true)
  })

  test('a username/password pair of very different lengths is still compared correctly (the reason both sides are hashed to a fixed digest first)', () => {
    expect(credentialMatches({ username: 'a', password: 'b' }, { username: 'a-much-longer-username-than-that-one', password: 'b' })).toBe(false)
    expect(credentialMatches({ username: 'a-much-longer-username-than-that-one', password: 'b' }, { username: 'a-much-longer-username-than-that-one', password: 'b' })).toBe(true)
  })
})

describe('HTTP — RFC 7617 Basic (§4.4)', () => {
  test('PROXY_AUTHENTICATE_HEADER names the realm this pack uses on every 407', () => {
    expect(PROXY_AUTHENTICATE_HEADER).toBe('Basic realm="proxy-manager"')
  })

  test('a credential round-trips through the header value', () => {
    const credential = { username: 'ops', password: 'super-secret-listener-pass' }
    const header = basicAuthHeaderValue(credential)
    expect(header).toMatch(/^Basic [A-Za-z0-9+/]+=*$/)
    expect(parseBasicAuthHeader(header)).toEqual(credential)
  })

  test('a colon inside the password survives — the header splits on the FIRST colon only', () => {
    const credential = { username: 'ops', password: 'pa:ss:word' }
    expect(parseBasicAuthHeader(basicAuthHeaderValue(credential))).toEqual(credential)
  })

  test('the header is case-insensitive on the scheme word, and tolerant of surrounding whitespace', () => {
    const value = basicAuthHeaderValue({ username: 'ops', password: 'pw' })
    const encoded = value.slice('Basic '.length)
    expect(parseBasicAuthHeader(`basic ${encoded}`)).toEqual({ username: 'ops', password: 'pw' })
    expect(parseBasicAuthHeader(`  Basic ${encoded}  `)).toEqual({ username: 'ops', password: 'pw' })
  })

  test('anything that is not a well-formed Basic credential is `null`, never a thrown error', () => {
    expect(parseBasicAuthHeader('')).toBeNull()
    expect(parseBasicAuthHeader('Bearer abc123')).toBeNull()
    expect(parseBasicAuthHeader('Basic')).toBeNull()
    // Not valid base64 — `Buffer.from(…, 'base64')` does not throw on this,
    // it decodes leniently, so the `:` check is what actually catches it.
    expect(parseBasicAuthHeader('Basic %%%not-base64%%%')).toBeNull()
    // Valid base64, but no `:` inside once decoded.
    expect(parseBasicAuthHeader(`Basic ${Buffer.from('no-colon-here').toString('base64')}`)).toBeNull()
  })

  test('the plaintext form and the base64 form both carry the credential — neither is scrubbed by this file (that is errors.ts’s job)', () => {
    // Documents the boundary `errors.ts`'s `listenerAuthSecrets` sits on:
    // this module only builds and parses the header; scrubbing it out of a
    // log line or an error message happens one layer up.
    const credential = { username: 'ops', password: 'super-secret-listener-pass' }
    const header = basicAuthHeaderValue(credential)
    expect(header).toContain(Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64'))
  })
})

describe('SOCKS5 — RFC 1929 sub-negotiation, version byte 0x01 (not the 0x05 handshake)', () => {
  function authRequest(username: string, password: string): Buffer {
    const u = Buffer.from(username, 'utf8')
    const p = Buffer.from(password, 'utf8')
    return Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p])
  }

  test('a well-formed request parses, and `length` is where the CONNECT request begins', () => {
    const buf = authRequest('ops', 'super-secret-listener-pass')
    const parsed = parseSocks5AuthRequest(buf)
    expect(parsed).toEqual({ kind: 'ok', request: { credential: { username: 'ops', password: 'super-secret-listener-pass' }, length: buf.length } })
  })

  test('empty username and empty password are both well-formed — refused by `credentialMatches`, not by the parser', () => {
    expect(parseSocks5AuthRequest(authRequest('', ''))).toEqual({ kind: 'ok', request: { credential: { username: '', password: '' }, length: 3 } })
  })

  test('a short buffer asks for more rather than reading past it', () => {
    const full = authRequest('ops', 'super-secret-listener-pass')
    for (let n = 0; n < full.length; n++) expect(parseSocks5AuthRequest(full.subarray(0, n)).kind).toBe('need-more')
    expect(parseSocks5AuthRequest(full).kind).toBe('ok')
  })

  test('a version byte that is not 0x01 is refused rather than guessed at (the 0x05 handshake byte is the classic mistake here)', () => {
    const buf = authRequest('ops', 'pw')
    buf[0] = 0x05
    expect(parseSocks5AuthRequest(buf)).toEqual({ kind: 'bad' })
  })

  test('leftover bytes past the sub-negotiation belong to the CONNECT request that follows it', () => {
    const buf = Buffer.concat([authRequest('ops', 'pw'), Buffer.from([0xde, 0xad, 0xbe, 0xef])])
    const parsed = parseSocks5AuthRequest(buf)
    if (parsed.kind !== 'ok') throw new Error('expected ok')
    expect(buf.subarray(parsed.request.length)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  })

  test('the reply is version 0x01, and the two statuses RFC 1929 §2 defines', () => {
    expect([...socks5AuthReply(true)]).toEqual([0x01, AUTH_STATUS_SUCCESS])
    expect([...socks5AuthReply(false)]).toEqual([0x01, AUTH_STATUS_FAILURE])
    expect(AUTH_STATUS_SUCCESS).toBe(0x00)
    expect(AUTH_STATUS_FAILURE).toBe(0x01)
  })
})
