import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createListener, type Negotiator, type UpstreamHolder } from './listener'
import type { BridgeSocket } from './socket'
import type { Upstream, UpstreamTarget } from './upstream'

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
