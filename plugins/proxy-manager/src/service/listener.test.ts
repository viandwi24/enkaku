import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createListener, type Negotiator, type UpstreamHolder } from './listener'
import type { BridgeSocket } from './socket'
import type { Upstream, UpstreamTarget } from './upstream'
import type { BridgeEvent } from './logbook'

/**
 * Plan 121 step 121.2 — the swappable upstream holder (§4.3).
 *
 * This does NOT test any failover trigger — there is none yet (that is step
 * 121.3). It proves the MECHANISM plan 121.2 exists to build: reassigning
 * `holder.current` mid-lifetime does not disturb an already-open connection
 * (it is a live pipe to the OLD upstream's socket by then, not a lookup), and
 * the very next connection accepted after the reassignment dials through the
 * NEW upstream. Before this step the listener captured a bare `Upstream` in
 * its closure forever (plan 121 §0.2) — this is what makes that untrue.
 */

/** A backend the fake `Upstream` dials straight into: writes a banner once connected, then echoes anything it is sent. So a client that reads the banner knows exactly which backend it landed on, and can prove the pipe is still alive to it afterward. */
function startBannerServer(banner: string): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.write(banner)
    sock.on('data', (chunk: Buffer) => sock.write(chunk))
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy()
            server.close(() => res())
          }),
      })
    })
  })
}

/** The same fake-`Upstream` pattern `probe.test.ts`'s own `upstreamTo` already established: dials the SAME real local server regardless of `dest`, and counts how many times it was asked to. */
function fakeUpstream(port: number): Upstream & { connectCount: number } {
  const state = { connectCount: 0 }
  return {
    description: 'test upstream',
    get connectCount() {
      return state.connectCount
    },
    async connect(_dest: UpstreamTarget): Promise<BridgeSocket> {
      state.connectCount += 1
      return net.connect(port, '127.0.0.1') as unknown as BridgeSocket
    },
  }
}

/**
 * Plan 123 §0.3, §4.4 — a fake upstream that resolves only on the socket's
 * own `connect` event, exactly like `dial-direct.ts`'s real dialler.
 * `fakeUpstream` above resolves as soon as `net.connect()` is CALLED, before
 * the handshake finishes — fine for the holder-swap test above, which never
 * reads `localAddress`, but wrong for these tests: `socket.localAddress` is
 * unpopulated until the connection is actually established, and reading it
 * too early is precisely the measurement error plan 123 §0.3 recorded and
 * corrected. Dials the SAME real local server regardless of `dest`, same as
 * `fakeUpstream`.
 */
function fakeUpstreamAwaitingConnect(port: number): Upstream {
  return {
    description: 'test upstream (awaits connect)',
    connect(_dest: UpstreamTarget): Promise<BridgeSocket> {
      return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        socket.once('connect', () => resolve(socket as unknown as BridgeSocket))
        socket.once('error', reject)
      })
    },
  }
}

/** A negotiator with no protocol at all: open the tunnel immediately, so the test is only about the holder, not about HTTP/SOCKS5 framing. */
const openImmediately: Negotiator = (client, api) => {
  api.open({ host: 'ignored', port: 0 }, { onReady: () => {}, onFailure: () => client.destroy() })
}

function readOnce(sock: net.Socket): Promise<string> {
  return new Promise<string>((resolve) => {
    sock.once('data', (chunk: Buffer) => resolve(chunk.toString()))
  })
}

describe('the upstream holder — plan 121 §4.3', () => {
  test('a mid-lifetime reassignment leaves an already-open connection on the OLD upstream, and the next accepted connection dials through the NEW one', async () => {
    const a = await startBannerServer('from-A')
    const b = await startBannerServer('from-B')
    try {
      const upstreamA = fakeUpstream(a.port)
      const upstreamB = fakeUpstream(b.port)
      const holder: UpstreamHolder = { current: upstreamA }

      const listener = await createListener({ bindHost: '127.0.0.1', port: 0, upstream: holder, maxConnections: 16, log: () => {} }, openImmediately)
      try {
        // First connection, dialled while the holder still points at A.
        const first = net.connect(listener.port, '127.0.0.1')
        expect(await readOnce(first)).toBe('from-A')

        // Reassign the holder mid-lifetime — the whole point of plan 121.2.
        holder.current = upstreamB

        // The already-open connection is untouched by the reassignment: it is
        // a live pipe to A's socket by now, not a lookup through the holder.
        // Round-tripping fresh bytes through it proves the pipe is still A's,
        // not merely that it has not yet been destroyed.
        const echoPromise = readOnce(first)
        first.write('still-a')
        expect(await echoPromise).toBe('still-a')

        // The VERY NEXT connection accepted after the reassignment dials
        // through the NEW upstream.
        const second = net.connect(listener.port, '127.0.0.1')
        expect(await readOnce(second)).toBe('from-B')

        // One dial each — the swap did not cause a stray reconnect on either side.
        expect(upstreamA.connectCount).toBe(1)
        expect(upstreamB.connectCount).toBe(1)

        first.destroy()
        second.destroy()
      } finally {
        listener.close()
        listener.destroyLive()
      }
    } finally {
      await a.close()
      await b.close()
    }
  })
})

describe('egressAddress and the once-per-start bind-mismatch warn — plan 123 §4.4', () => {
  test('`upstream-connected` always carries the observed egress address, read at dial resolution', async () => {
    const backend = await startBannerServer('hello')
    try {
      const upstream = fakeUpstreamAwaitingConnect(backend.port)
      const holder: UpstreamHolder = { current: upstream }
      const events: BridgeEvent[] = []
      const listener = await createListener({ bindHost: '127.0.0.1', port: 0, upstream: holder, maxConnections: 16, log: (e) => events.push(e) }, openImmediately)
      try {
        const client = net.connect(listener.port, '127.0.0.1')
        await readOnce(client)
        const connected = events.find((e) => e.event === 'upstream-connected')
        expect(connected).toBeDefined()
        expect(connected && 'egressAddress' in connected ? connected.egressAddress : undefined).toBe('127.0.0.1')
        client.destroy()
      } finally {
        listener.close()
        listener.destroyLive()
      }
    } finally {
      await backend.close()
    }
  })

  test('no `bindAddress` on the listener ⇒ never warns, on any number of connections (criterion 4)', async () => {
    const backend = await startBannerServer('hello')
    try {
      const upstream = fakeUpstreamAwaitingConnect(backend.port)
      const holder: UpstreamHolder = { current: upstream }
      const events: BridgeEvent[] = []
      // No `bindAddress` at all — the common case (no upstream.bindAddress
      // configured), which must cost nothing and warn never.
      const listener = await createListener({ bindHost: '127.0.0.1', port: 0, upstream: holder, maxConnections: 16, log: (e) => events.push(e) }, openImmediately)
      try {
        for (let i = 0; i < 3; i += 1) {
          const client = net.connect(listener.port, '127.0.0.1')
          await readOnce(client)
          client.destroy()
        }
        expect(events.some((e) => e.event === 'bind-mismatch')).toBe(false)
      } finally {
        listener.close()
        listener.destroyLive()
      }
    } finally {
      await backend.close()
    }
  })

  test('a mismatched `bindAddress` warns exactly ONCE across many connections in the same start, not once per connection (criterion 7)', async () => {
    const backend = await startBannerServer('hello')
    try {
      const upstream = fakeUpstreamAwaitingConnect(backend.port)
      const holder: UpstreamHolder = { current: upstream }
      const events: BridgeEvent[] = []
      // `fakeUpstreamAwaitingConnect` dials `127.0.0.1` without setting its own
      // `localAddress`, so the OBSERVED egress is `127.0.0.1` — configuring a DIFFERENT
      // `bindAddress` here simulates exactly the bug plan 123 exists for: the
      // configured bind is silently not what was actually used.
      const listener = await createListener(
        { bindHost: '127.0.0.1', port: 0, upstream: holder, maxConnections: 16, log: (e) => events.push(e), bindAddress: '127.0.0.2' },
        openImmediately,
      )
      try {
        for (let i = 0; i < 3; i += 1) {
          const client = net.connect(listener.port, '127.0.0.1')
          await readOnce(client)
          client.destroy()
        }
        const mismatches = events.filter((e) => e.event === 'bind-mismatch')
        expect(mismatches.length).toBe(1)
        const first = mismatches[0]
        expect(first && first.event === 'bind-mismatch' ? first.bindAddress : undefined).toBe('127.0.0.2')
        expect(first && first.event === 'bind-mismatch' ? first.egressAddress : undefined).toBe('127.0.0.1')
      } finally {
        listener.close()
        listener.destroyLive()
      }
    } finally {
      await backend.close()
    }
  })

  test('a fresh `createListener` call (a restart) resets the once-per-start warn, matching plan 121’s FailoverController precedent', async () => {
    const backend = await startBannerServer('hello')
    try {
      const upstream = fakeUpstreamAwaitingConnect(backend.port)
      const holder: UpstreamHolder = { current: upstream }

      async function connectOnceAndCollect(): Promise<BridgeEvent[]> {
        const events: BridgeEvent[] = []
        const listener = await createListener(
          { bindHost: '127.0.0.1', port: 0, upstream: holder, maxConnections: 16, log: (e) => events.push(e), bindAddress: '127.0.0.2' },
          openImmediately,
        )
        try {
          const client = net.connect(listener.port, '127.0.0.1')
          await readOnce(client)
          client.destroy()
        } finally {
          listener.close()
          listener.destroyLive()
        }
        return events
      }

      // `startLocked` builds an entirely new listener (and hence a fresh
      // closure) on every start — the SAME "fresh per run" shape plan 121's
      // `FailoverController` uses to reset its own failure count. Two
      // independent `createListener` calls must each warn once, not have the
      // second one silenced by the first's flag.
      const first = await connectOnceAndCollect()
      const second = await connectOnceAndCollect()
      expect(first.filter((e) => e.event === 'bind-mismatch').length).toBe(1)
      expect(second.filter((e) => e.event === 'bind-mismatch').length).toBe(1)
    } finally {
      await backend.close()
    }
  })
})
