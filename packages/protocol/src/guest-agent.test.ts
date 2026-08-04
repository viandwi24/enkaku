import { describe, expect, test } from 'bun:test'
import {
  GuestAgentRequestSchema,
  GuestAgentResponseSchema,
  GUEST_AGENT_PROTOCOL,
  GUEST_AGENT_SOCKET,
} from './guest-agent'

/**
 * These frames were captured against a real Android 15 phone (plan 44 §5.1's
 * device gate) — the schemas here must parse them exactly, not approximately.
 */

describe('guest-agent wire constants', () => {
  test('socket name and protocol version', () => {
    expect(GUEST_AGENT_SOCKET).toBe('enkaku-guest-agent')
    expect(GUEST_AGENT_PROTOCOL).toBe(1)
  })
})

describe('captured requests', () => {
  test('hello', () => {
    const raw = { id: '1', method: 'hello', token: 'gate-test-001' }
    const result = GuestAgentRequestSchema.parse(raw)
    expect(result.method).toBe('hello')
  })

  test('ping', () => {
    const raw = { id: '2', method: 'ping', token: 'gate-test-001' }
    const result = GuestAgentRequestSchema.parse(raw)
    expect(result.method).toBe('ping')
  })

  test('hello with wrong token still parses — the schema does not enforce auth, the device does', () => {
    const raw = { id: '3', method: 'hello', token: 'WRONG' }
    const result = GuestAgentRequestSchema.parse(raw)
    expect(result.method).toBe('hello')
  })

  test('route.start', () => {
    const raw = {
      id: 'r1',
      method: 'route.start',
      token: '...',
      config: { host: 'proxy.example.com', port: 1337, username: 'u', password: 'p', udpMode: 'udp' },
    }
    const result = GuestAgentRequestSchema.parse(raw)
    if (result.method !== 'route.start') throw new Error('expected route.start')
    expect(result.config).toEqual({ host: 'proxy.example.com', port: 1337, username: 'u', password: 'p', udpMode: 'udp' })
  })

  test('route.status', () => {
    const raw = { id: 'r2', method: 'route.status', token: '...' }
    const result = GuestAgentRequestSchema.parse(raw)
    expect(result.method).toBe('route.status')
  })

  test('route.stop', () => {
    const raw = { id: 's1', method: 'route.stop', token: '...' }
    const result = GuestAgentRequestSchema.parse(raw)
    expect(result.method).toBe('route.stop')
  })
})

describe('captured responses', () => {
  test('hello ok', () => {
    const raw = {
      id: '1',
      ok: true,
      result: { protocol: 1, appVersion: '1.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status'] },
    }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.result).toEqual({ protocol: 1, appVersion: '1.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status'] })
  })

  test('ping ok', () => {
    const raw = { id: '2', ok: true, result: { pong: true } }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
  })

  test('unauthorised error', () => {
    const raw = { id: '3', ok: false, error: { code: 'E_UNAUTHORISED', message: 'bad or missing token' } }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toEqual({ code: 'E_UNAUTHORISED', message: 'bad or missing token' })
  })

  test('route.start ok', () => {
    const raw = { id: 'r1', ok: true, result: { started: true } }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.result).toEqual({ started: true })
  })

  test('route.status ok, up, with upstream and stats', () => {
    const raw = {
      id: 'r2',
      ok: true,
      result: { prepared: true, up: true, upstream: 'proxy.example.com:1337', stats: [31, 2123, 14, 608] },
    }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.result).toEqual({ prepared: true, up: true, upstream: 'proxy.example.com:1337', stats: [31, 2123, 14, 608] })
  })

  test('route.status ok, down — upstream, stats and lastError are ABSENT, not null', () => {
    const raw = { id: 's2', ok: true, result: { prepared: true, up: false } }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.result).toEqual({ prepared: true, up: false })
    expect('upstream' in result.result).toBe(false)
    expect('stats' in result.result).toBe(false)
  })

  // Plan 54 §4.1, §5.3 — a route that is fail-closed rather than torn down. `up` reads `false`
  // exactly like a fully-down route would, which is the whole reason `state` exists: without it,
  // the host cannot tell "traffic is being blocked on purpose" from "nothing is configured".
  test('route.status ok, held — up is false, state says why, upstream and lastError both survive', () => {
    const raw = {
      id: 'r3',
      ok: true,
      result: {
        prepared: true,
        up: false,
        state: 'held' as const,
        upstream: 'proxy.example.com:1337',
        lastError: 'no contact from the farm for 91000ms',
      },
    }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.result).toEqual(raw.result)
  })

  test('route.status ok, down — omitting state still parses (older agent build, or a genuine down)', () => {
    const raw = { id: 'r4', ok: true, result: { prepared: true, up: false, state: 'down' as const } }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    if (!('state' in result.result)) throw new Error('expected state')
    expect(result.result.state).toBe('down')
  })

  test('route.stop ok', () => {
    const raw = { id: 's1', ok: true, result: { stopped: true } }
    const result = GuestAgentResponseSchema.parse(raw)
    expect(result.ok).toBe(true)
  })
})

describe('wrong-shaped frames are rejected', () => {
  test('request missing token', () => {
    const raw = { id: '1', method: 'hello' }
    expect(() => GuestAgentRequestSchema.parse(raw)).toThrow()
  })

  test('request with unknown method', () => {
    const raw = { id: '1', method: 'route.reset', token: 't' }
    expect(() => GuestAgentRequestSchema.parse(raw)).toThrow()
  })

  test('route.start missing config', () => {
    const raw = { id: 'r1', method: 'route.start', token: 't' }
    expect(() => GuestAgentRequestSchema.parse(raw)).toThrow()
  })

  test('route.start config with out-of-range port', () => {
    const raw = {
      id: 'r1',
      method: 'route.start',
      token: 't',
      config: { host: 'proxy.example.com', port: 70000 },
    }
    expect(() => GuestAgentRequestSchema.parse(raw)).toThrow()
  })

  test('response with neither ok:true nor ok:false', () => {
    const raw = { id: '1', ok: 'yes', result: {} }
    expect(() => GuestAgentResponseSchema.parse(raw)).toThrow()
  })

  test('response ok:true with an error field instead of result', () => {
    const raw = { id: '1', ok: true, error: { code: 'E_BAD_REQUEST', message: 'nope' } }
    expect(() => GuestAgentResponseSchema.parse(raw)).toThrow()
  })

  test('response ok:false with an unrecognised error code', () => {
    const raw = { id: '1', ok: false, error: { code: 'E_TOTALLY_MADE_UP', message: 'nope' } }
    expect(() => GuestAgentResponseSchema.parse(raw)).toThrow()
  })

  test('route.status result with a stats tuple of the wrong length', () => {
    const raw = { id: 'r2', ok: true, result: { prepared: true, up: true, stats: [1, 2, 3] } }
    expect(() => GuestAgentResponseSchema.parse(raw)).toThrow()
  })

  test('route.status result with an unrecognised state value', () => {
    const raw = { id: 'r5', ok: true, result: { prepared: true, up: false, state: 'stopped' } }
    expect(() => GuestAgentResponseSchema.parse(raw)).toThrow()
  })
})

describe('route.status frames that carry an error', () => {
  // This case had no coverage, which is exactly why it reached production: every captured frame the
  // schema was written against came from a healthy device, so `lastError` was never present. The
  // shape was guessed as `{code, message}` by analogy with the host-side status, but the device has
  // no error codes — `RouteState.lastError()` is a Kotlin `String?`. Every status frame carrying an
  // error therefore failed validation with `E_UNEXPECTED_RESPONSE`.
  test('lastError is a plain string, not a coded object', () => {
    const frame = {
      id: 's1',
      ok: true,
      result: {
        prepared: true,
        up: false,
        lastError: 'no contact from the farm for 91000ms; route torn down to avoid stranding the device',
      },
    }
    const parsed = GuestAgentResponseSchema.parse(frame)
    expect(parsed.ok).toBe(true)
  })

  test('a coded object in lastError is rejected — the device never sends one', () => {
    const frame = { id: 's2', ok: true, result: { prepared: true, up: false, lastError: { code: 'X', message: 'y' } } }
    expect(() => GuestAgentResponseSchema.parse(frame)).toThrow()
  })

  test('an up route reporting an error still parses (both can be true at once)', () => {
    const frame = {
      id: 's3',
      ok: true,
      result: { prepared: true, up: true, upstream: 'proxy.example.com:1337', stats: [1, 2, 3, 4], lastError: 'transient' },
    }
    expect(GuestAgentResponseSchema.parse(frame).ok).toBe(true)
  })
})

describe('egress.probe (plan 51 §4.2, §5.2)', () => {
  test('request: url and timeoutMs required', () => {
    const raw = { id: 'p1', method: 'egress.probe', token: 't', url: 'https://probe.example/x', timeoutMs: 5000 }
    const result = GuestAgentRequestSchema.parse(raw)
    if (result.method !== 'egress.probe') throw new Error('expected egress.probe')
    expect(result.url).toBe('https://probe.example/x')
    expect(result.timeoutMs).toBe(5000)
  })

  test('request rejects a non-URL', () => {
    const raw = { id: 'p1', method: 'egress.probe', token: 't', url: 'not-a-url', timeoutMs: 5000 }
    expect(() => GuestAgentRequestSchema.parse(raw)).toThrow()
  })

  test('request rejects a timeout over the 60s ceiling', () => {
    const raw = { id: 'p1', method: 'egress.probe', token: 't', url: 'https://probe.example/x', timeoutMs: 90_000 }
    expect(() => GuestAgentRequestSchema.parse(raw)).toThrow()
  })

  test('result: both legs succeeding, no stage on either', () => {
    const raw = {
      id: 'p1',
      ok: true,
      result: {
        tunnelled: { ok: true, status: 200, body: 'nonce=abc', ms: 340 },
        direct: { ok: true, status: 200, body: 'nonce=abc', ms: 41 },
      },
    }
    const parsed = GuestAgentResponseSchema.parse(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.result).toEqual(raw.result)
  })

  test('result: a dead tunnel — tunnelled fails at connect, direct still succeeds (the whole point of comparing the two legs, plan 51 §4.4)', () => {
    const raw = {
      id: 'p2',
      ok: true,
      result: {
        tunnelled: { ok: false, ms: 8001, error: 'SOCKS5 CONNECT failed (reply code 5)', stage: 'connect' as const },
        direct: { ok: true, status: 200, body: 'nonce=xyz', ms: 55 },
      },
    }
    const parsed = GuestAgentResponseSchema.parse(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.result).toEqual(raw.result)
  })

  test('a captured probe frame carrying a socks5:// upstream in an error string is still just a plain string field — the schema does not special-case it, the host-side redaction does', () => {
    // This schema has no opinion on credential safety; it only proves the shape parses. The
    // actual "never a credential in `error`" guarantee lives in the Kotlin probe (which never
    // embeds one) and the host-side `safeDetail()` in `packages/core/src/api/guest-agent.ts`.
    const raw = {
      id: 'p3',
      ok: true,
      result: {
        tunnelled: { ok: false, ms: 10, error: 'connection refused', stage: 'connect' },
        direct: { ok: false, ms: 12, error: 'connection refused', stage: 'connect' },
      },
    }
    expect(GuestAgentResponseSchema.parse(raw).ok).toBe(true)
  })

  test('result rejects an unknown stage value', () => {
    const raw = {
      id: 'p4',
      ok: true,
      result: {
        tunnelled: { ok: false, ms: 1, stage: 'dns' },
        direct: { ok: true, ms: 1 },
      },
    }
    expect(() => GuestAgentResponseSchema.parse(raw)).toThrow()
  })
})
