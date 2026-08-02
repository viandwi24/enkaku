import { describe, expect, test, mock } from 'bun:test'
import { createStreamMux, type RawStream, type StreamMuxDeps } from './stream-mux'
import { A_CLSE, A_OKAY, A_OPEN, A_WRTE, decodeHeader, encodeFrame, type AdbdHeader } from './wire'

const te = new TextEncoder()
const td = new TextDecoder()

/** A scripted byte-level "frame" — decode a real encoded frame so tests exercise the same wire shapes a socket would produce. */
function makeFrame(command: number, arg0: number, arg1: number, data?: Uint8Array): { header: AdbdHeader; payload: Uint8Array } {
  const encoded = encodeFrame(command, arg0, arg1, data)
  return { header: decodeHeader(encoded.subarray(0, 24)), payload: encoded.subarray(24) }
}

const openFrame = (hostId: number, service: string) => makeFrame(A_OPEN, hostId, 0, te.encode(service))
const wrteFrame = (hostId: number, ourId: number, data: Uint8Array) => makeFrame(A_WRTE, hostId, ourId, data)
const okayFrame = (hostId: number, ourId: number) => makeFrame(A_OKAY, hostId, ourId)
const clseFrame = (hostId: number, ourId: number) => makeFrame(A_CLSE, hostId, ourId)

/** Decode a frame the mux sent (via the `send` spy) back into a plain shape for assertions. */
function readSent(frame: Uint8Array): { command: string; arg0: number; arg1: number; payload: string } {
  const header = decodeHeader(frame.subarray(0, 24))
  const names: Record<number, string> = { [A_OPEN]: 'OPEN', [A_OKAY]: 'OKAY', [A_WRTE]: 'WRTE', [A_CLSE]: 'CLSE' }
  return { command: names[header.command] ?? String(header.command), arg0: header.arg0, arg1: header.arg1, payload: td.decode(frame.subarray(24)) }
}

/** A controllable fake `RawStream` backend — the "scripted peer" on the inside of the bridge. */
function makeFakeBackend() {
  let onData: ((c: Uint8Array) => void) | null = null
  let onEnd: ((err?: unknown) => void) | null = null
  const written: Uint8Array[] = []
  let closed = false
  const stream: RawStream = {
    write(chunk) {
      written.push(chunk)
    },
    streamFrom(od, oe) {
      onData = od
      onEnd = oe
    },
    close(_force) {
      closed = true
    },
  }
  return {
    stream,
    written,
    get closed() {
      return closed
    },
    emit(chunk: Uint8Array) {
      onData?.(chunk)
    },
    end(err?: unknown) {
      onEnd?.(err)
    },
  }
}

async function flush(): Promise<void> {
  // Two microtask turns: one for the `openService` promise to resolve, one
  // for its `.then` body to run before assertions inspect `sent`.
  await Promise.resolve()
  await Promise.resolve()
}

function makeMux(overrides: Partial<StreamMuxDeps> = {}) {
  const sent: Uint8Array[] = []
  const opened: string[] = []
  const closedReasons: Array<{ service: string; reason: string }> = []
  const deps: StreamMuxDeps = {
    send: (f) => sent.push(f),
    openService: mock(async (_service: string) => makeFakeBackend().stream),
    maxStreams: 8,
    onOpen: (service) => opened.push(service),
    onClose: (service, reason) => closedReasons.push({ service, reason }),
    log: () => {},
    ...overrides,
  }
  const mux = createStreamMux(deps)
  return { mux, sent, opened, closedReasons, deps }
}

describe('createStreamMux — opening a stream', () => {
  test('OPEN resolves through openService and replies OKAY(ourId, hostId)', async () => {
    const backend = makeFakeBackend()
    const openService = mock(async (service: string) => {
      expect(service).toBe('shell:echo hi')
      return backend.stream
    })
    const { mux, sent, opened } = makeMux({ openService })

    const { header, payload } = openFrame(42, 'shell:echo hi\0')
    mux.handleFrame(header, payload)
    await flush()

    expect(openService).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    const reply = readSent(sent[0] as Uint8Array)
    expect(reply.command).toBe('OKAY')
    expect(reply.arg0).toBe(1) // our first-allocated stream id
    expect(reply.arg1).toBe(42) // the host's id, echoed back
    expect(opened).toEqual(['shell:echo hi'])
    expect(mux.size).toBe(1)
  })

  test('an openService rejection sends CLSE(0, hostId) — no stream is allocated', async () => {
    const openService = mock(async () => {
      throw new Error('device not found')
    })
    const { mux, sent, opened, closedReasons } = makeMux({ openService })

    const { header, payload } = openFrame(7, 'shell:echo hi\0')
    mux.handleFrame(header, payload)
    await flush()

    expect(sent).toHaveLength(1)
    const reply = readSent(sent[0] as Uint8Array)
    expect(reply.command).toBe('CLSE')
    expect(reply.arg0).toBe(0)
    expect(reply.arg1).toBe(7)
    expect(opened).toEqual([])
    expect(closedReasons).toEqual([{ service: 'shell:echo hi', reason: 'backend_error' }])
    expect(mux.size).toBe(0)
  })
})

describe('createStreamMux — flow control (ready-window WRTE/OKAY)', () => {
  test('backend data is sent as WRTE and the next chunk waits for the host OKAY', async () => {
    const backend = makeFakeBackend()
    const { mux, sent } = makeMux({ openService: mock(async () => backend.stream) })

    const open = openFrame(5, 'shell:cat\0')
    mux.handleFrame(open.header, open.payload)
    await flush()
    expect(sent).toHaveLength(1) // just the OKAY so far

    backend.emit(te.encode('first-chunk'))
    expect(sent).toHaveLength(2)
    let frame = readSent(sent[1] as Uint8Array)
    expect(frame.command).toBe('WRTE')
    expect(frame.payload).toBe('first-chunk')

    // A second chunk arrives before the host has acked the first — it must
    // queue, not jump the ready window.
    backend.emit(te.encode('second-chunk'))
    expect(sent).toHaveLength(2)

    // The host's OKAY(hostId, ourId) acks the outstanding WRTE and releases the queue.
    const ack = okayFrame(5, 1)
    mux.handleFrame(ack.header, ack.payload)
    expect(sent).toHaveLength(3)
    frame = readSent(sent[2] as Uint8Array)
    expect(frame.command).toBe('WRTE')
    expect(frame.payload).toBe('second-chunk')
  })

  test('backend end triggers our own CLSE and closes the backend', async () => {
    const backend = makeFakeBackend()
    const { mux, sent, closedReasons } = makeMux({ openService: mock(async () => backend.stream) })

    const open = openFrame(9, 'shell:echo hi\0')
    mux.handleFrame(open.header, open.payload)
    await flush()

    backend.end()
    expect(backend.closed).toBe(true)
    const last = readSent(sent[sent.length - 1] as Uint8Array)
    expect(last.command).toBe('CLSE')
    expect(last.arg0).toBe(1)
    expect(last.arg1).toBe(9)
    expect(closedReasons).toEqual([{ service: 'shell:echo hi', reason: 'closed' }])
    expect(mux.size).toBe(0)
  })
})

describe('createStreamMux — bidirectional WRTE (host → backend)', () => {
  test('a WRTE from the host is forwarded to the backend and acked with OKAY', async () => {
    const backend = makeFakeBackend()
    const { mux, sent } = makeMux({ openService: mock(async () => backend.stream) })

    const open = openFrame(3, 'sync:\0')
    mux.handleFrame(open.header, open.payload)
    await flush()

    const wrte = wrteFrame(3, 1, te.encode('payload-bytes'))
    mux.handleFrame(wrte.header, wrte.payload)

    expect(backend.written).toHaveLength(1)
    expect(td.decode(backend.written[0] as Uint8Array)).toBe('payload-bytes')

    const ack = readSent(sent[sent.length - 1] as Uint8Array)
    expect(ack.command).toBe('OKAY')
    expect(ack.arg0).toBe(1)
    expect(ack.arg1).toBe(3)
  })

  test('a WRTE for an unknown stream id is refused with CLSE(0, id)', () => {
    const { mux, sent } = makeMux()
    const wrte = wrteFrame(999, 1, te.encode('x'))
    mux.handleFrame(wrte.header, wrte.payload)
    const reply = readSent(sent[0] as Uint8Array)
    expect(reply.command).toBe('CLSE')
    expect(reply.arg0).toBe(0)
    expect(reply.arg1).toBe(999)
  })
})

describe('createStreamMux — CLSE propagation', () => {
  test('a host-initiated CLSE closes the backend and echoes CLSE once', async () => {
    const backend = makeFakeBackend()
    const { mux, sent } = makeMux({ openService: mock(async () => backend.stream) })

    const open = openFrame(11, 'shell:sleep 100\0')
    mux.handleFrame(open.header, open.payload)
    await flush()
    const sentBeforeClose = sent.length

    const clse = clseFrame(11, 1)
    mux.handleFrame(clse.header, clse.payload)

    expect(backend.closed).toBe(true)
    expect(sent).toHaveLength(sentBeforeClose + 1)
    const reply = readSent(sent[sent.length - 1] as Uint8Array)
    expect(reply.command).toBe('CLSE')
    expect(reply.arg0).toBe(1)
    expect(reply.arg1).toBe(11)
    expect(mux.size).toBe(0)

    // A second CLSE for the same (now-gone) stream must not crash or send
    // another reply — it is the peer's own echo of ours, or a stray repeat.
    const secondSendCount = sent.length
    mux.handleFrame(clse.header, clse.payload)
    expect(sent).toHaveLength(secondSendCount)
  })

  test('CLSE for an unknown stream is ignored, not an error', () => {
    const { mux, sent } = makeMux()
    const clse = clseFrame(123, 1)
    expect(() => mux.handleFrame(clse.header, clse.payload)).not.toThrow()
    expect(sent).toHaveLength(0)
  })

  test('a CLSE that arrives before openService resolves closes the backend once it does, with no leak', async () => {
    const backend = makeFakeBackend()
    const box: { resolve: ((s: RawStream) => void) | null } = { resolve: null }
    const openService = mock(
      () =>
        new Promise<RawStream>((resolve) => {
          box.resolve = resolve
        }),
    )
    const { mux, sent } = makeMux({ openService })

    const open = openFrame(21, 'shell:slow\0')
    mux.handleFrame(open.header, open.payload)
    // Not yet resolved — the stream is a placeholder, no OKAY sent yet.
    expect(sent).toHaveLength(0)

    const clse = clseFrame(21, 1)
    mux.handleFrame(clse.header, clse.payload)
    // The close used id 0: the host was never told our real id (no OKAY sent yet).
    const closeReply = readSent(sent[0] as Uint8Array)
    expect(closeReply.command).toBe('CLSE')
    expect(closeReply.arg0).toBe(0)
    expect(mux.size).toBe(0)

    // Now the backend connection finally comes through — it must be closed
    // immediately rather than resurrected or leaked.
    box.resolve?.(backend.stream)
    await flush()
    expect(backend.closed).toBe(true)
    expect(mux.size).toBe(0)
  })
})

describe('createStreamMux — the stream cap (plan §3.5)', () => {
  test('refuses an OPEN past maxStreams with CLSE(0, hostId); existing streams keep working', async () => {
    const backendA = makeFakeBackend()
    const openService = mock(async () => backendA.stream)
    const { mux, sent, opened } = makeMux({ maxStreams: 1, openService })

    const openA = openFrame(1, 'shell:a\0')
    mux.handleFrame(openA.header, openA.payload)
    await flush()
    expect(mux.size).toBe(1)
    expect(opened).toEqual(['shell:a'])

    const openB = openFrame(2, 'shell:b\0')
    mux.handleFrame(openB.header, openB.payload)
    // Refused synchronously — openService must not even be called for B.
    expect(openService).toHaveBeenCalledTimes(1)
    const refusal = readSent(sent[sent.length - 1] as Uint8Array)
    expect(refusal.command).toBe('CLSE')
    expect(refusal.arg0).toBe(0)
    expect(refusal.arg1).toBe(2)
    expect(mux.size).toBe(1)

    // Stream A is unaffected: it still streams data normally.
    backendA.emit(te.encode('still-alive'))
    const last = readSent(sent[sent.length - 1] as Uint8Array)
    expect(last.command).toBe('WRTE')
    expect(last.payload).toBe('still-alive')
  })
})

describe('createStreamMux — no id leaks across many streams', () => {
  test('ids are monotonic and every closed stream frees its slot', async () => {
    const backends = [makeFakeBackend(), makeFakeBackend(), makeFakeBackend()]
    let call = 0
    const openService = mock(async () => backends[call++]!.stream)
    const { mux, sent } = makeMux({ maxStreams: 8, openService })

    for (let i = 0; i < 3; i++) {
      const open = openFrame(100 + i, `shell:cmd${i}\0`)
      mux.handleFrame(open.header, open.payload)
    }
    await flush()
    expect(mux.size).toBe(3)
    const okays = sent.map(readSent).filter((f) => f.command === 'OKAY')
    expect(okays.map((f) => f.arg0)).toEqual([1, 2, 3]) // monotonic, one per stream

    for (const backend of backends) backend.end()
    expect(mux.size).toBe(0)
  })
})

describe('createStreamMux — deferred WRTE ack (plan 28 §3.3)', () => {
  test('a backend whose write() returns a pending promise withholds the OKAY until it settles', async () => {
    // A "remote" backend: write() hands the chunk off (synchronously
    // recorded here) but does not resolve until the test says so — modelling
    // a write that is still waiting on the agent's `adb.ack`.
    // A plain mutable box (the same pattern the "arrives before openService
    // resolves" test above uses) rather than a bare `let` — sidesteps a TS
    // narrowing quirk when a `let` is only ever assigned from inside a
    // nested closure.
    const box: { resolve: (() => void) | null } = { resolve: null }
    const written: Uint8Array[] = []
    const backendStream: RawStream = {
      write(chunk) {
        written.push(chunk)
        return new Promise<void>((resolve) => {
          box.resolve = () => resolve()
        })
      },
      streamFrom() {},
      close() {},
    }
    const { mux, sent } = makeMux({ openService: mock(async () => backendStream) })

    const open = openFrame(3, 'sync:\0')
    mux.handleFrame(open.header, open.payload)
    await flush()
    const sentBeforeWrte = sent.length

    const wrte = wrteFrame(3, 1, te.encode('a-big-chunk'))
    mux.handleFrame(wrte.header, wrte.payload)

    // The bytes were handed to the backend immediately (no local buffering)...
    expect(written).toHaveLength(1)
    // ...but the WRTE's OKAY must NOT have been sent yet — the window does
    // not advance on a mere handoff to the backend.
    expect(sent).toHaveLength(sentBeforeWrte)

    // Only once the backend's write settles (the stand-in for `adb.ack`
    // arriving) does the OKAY follow.
    box.resolve?.()
    await flush()
    expect(sent).toHaveLength(sentBeforeWrte + 1)
    const ack = readSent(sent[sent.length - 1] as Uint8Array)
    expect(ack.command).toBe('OKAY')
    expect(ack.arg0).toBe(1)
    expect(ack.arg1).toBe(3)
  })
})

describe('createStreamMux — closeAll', () => {
  test('tears every stream down without sending a reply frame', async () => {
    const backendA = makeFakeBackend()
    const backendB = makeFakeBackend()
    let call = 0
    const openService = mock(async () => [backendA.stream, backendB.stream][call++]!)
    const { mux, sent, closedReasons } = makeMux({ openService })

    const openA = openFrame(1, 'shell:a\0')
    const openB = openFrame(2, 'shell:b\0')
    mux.handleFrame(openA.header, openA.payload)
    mux.handleFrame(openB.header, openB.payload)
    await flush()
    expect(mux.size).toBe(2)
    const sentBeforeTeardown = sent.length

    mux.closeAll('connection_closed')

    expect(sent).toHaveLength(sentBeforeTeardown) // no frames — there is no peer left
    expect(backendA.closed).toBe(true)
    expect(backendB.closed).toBe(true)
    expect(mux.size).toBe(0)
    expect(closedReasons).toEqual([
      { service: 'shell:a', reason: 'connection_closed' },
      { service: 'shell:b', reason: 'connection_closed' },
    ])
  })
})
