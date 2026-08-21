import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import { deriveCoreAddress, parseHostPort } from './core-address'

/**
 * Plan 122 §5 step 122.12 fix (2): "derive the address the device reaches
 * the core at" rather than templating it. Tested against a FAKE socket
 * (`connect` is injectable) rather than a real TCP connection — the
 * behaviour under test is "read `socket.localAddress` at `connect`, never
 * later" (plan 123 §0.3's own finding, reused here), which a fake socket can
 * assert deterministically without a real network round trip.
 */

class FakeSocket extends EventEmitter {
  localAddress: string | undefined
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

describe('parseHostPort', () => {
  test('host:port is split explicitly', () => {
    expect(parseHostPort('192.168.88.1:8729', false)).toEqual({ host: '192.168.88.1', port: 8729 })
  })

  test('a bare host falls back to the scheme\'s own default port (80/443, matching rest-client.ts\'s http/https choice)', () => {
    expect(parseHostPort('192.168.88.1', false)).toEqual({ host: '192.168.88.1', port: 80 })
    expect(parseHostPort('192.168.88.1', true)).toEqual({ host: '192.168.88.1', port: 443 })
  })

  test('a trailing non-numeric segment is not mistaken for a port', () => {
    expect(parseHostPort('router.local', false)).toEqual({ host: 'router.local', port: 80 })
  })
})

describe('deriveCoreAddress', () => {
  test('reads socket.localAddress inside the connect event and reports it as "derived"', async () => {
    const fake = new FakeSocket()
    const result = deriveCoreAddress(
      { baseUrl: '192.168.50.1:8729', tls: false },
      {
        connect: () => {
          queueMicrotask(() => {
            fake.localAddress = '192.168.50.10'
            fake.emit('connect')
          })
          return fake as unknown as import('node:net').Socket
        },
      },
    )
    await expect(result).resolves.toEqual({ kind: 'derived', address: '192.168.50.10' })
    expect(fake.destroyed).toBe(true)
  })

  test('a connect error falls back to rfc1918-fallback, naming why', async () => {
    const fake = new FakeSocket()
    const result = deriveCoreAddress(
      { baseUrl: '192.168.50.1', tls: false },
      {
        connect: () => {
          queueMicrotask(() => fake.emit('error', new Error('ECONNREFUSED')))
          return fake as unknown as import('node:net').Socket
        },
      },
    )
    const outcome = await result
    expect(outcome.kind).toBe('rfc1918-fallback')
    expect(outcome.kind === 'rfc1918-fallback' && outcome.reason).toContain('ECONNREFUSED')
  })

  test('a timeout falls back to rfc1918-fallback rather than hanging forever', async () => {
    const fake = new FakeSocket()
    const outcome = await deriveCoreAddress(
      { baseUrl: '192.168.50.1', tls: false },
      {
        timeoutMs: 20,
        connect: () => fake as unknown as import('node:net').Socket, // never emits anything
      },
    )
    expect(outcome.kind).toBe('rfc1918-fallback')
    expect(outcome.kind === 'rfc1918-fallback' && outcome.reason).toContain('timed out')
  })

  test('a connect event with no localAddress (should not happen in practice) still falls back rather than reporting a made-up address', async () => {
    const fake = new FakeSocket()
    const outcome = await deriveCoreAddress(
      { baseUrl: '192.168.50.1', tls: false },
      {
        connect: () => {
          queueMicrotask(() => fake.emit('connect')) // localAddress left undefined
          return fake as unknown as import('node:net').Socket
        },
      },
    )
    expect(outcome.kind).toBe('rfc1918-fallback')
  })
})
