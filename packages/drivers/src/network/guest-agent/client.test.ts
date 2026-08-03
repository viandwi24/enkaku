import { describe, expect, test } from 'bun:test'
import { GUEST_AGENT_PROTOCOL } from '@enkaku/protocol'
import { GuestAgentClientError, createGuestAgentClient, type GuestAgentConnect } from './client'

/** A parsed request line, for fakes that need to answer per-method. */
function parseLine(line: string): { id: string; token: string; method: string; [k: string]: unknown } {
  return JSON.parse(line)
}

/**
 * A fake `connect` that answers every request with a scripted reply, tracking how many times it
 * was called — good enough to drive `createGuestAgentClient` without a real socket.
 */
function scriptedConnect(reply: (req: ReturnType<typeof parseLine>, attempt: number) => unknown): {
  connect: GuestAgentConnect
  callCount: () => number
} {
  let calls = 0
  const connect: GuestAgentConnect = async (opts) => {
    calls++
    const attempt = calls
    let written = ''
    const socket = {
      write(data: string) {
        written += data
        // The client writes the whole request in one call, terminated by \n — respond
        // asynchronously so this matches Bun.connect's own callback-based delivery.
        queueMicrotask(() => {
          const line = written.slice(0, written.indexOf('\n'))
          const req = parseLine(line)
          const body = `${JSON.stringify(reply(req, attempt))}\n`
          opts.socket.data(socket, new TextEncoder().encode(body))
        })
        return data.length
      },
      end() {
        // no-op — the fake has nothing to release
      },
    }
    return socket
  }
  return { connect, callCount: () => calls }
}

/** A `connect` that never calls back — used to exercise the per-call timeout. */
function hangingConnect(): GuestAgentConnect {
  return async () => ({
    write() {
      // deliberately never responds
    },
    end() {
      // no-op
    },
  })
}

describe('createGuestAgentClient (plan 44 §5.5)', () => {
  test('hello() throws a coded error on a protocol mismatch, and does not retry it', async () => {
    const { connect, callCount } = scriptedConnect((req) => {
      expect(req.method).toBe('hello')
      return {
        id: req.id,
        ok: true,
        result: {
          protocol: GUEST_AGENT_PROTOCOL + 1,
          appVersion: '1.0.0',
          androidSdkInt: 35,
          capabilities: ['socks5-route', 'vpn-status'],
        },
      }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect, handshakeRetries: 5, handshakeRetryDelayMs: 1 })

    await expect(client.hello()).rejects.toMatchObject({ code: 'E_PROTOCOL_MISMATCH' })
    // A version mismatch is not a transient bring-up race — retrying it wastes time confirming
    // what the first reply already answered, so this must connect exactly once.
    expect(callCount()).toBe(1)
  })

  test('an ok:false reply throws a GuestAgentClientError carrying the agent code, not message text', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('ping')
      return { id: req.id, ok: false, error: { code: 'E_UNAUTHORISED', message: 'bad token, whatever that means today' } }
    })
    const client = createGuestAgentClient({ port: 1, token: 'wrong', connect })

    let caught: unknown
    try {
      await client.ping()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GuestAgentClientError)
    expect((caught as GuestAgentClientError).code).toBe('E_UNAUTHORISED')
  })

  test('a hung socket rejects with E_TIMEOUT instead of parking the caller forever', async () => {
    const client = createGuestAgentClient({ port: 1, token: 't', connect: hangingConnect(), timeoutMs: 20 })
    await expect(client.ping()).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })

  test('hello() retries the initial connect/handshake with backoff, and succeeds once the agent answers', async () => {
    // `flaky` below only ever calls this wrapped connect once it stops rejecting itself, so this
    // fake never needs to see — let alone reject — an early attempt.
    const { connect, callCount } = scriptedConnect((req) => ({
      id: req.id,
      ok: true,
      result: { protocol: GUEST_AGENT_PROTOCOL, appVersion: '1.0.0', androidSdkInt: 35, capabilities: [] },
    }))
    // Wrap the scripted connect so the first two attempts fail at the connect stage — the
    // documented failure mode (plan 44 §5.1): the agent binds its socket a moment after the
    // process starts, so an early connect is refused rather than answered.
    let attempts = 0
    const flaky: GuestAgentConnect = async (opts) => {
      attempts++
      if (attempts < 3) {
        const fake = { write() {}, end() {} }
        queueMicrotask(() => opts.socket.connectError?.(fake, new Error('refused')))
        return fake
      }
      return connect(opts)
    }

    const client = createGuestAgentClient({
      port: 1,
      token: 't',
      connect: flaky,
      handshakeRetries: 8,
      handshakeRetryDelayMs: 1,
    })

    const hello = await client.hello()
    expect(hello.protocol).toBe(GUEST_AGENT_PROTOCOL)
    expect(attempts).toBe(3)
    expect(callCount()).toBe(1) // only the successful attempt reaches the underlying scripted connect
  })

  test('hello() gives up after exhausting its retry budget', async () => {
    const alwaysRefuses: GuestAgentConnect = async (opts) => {
      const fake = { write() {}, end() {} }
      queueMicrotask(() => opts.socket.connectError?.(fake, new Error('refused')))
      return fake
    }
    const client = createGuestAgentClient({
      port: 1,
      token: 't',
      connect: alwaysRefuses,
      handshakeRetries: 3,
      handshakeRetryDelayMs: 1,
    })
    await expect(client.hello()).rejects.toMatchObject({ code: 'E_TRANSPORT' })
  })

  test('routeStart() sends the config through and returns the validated result', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('route.start')
      expect(req.config).toMatchObject({ host: 'proxy.example', port: 1080 })
      return { id: req.id, ok: true, result: { started: true } }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.routeStart({ host: 'proxy.example', port: 1080, udpMode: 'udp' })
    expect(result).toEqual({ started: true })
  })

  test('a response that fails schema validation throws E_UNEXPECTED_RESPONSE', async () => {
    const { connect } = scriptedConnect((req) => ({ id: req.id, ok: true, result: { nonsense: true } }))
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    await expect(client.ping()).rejects.toMatchObject({ code: 'E_UNEXPECTED_RESPONSE' })
  })
})
