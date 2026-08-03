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
