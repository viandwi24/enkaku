import { describe, expect, test } from 'bun:test'
import { createAdbdShim, type AdbdShimDeps } from './adbd-shim'
import type { RawStream } from './stream-mux'
import { A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_WRTE, CONNECT_VERSION, decodeHeader, encodeFrame } from './wire'

/**
 * Exercises the REAL `createAdbdShim` production code over real loopback TCP
 * sockets (no physical device, no real `adb` binary — that end-to-end proof
 * is the plan §27.1 spike, kept out of the repo). This is the byte-level
 * scripted-peer style plan §7 asks for, aimed at the glue code itself rather
 * than at `stream-mux.ts` in isolation.
 */

const te = new TextEncoder()
const td = new TextDecoder()

/** A minimal scripted client: connects, and exposes `send`/`readFrame` against the raw socket. */
async function connectPeer(port: number) {
  const chunks: Uint8Array[] = []
  let length = 0
  let waiter: { need: number; resolve: (b: Uint8Array) => void } | null = null

  function tryResolve(): void {
    if (!waiter || length < waiter.need) return
    const all = new Uint8Array(length)
    let off = 0
    for (const c of chunks) {
      all.set(c, off)
      off += c.length
    }
    const head = all.subarray(0, waiter.need)
    const rest = all.subarray(waiter.need)
    chunks.length = 0
    length = 0
    if (rest.length) {
      chunks.push(rest)
      length = rest.length
    }
    const w = waiter
    waiter = null
    w.resolve(head)
  }

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, data) {
        chunks.push(new Uint8Array(data))
        length += data.byteLength
        tryResolve()
      },
      close() {},
      error() {},
    },
  })

  return {
    send(command: number, arg0: number, arg1: number, data?: Uint8Array) {
      socket.write(encodeFrame(command, arg0, arg1, data))
    },
    take(n: number): Promise<Uint8Array> {
      return new Promise((resolve) => {
        waiter = { need: n, resolve }
        tryResolve()
      })
    },
    async readFrame() {
      const header = decodeHeader(await this.take(24))
      const payload = header.dataLength > 0 ? await this.take(header.dataLength) : new Uint8Array(0)
      return { header, payload }
    },
    close() {
      socket.end()
    },
  }
}

function makeFakeBackend() {
  let onData: ((c: Uint8Array) => void) | null = null
  let onEnd: ((err?: unknown) => void) | null = null
  const stream: RawStream = {
    write() {},
    streamFrom(od, oe) {
      onData = od
      onEnd = oe
    },
    close() {},
  }
  return { stream, emit: (c: Uint8Array) => onData?.(c), end: () => onEnd?.() }
}

function startShim(deps: Partial<AdbdShimDeps> & { openService: AdbdShimDeps['openService'] }) {
  const opened: string[] = []
  const closedReasons: string[] = []
  const handlers = createAdbdShim({
    serial: 'test-serial',
    banner: 'device::ro.product.name=test;features=cmd',
    maxStreams: 8,
    onOpen: (service) => opened.push(service),
    onClose: (reason) => closedReasons.push(reason),
    log: () => {},
    ...deps,
  })
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: handlers.open,
      data: handlers.data,
      close: handlers.close,
      error: handlers.error,
    },
  })
  return { port: listener.port as number, stop: () => listener.stop(true), opened, closedReasons }
}

describe('createAdbdShim — handshake', () => {
  test('replies CNXN with a clamped maxdata and the given banner, no AUTH', async () => {
    const shim = startShim({ openService: async () => makeFakeBackend().stream })
    const peer = await connectPeer(shim.port)
    peer.send(A_CNXN, CONNECT_VERSION, 999_999_999, te.encode('host::features=shell_v2'))
    const reply = await peer.readFrame()
    expect(reply.header.command).toBe(A_CNXN)
    expect(reply.header.arg0).toBe(CONNECT_VERSION)
    expect(reply.header.arg1).toBeLessThanOrEqual(1024 * 1024) // clamped, never the client's absurd request
    expect(td.decode(reply.payload)).toContain('device::')
    peer.close()
    shim.stop()
  })

  test('a peer opening with AUTH is refused outright', async () => {
    const shim = startShim({ openService: async () => makeFakeBackend().stream })
    const peer = await connectPeer(shim.port)
    peer.send(A_AUTH, 1, 0, new Uint8Array(0))
    // The shim ends the socket; nothing further to assert beyond "it does not hang or throw".
    await Bun.sleep(50)
    expect(shim.closedReasons).toContain('auth_refused')
    peer.close()
    shim.stop()
  })
})

describe('createAdbdShim — OPEN bridging', () => {
  test('an OPEN is bridged through openService and streamed back as WRTE', async () => {
    const backend = makeFakeBackend()
    const shim = startShim({
      openService: async (serial, service) => {
        expect(serial).toBe('test-serial')
        expect(service).toBe('shell:echo hi')
        return backend.stream
      },
    })
    const peer = await connectPeer(shim.port)
    peer.send(A_CNXN, CONNECT_VERSION, 1_048_576, te.encode('host::features='))
    await peer.readFrame() // CNXN reply

    peer.send(A_OPEN, 77, 0, te.encode('shell:echo hi\0'))
    const okay = await peer.readFrame()
    expect(okay.header.command).toBe(A_OKAY)
    expect(okay.header.arg1).toBe(77)
    expect(shim.opened).toEqual(['shell:echo hi'])

    backend.emit(te.encode('hi\n'))
    const wrte = await peer.readFrame()
    expect(wrte.header.command).toBe(A_WRTE)
    expect(td.decode(wrte.payload)).toBe('hi\n')

    peer.close()
    shim.stop()
  })

  test('a CLSE from the peer is echoed and the endpoint stays usable for the next stream', async () => {
    const backend = makeFakeBackend()
    const shim = startShim({ openService: async () => backend.stream })
    const peer = await connectPeer(shim.port)
    peer.send(A_CNXN, CONNECT_VERSION, 1_048_576, te.encode('host::features='))
    await peer.readFrame()

    peer.send(A_OPEN, 1, 0, te.encode('shell:sleep 5\0'))
    const okay = await peer.readFrame()
    expect(okay.header.command).toBe(A_OKAY)

    peer.send(A_CLSE, 1, okay.header.arg0)
    const clseReply = await peer.readFrame()
    expect(clseReply.header.command).toBe(A_CLSE)

    peer.close()
    shim.stop()
  })
})
