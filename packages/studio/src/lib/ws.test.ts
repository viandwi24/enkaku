import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { newId, WsAuthExpiredError, WsClient, type WsClientScheduler } from './ws'

/** Flushes pending microtasks (a `fetchTicket()` promise and `connect()`'s own `.then()`/`.catch()`) without touching the fake scheduler, which is reserved for the watchdog/backoff timers under test. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * A `WebSocket` stand-in good enough to drive `WsClient` without a real
 * server — readyState values match the real global's (0 CONNECTING, 1 OPEN,
 * 3 CLOSED), which is what `WsClient.connect()`/`send()` actually check
 * against (`WebSocket.OPEN`/`WebSocket.CONNECTING`, read from happy-dom's
 * global, not from this class).
 */
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readyState = FakeSocket.CONNECTING
  binaryType = ''
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  /** Test-only helper — not part of the real `WebSocket` API. */
  simulateOpen(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** Test-only helper. */
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data })
  }
}

/**
 * A fake scheduler that never actually waits (plan 85 §5 85.7a — "do not
 * make the test actually wait 45s; inject the clock"). `armWatchdog` always
 * clears the previous timer before setting a new one, so at most one timer
 * is ever pending — this fake tracks exactly that one slot, plus call
 * counters so a test can prove a reset happened (a `clearTimeout` followed
 * by a fresh `setTimeout`) without needing to simulate real elapsed time.
 */
function createFakeScheduler(): {
  scheduler: WsClientScheduler
  expire: () => void
  hasPending: () => boolean
  setTimeoutCalls: () => number
  clearTimeoutCalls: () => number
} {
  let nextId = 1
  let pending: { id: number; fn: () => void } | null = null
  let setTimeoutCalls = 0
  let clearTimeoutCalls = 0

  const scheduler: WsClientScheduler = {
    setTimeout: (fn) => {
      setTimeoutCalls += 1
      const id = nextId++
      pending = { id, fn }
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (id) => {
      clearTimeoutCalls += 1
      if (pending?.id === id) pending = null
    },
  }

  return {
    scheduler,
    expire: () => {
      const p = pending
      pending = null
      p?.fn()
    },
    hasPending: () => pending !== null,
    setTimeoutCalls: () => setTimeoutCalls,
    clearTimeoutCalls: () => clearTimeoutCalls,
  }
}

describe('WsClient — the 45s silence watchdog (plan 85 §3.6, §4.6, §5 85.7a, fixes F16, tests H2)', () => {
  const originalWarn = console.warn

  beforeEach(() => {
    console.warn = mock(() => {})
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  test('45s of total silence force-closes the socket and counts a watchdog reconnect', () => {
    const fake = createFakeScheduler()
    let socket: FakeSocket | null = null
    const client = new WsClient({
      createSocket: (url) => {
        socket = new FakeSocket(url)
        return socket as unknown as WebSocket
      },
      scheduler: fake.scheduler,
      watchdogMs: 45_000,
    })

    client.connect()
    expect(socket).not.toBeNull()
    socket!.simulateOpen()

    // The watchdog is armed the moment the socket opens — before any
    // message has to arrive — so a connection that opens and then hears
    // nothing at all is still caught.
    expect(fake.hasPending()).toBe(true)
    expect(client.getWatchdogReconnects()).toBe(0)

    // Simulate 45s of silence WITHOUT waiting 45s: fire the captured
    // callback directly instead of advancing a real or virtual clock.
    fake.expire()

    expect(socket!.readyState).toBe(FakeSocket.CLOSED)
    expect(client.getWatchdogReconnects()).toBe(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toContain('forcing a reconnect')
  })

  test('any inbound message resets the timer, so a link that keeps hearing traffic never expires', () => {
    const fake = createFakeScheduler()
    let socket: FakeSocket | null = null
    const client = new WsClient({
      createSocket: (url) => {
        socket = new FakeSocket(url)
        return socket as unknown as WebSocket
      },
      scheduler: fake.scheduler,
      watchdogMs: 45_000,
    })

    client.connect()
    socket!.simulateOpen()
    expect(fake.setTimeoutCalls()).toBe(1) // armed once, on open
    expect(fake.clearTimeoutCalls()).toBe(0)

    // A heartbeat (or any other server message) arrives well before 45s —
    // this must clear the timer `onopen` armed and arm a fresh one, not
    // just let the old one keep counting down.
    socket!.simulateMessage(JSON.stringify({ type: 'heartbeat', payload: { t: Date.now() } }))
    expect(fake.clearTimeoutCalls()).toBe(1)
    expect(fake.setTimeoutCalls()).toBe(2)
    expect(fake.hasPending()).toBe(true)

    // The socket must still be open — a reset must not itself force a
    // reconnect.
    expect(socket!.readyState).toBe(FakeSocket.OPEN)
    expect(client.getWatchdogReconnects()).toBe(0)

    // Only once the LATEST (post-reset) timer actually fires does the
    // watchdog close the socket.
    fake.expire()
    expect(socket!.readyState).toBe(FakeSocket.CLOSED)
    expect(client.getWatchdogReconnects()).toBe(1)
  })

  test('onStatus reports the running watchdog-reconnect count alongside connectivity', () => {
    const fake = createFakeScheduler()
    let socket: FakeSocket | null = null
    const client = new WsClient({
      createSocket: (url) => {
        socket = new FakeSocket(url)
        return socket as unknown as WebSocket
      },
      scheduler: fake.scheduler,
      watchdogMs: 45_000,
    })

    const seen: Array<{ connected: boolean; watchdogReconnects: number }> = []
    client.onStatus((connected, info) => seen.push({ connected, ...info }))

    client.connect()
    socket!.simulateOpen()
    fake.expire() // forces a reconnect → onclose → setConnected(false)

    const last = seen[seen.length - 1]
    expect(last?.connected).toBe(false)
    expect(last?.watchdogReconnects).toBe(1)
  })
})

describe('WsClient — server auth mode fetches a single-use ticket per connection (plan 09 §4.3)', () => {
  test('local mode (the default — no setAuthMode call) still connects synchronously, with no ticket in the URL', () => {
    let socket: FakeSocket | null = null
    const fetchTicket = mock(async () => 'should-not-be-called')
    const client = new WsClient({
      createSocket: (url) => {
        socket = new FakeSocket(url)
        return socket as unknown as WebSocket
      },
      fetchTicket,
    })

    client.connect()

    // Synchronous, exactly like before tickets existed — this is what every
    // other test in this file (and every existing call site) relies on.
    expect(socket).not.toBeNull()
    expect(socket!.url).not.toContain('ticket=')
    expect(fetchTicket).not.toHaveBeenCalled()
  })

  test('server mode: connect() fetches a ticket first and puts it on the WS URL', async () => {
    let socket: FakeSocket | null = null
    const client = new WsClient({
      createSocket: (url) => {
        socket = new FakeSocket(url)
        return socket as unknown as WebSocket
      },
      fetchTicket: async () => 'tok-abc123',
    })
    client.setAuthMode('server')

    client.connect()
    expect(socket).toBeNull() // the ticket fetch has not resolved yet

    await flush()

    expect(socket).not.toBeNull()
    expect(socket!.url).toContain('ticket=tok-abc123')
  })

  test('a WsAuthExpiredError from fetchTicket notifies onAuthExpired and does NOT schedule a reconnect', async () => {
    const fake = createFakeScheduler()
    const client = new WsClient({
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      scheduler: fake.scheduler,
      fetchTicket: async () => {
        throw new WsAuthExpiredError()
      },
    })
    client.setAuthMode('server')
    const expired = mock(() => {})
    client.onAuthExpired(expired)

    client.connect()
    await flush()

    expect(expired).toHaveBeenCalledTimes(1)
    // The ordinary backoff loop would just fail the exact same way forever —
    // there must be no reconnect timer pending after an expired session.
    expect(fake.hasPending()).toBe(false)
  })

  test('a transient fetchTicket failure (not an expired session) retries on the normal backoff, and does not fire onAuthExpired', async () => {
    const fake = createFakeScheduler()
    const client = new WsClient({
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      scheduler: fake.scheduler,
      fetchTicket: async () => {
        throw new Error('network blip')
      },
    })
    client.setAuthMode('server')
    const expired = mock(() => {})
    client.onAuthExpired(expired)

    client.connect()
    await flush()

    expect(expired).not.toHaveBeenCalled()
    expect(fake.hasPending()).toBe(true) // a reconnect attempt is scheduled
  })

  test('disconnect() closes the socket and suppresses the automatic reconnect; a fresh connect() afterwards reconnects normally', () => {
    const fake = createFakeScheduler()
    let socket: FakeSocket | null = null
    const client = new WsClient({
      createSocket: (url) => {
        socket = new FakeSocket(url)
        return socket as unknown as WebSocket
      },
      scheduler: fake.scheduler,
    })

    client.connect()
    socket!.simulateOpen() // arms the watchdog — one setTimeout call
    expect(fake.setTimeoutCalls()).toBe(1)

    client.disconnect()
    expect(socket!.readyState).toBe(FakeSocket.CLOSED)
    // The watchdog's clearTimeout ran, but no NEW setTimeout was scheduled
    // for a reconnect — a deliberate disconnect must not spin the backoff.
    expect(fake.hasPending()).toBe(false)
    expect(fake.setTimeoutCalls()).toBe(1)

    // A fresh login calls connect() again — it must work exactly as before,
    // not stay silently disabled because of the earlier disconnect().
    client.connect()
    expect(socket).not.toBeNull()
    expect(socket!.readyState).toBe(FakeSocket.CONNECTING)
  })
})

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  test('returns a v4 UUID when crypto.randomUUID is available', () => {
    expect(newId()).toMatch(UUID_V4_RE)
  })

  test('falls back to crypto.getRandomValues when crypto.randomUUID is undefined — a plain-HTTP LAN origin is not a secure context, so browsers do not expose randomUUID there', () => {
    const original = crypto.randomUUID
    // @ts-expect-error simulating exactly what a non-secure-context browser has: no randomUUID at all
    crypto.randomUUID = undefined
    try {
      expect(newId()).toMatch(UUID_V4_RE)
    } finally {
      crypto.randomUUID = original
    }
  })
})
