import { describe, expect, test } from 'bun:test'
import { DeviceTracker, diffSnapshots, parseSnapshot, type TrackerEvent } from './tracker'

/** `host:track-devices` frames: OKAY once, then a 4-hex-digit length per snapshot block. */
function block(body: string): string {
  return body.length.toString(16).padStart(4, '0') + body
}

interface FakeServer {
  port: number
  /** Push a snapshot to every currently connected tracker. */
  push(body: string): void
  /** Drop the live connection without answering again — what a dying adb server looks like. */
  dropConnections(): void
  connections: number
  stop(): void
}

function fakeAdbServer(): FakeServer {
  const open = new Set<{ write(s: string): void; end(): void }>()
  let connections = 0
  const listener = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        connections++
        open.add(socket as unknown as { write(s: string): void; end(): void })
      },
      data(socket, data) {
        // The only request this fake understands is the tracker's own.
        if (!data.toString().includes('host:track-devices')) return
        socket.write('OKAY')
      },
      close(socket) {
        open.delete(socket as unknown as { write(s: string): void; end(): void })
      },
      error() {},
    },
  })
  return {
    port: listener.port,
    push(body) {
      for (const s of open) s.write(block(body))
    },
    dropConnections() {
      for (const s of open) s.end()
      open.clear()
    },
    get connections() {
      return connections
    },
    stop() {
      listener.stop(true)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FARM = 'A\tdevice\nB\tdevice\nC\tdevice\n'

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('timed out waiting for condition')
}

describe('DeviceTracker — a reconnect does not report the farm as removed', () => {
  test('the first snapshot after a reconnect is a re-enumeration baseline, not 3 removals', async () => {
    const server = fakeAdbServer()
    const events: TrackerEvent[] = []
    const tracker = new DeviceTracker({ host: '127.0.0.1', port: server.port, reenumerationGraceMs: 5_000 })
    tracker.on((ev) => events.push(ev))
    try {
      await tracker.start()
      await waitFor(() => server.connections >= 1)
      server.push(FARM)
      await waitFor(() => events.filter((e) => e.kind === 'add').length === 3)

      // The adb server dies and comes back empty — exactly what `start-server`
      // produces before USB re-enumeration completes.
      events.length = 0
      server.dropConnections()
      await waitFor(() => server.connections >= 2, 5_000)
      server.push('')
      await sleep(200)

      expect(events.filter((e) => e.kind === 'remove')).toHaveLength(0)
      // And the farm is still known, so nothing downstream was torn down.
      expect(tracker.snapshot().map((d) => d.serial).sort()).toEqual(['A', 'B', 'C'])
    } finally {
      await tracker.stop()
      server.stop()
    }
  })

  test('a device that re-enumerates during the window is reported immediately', async () => {
    const server = fakeAdbServer()
    const events: TrackerEvent[] = []
    const tracker = new DeviceTracker({ host: '127.0.0.1', port: server.port, reenumerationGraceMs: 5_000 })
    tracker.on((ev) => events.push(ev))
    try {
      await tracker.start()
      await waitFor(() => server.connections >= 1)
      server.push(FARM)
      await waitFor(() => events.length === 3)

      events.length = 0
      server.dropConnections()
      await waitFor(() => server.connections >= 2, 5_000)
      // B comes back needing authorisation — good news, and it must not wait.
      server.push('A\tdevice\nB\tunauthorized\n')
      await waitFor(() => events.some((e) => e.kind === 'change' && e.serial === 'B'))

      expect(events.find((e) => e.kind === 'change' && e.serial === 'B')).toMatchObject({ state: 'unauthorized' })
      expect(events.filter((e) => e.kind === 'remove')).toHaveLength(0)
    } finally {
      await tracker.stop()
      server.stop()
    }
  })

  test('once the window lapses, a device still absent is reported removed', async () => {
    const server = fakeAdbServer()
    const events: TrackerEvent[] = []
    const tracker = new DeviceTracker({ host: '127.0.0.1', port: server.port, reenumerationGraceMs: 150 })
    tracker.on((ev) => events.push(ev))
    try {
      await tracker.start()
      await waitFor(() => server.connections >= 1)
      server.push(FARM)
      await waitFor(() => events.length === 3)

      events.length = 0
      server.dropConnections()
      await waitFor(() => server.connections >= 2, 5_000)
      server.push('A\tdevice\nB\tdevice\n') // C did not come back
      await sleep(300) // let the short window lapse
      server.push('A\tdevice\nB\tdevice\n')

      await waitFor(() => events.some((e) => e.kind === 'remove' && e.serial === 'C'))
      expect(events.filter((e) => e.kind === 'remove').map((e) => e.serial)).toEqual(['C'])
    } finally {
      await tracker.stop()
      server.stop()
    }
  })

  test('reenumerationGraceMs: 0 restores the immediate-diff behaviour', async () => {
    const server = fakeAdbServer()
    const events: TrackerEvent[] = []
    const tracker = new DeviceTracker({ host: '127.0.0.1', port: server.port, reenumerationGraceMs: 0 })
    tracker.on((ev) => events.push(ev))
    try {
      await tracker.start()
      await waitFor(() => server.connections >= 1)
      server.push(FARM)
      await waitFor(() => events.length === 3)

      events.length = 0
      server.dropConnections()
      await waitFor(() => server.connections >= 2, 5_000)
      server.push('')
      await waitFor(() => events.filter((e) => e.kind === 'remove').length === 3)
      expect(events.filter((e) => e.kind === 'remove').map((e) => e.serial).sort()).toEqual(['A', 'B', 'C'])
    } finally {
      await tracker.stop()
      server.stop()
    }
  })

  test('the FIRST connect is authoritative — an empty farm at boot is not withheld', async () => {
    const server = fakeAdbServer()
    const events: TrackerEvent[] = []
    const tracker = new DeviceTracker({ host: '127.0.0.1', port: server.port, reenumerationGraceMs: 5_000 })
    tracker.on((ev) => events.push(ev))
    try {
      await tracker.start()
      await waitFor(() => server.connections >= 1)
      server.push(FARM)
      await waitFor(() => events.length === 3)
      // No reconnect happened, so a genuine unplug still reports at once.
      server.push('A\tdevice\nB\tdevice\n')
      await waitFor(() => events.some((e) => e.kind === 'remove' && e.serial === 'C'))
    } finally {
      await tracker.stop()
      server.stop()
    }
  })
})

describe('parseSnapshot / diffSnapshots stay pure', () => {
  test('diffSnapshots reports add, change and remove', () => {
    const prev = parseSnapshot('A\tdevice\nB\tdevice\n')
    const next = parseSnapshot('A\tunauthorized\nC\tdevice\n')
    expect(diffSnapshots(prev, next)).toEqual([
      { kind: 'change', serial: 'A', state: 'unauthorized' },
      { kind: 'add', serial: 'C', state: 'device' },
      { kind: 'remove', serial: 'B' },
    ])
  })
})
