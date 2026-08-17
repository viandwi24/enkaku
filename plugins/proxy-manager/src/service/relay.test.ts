import { afterAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createRelay } from './relay'

/**
 * Plan 112 §4.4's `relay.ts` — the pipe, the two counters, and the one
 * teardown path.
 *
 * The topology below is the real one rather than a convenient one: a client
 * dials a server we accept on, that accepted socket is one half of the relay,
 * and the other half is a connection to an echo server. Relaying two sockets
 * that both point at the same place looks simpler and measures nothing — the
 * first version of this file did exactly that and reported `bytesDown: 0`.
 */

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/** A raw TCP echo, uppercased so a test can tell the two directions apart by content as well as by count. */
const echo = net.createServer((sock) => {
  sock.on('data', (chunk: Buffer) => sock.write(chunk.toString().toUpperCase() + '!'))
  sock.on('error', () => {})
})
const echoPort = await listen(echo)
afterAll(() => echo.close())

interface Pair {
  /** The test's own end. Write here to send "up". */
  client: net.Socket
  /** The relay's client-side half. */
  accepted: net.Socket
  /** The relay's upstream half. */
  upstream: net.Socket
  close(): void
}

async function pair(): Promise<Pair> {
  const accepted = Promise.withResolvers<net.Socket>()
  const front = net.createServer((sock) => accepted.resolve(sock))
  const frontPort = await listen(front)
  const client = net.connect(frontPort, '127.0.0.1')
  client.on('error', () => {})
  const upstream = net.connect(echoPort, '127.0.0.1')
  upstream.on('error', () => {})
  await Promise.all([
    new Promise<void>((r) => client.on('connect', () => r())),
    new Promise<void>((r) => upstream.on('connect', () => r())),
  ])
  return {
    client,
    accepted: await accepted.promise,
    upstream,
    close: () => {
      client.destroy()
      upstream.destroy()
      front.close()
    },
  }
}

describe('the relay', () => {
  test('carries bytes both ways and counts each direction separately', async () => {
    const p = await pair()
    const { promise, resolve } = Promise.withResolvers<{ bytesUp: number; bytesDown: number }>()
    createRelay(p.accepted, p.upstream, { onClose: (counters) => resolve(counters) })

    const back = await new Promise<string>((r) => {
      p.client.on('data', (chunk: Buffer) => r(chunk.toString()))
      p.client.write('hello')
    })
    expect(back).toBe('HELLO!')

    p.client.destroy()
    const counters = await promise
    // Up is five bytes, down is six. Different on purpose: a single shared
    // counter would pass a test where the two happened to be equal.
    expect(counters.bytesUp).toBe(5)
    expect(counters.bytesDown).toBe(6)
    p.close()
  })

  test('onClose fires exactly once, however many ends close — a count that can go negative goes negative under load', async () => {
    const p = await pair()
    let closes = 0
    const relay = createRelay(p.accepted, p.upstream, { onClose: () => closes++ })

    // Every path to a teardown at once.
    p.accepted.destroy()
    p.upstream.destroy()
    relay.destroy()
    relay.destroy()
    await Bun.sleep(100)
    expect(closes).toBe(1)
    p.close()
  })

  test('the idle timer fires only when NOTHING flows, and traffic keeps postponing it', async () => {
    const p = await pair()
    const { promise, resolve } = Promise.withResolvers<string>()
    const started = performance.now()
    createRelay(p.accepted, p.upstream, { idleMs: 250, onClose: (_counters, reason) => resolve(reason) })

    // Three heartbeats 120 ms apart: each has to reset a 250 ms timer, so the
    // pair must survive past 360 ms — the control that this is an IDLE timer
    // and not a deadline.
    for (let i = 0; i < 3; i++) {
      p.client.write('.')
      await Bun.sleep(120)
    }
    expect(performance.now() - started).toBeGreaterThan(350)

    // …and it fired roughly one idle window after the LAST heartbeat (the
    // third write lands at ~240 ms, so ~490 ms), not one window after the
    // first. A deadline would have fired at 250 ms.
    expect(await promise).toBe('idle')
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThan(440)
    expect(elapsed).toBeLessThan(900)
    p.close()
  })

  test('an explicit destroy is reported as `stopped`; a socket-initiated close is reported as one of the two peers', async () => {
    // `stopped` is exact and is the one the supervisor acts on. Which PEER is
    // named when a socket goes first is deliberately not asserted: tearing
    // down one end of a `pipe` closes the other in the same tick, and which
    // `close` event the runtime delivers first is a race. The reason is a
    // diagnostic, never a decision — nothing branches on `client` vs
    // `upstream`, and a test that pinned the race would be pinning the
    // runtime rather than this file.
    const explicit = await pair()
    {
      const { promise, resolve } = Promise.withResolvers<string>()
      const relay = createRelay(explicit.accepted, explicit.upstream, { onClose: (_counters, reason) => resolve(reason) })
      relay.destroy()
      expect(await promise).toBe('stopped')
      explicit.close()
    }
    for (const end of ['accepted', 'upstream'] as const) {
      const p = await pair()
      const { promise, resolve } = Promise.withResolvers<string>()
      createRelay(p.accepted, p.upstream, { onClose: (_counters, reason) => resolve(reason) })
      p[end].destroy()
      expect(['client', 'upstream']).toContain(await promise)
      p.close()
    }
  })
})
