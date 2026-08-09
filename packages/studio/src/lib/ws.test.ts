import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { WsClient, type WsClientScheduler } from './ws'

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
