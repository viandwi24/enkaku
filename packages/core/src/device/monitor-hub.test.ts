import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createLogger } from '../util/logger'
import type { ShellPort } from './shell-port'
import { createMonitorHub, runOneshotMonitor, STREAM_CLOCK_OVERRIDES } from './monitor-hub'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function seedDevice(db: Db, id: string, serial: string): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial, label: `Phone ${id}`, status: 'idle' }).run()
}

interface FakeStreamRecord {
  serial: string
  cmd: string
  stopped: boolean
  /** The clock options `MonitorHub` actually passed to `ShellPort.stream()` (plan 85 §5 step 85.4). */
  idleTimeoutMs?: number
  absoluteTimeoutMs?: number
  maxBytes?: number
  emit(text: string): void
}

/**
 * A fake `ShellPort` factory whose `stream()` is fully test-controlled — no
 * real adb socket, and no remote tunnel involved (plan 25 §5.3 refactor:
 * `MonitorHub` now consumes a `ShellPort`, not an `AdbClient`, so the fixture
 * has to speak that interface instead). Resolves the device's serial from the
 * same seeded table `ws-handlers.ts`'s real `shellPortFor` would use, so
 * assertions that check "the right device's stream started" still make sense.
 */
function createFakeShellPortFactory(db: Db): { shellPort: (deviceId: string) => ShellPort; calls: FakeStreamRecord[] } {
  const calls: FakeStreamRecord[] = []
  const shellPort = (deviceId: string): ShellPort => {
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) throw new EnkakuError('device_not_found', 'no such device')
    return {
      async exec() {
        throw new Error('not used by these tests')
      },
      async stream(cmd, opts) {
        const record: FakeStreamRecord = {
          serial: row.serial,
          cmd,
          stopped: false,
          idleTimeoutMs: opts.idleTimeoutMs,
          absoluteTimeoutMs: opts.absoluteTimeoutMs,
          maxBytes: opts.maxBytes,
          emit(text: string) {
            opts.onData(new TextEncoder().encode(text))
          },
        }
        calls.push(record)
        return {
          streamId: `${row.serial}-stream`,
          stop: async () => {
            record.stopped = true
            opts.onEnd('stopped')
          },
        }
      },
    }
  }
  return { shellPort, calls }
}

function setup() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db
  seedDevice(db, 'dev-1', 'SER1')
  const { shellPort, calls } = createFakeShellPortFactory(db)
  const dataEvents: Array<{ streamId: string; lines: string[] }> = []
  const endedEvents: Array<{ streamId: string; reason: string }> = []
  const subscriberEvents: Array<{ streamId: string; count: number }> = []
  const hub = createMonitorHub({
    shellPort,
    log: createLogger('test'),
    onData: (streamId, lines) => dataEvents.push({ streamId, lines }),
    onEnded: (streamId, reason) => endedEvents.push({ streamId, reason }),
    onSubscribersChanged: (streamId, count) => subscriberEvents.push({ streamId, count }),
  })
  return { db, hub, calls, dataEvents, endedEvents, subscriberEvents }
}

describe('MonitorHub (plan 24 §4.5) — with a fake ShellPort', () => {
  test('two subscribers to the same (device, kind, options) share exactly one adb stream', async () => {
    const { hub, calls } = setup()
    const a = await hub.subscribe('client-a', 'dev-1', 'logcat', { priority: 'V' })
    const b = await hub.subscribe('client-b', 'dev-1', 'logcat', { priority: 'V' })
    expect(a.streamId).toBe(b.streamId)
    expect(calls).toHaveLength(1) // ONE logcat process for two viewers
    expect(calls[0]?.serial).toBe('SER1')
  })

  test('different options resolve to a different stream (and a second adb process)', async () => {
    const { hub, calls } = setup()
    const a = await hub.subscribe('client-a', 'dev-1', 'logcat', { priority: 'V' })
    const b = await hub.subscribe('client-b', 'dev-1', 'logcat', { priority: 'E' })
    expect(a.streamId).not.toBe(b.streamId)
    expect(calls).toHaveLength(2)
  })

  test('a joining subscriber gets the backlog immediately (plan 24 §3.5, acceptance #8)', async () => {
    const { hub, calls } = setup()
    await hub.subscribe('client-a', 'dev-1', 'logcat', {})
    calls[0]?.emit('line one\nline two\n')
    await sleep(150) // past the 100ms flush interval, so the ring buffer has both lines

    const late = await hub.subscribe('client-b', 'dev-1', 'logcat', {})
    expect(late.backlog).toEqual(['line one', 'line two'])
  })

  test('data is batched and delivered via onData, not one callback per raw chunk', async () => {
    const { hub, calls, dataEvents } = setup()
    const { streamId } = await hub.subscribe('client-a', 'dev-1', 'top', {})
    calls[0]?.emit('a\n')
    calls[0]?.emit('b\n')
    calls[0]?.emit('c\n')
    expect(dataEvents).toHaveLength(0) // not yet flushed
    await sleep(150)
    expect(dataEvents).toHaveLength(1)
    expect(dataEvents[0]).toEqual({ streamId, lines: ['a', 'b', 'c'] })
  })

  test('the last subscriber leaving stops the underlying stream (ref counting)', async () => {
    const { hub, calls, subscriberEvents } = setup()
    const { streamId } = await hub.subscribe('client-a', 'dev-1', 'logcat', {})
    await hub.subscribe('client-b', 'dev-1', 'logcat', {})
    expect(calls[0]?.stopped).toBe(false)

    hub.unsubscribe('client-a', streamId)
    expect(calls[0]?.stopped).toBe(false) // client-b is still watching

    hub.unsubscribe('client-b', streamId)
    expect(calls[0]?.stopped).toBe(true) // the last viewer left
    expect(subscriberEvents.at(-1)).toEqual({ streamId, count: 0 })
  })

  test('unsubscribing a client that never subscribed to that streamId is a no-op', async () => {
    const { hub } = setup()
    expect(() => hub.unsubscribe('nobody', 'dev-1:logcat:whatever')).not.toThrow()
  })

  test('releaseClient (WS close) drops every subscription that connection held, stopping streams that reach zero', async () => {
    const { hub, calls } = setup()
    const { streamId: logcatId } = await hub.subscribe('client-a', 'dev-1', 'logcat', {})
    const { streamId: topId } = await hub.subscribe('client-a', 'dev-1', 'top', {})
    await hub.subscribe('client-b', 'dev-1', 'logcat', {}) // keeps logcat alive after client-a leaves

    hub.releaseClient('client-a')

    const logcatCall = calls.find((c) => c.cmd.startsWith('logcat'))
    const topCall = calls.find((c) => c.cmd.startsWith('top'))
    expect(topCall?.stopped).toBe(true) // client-a was its only subscriber
    expect(logcatCall?.stopped).toBe(false) // client-b still holds it
    void logcatId
    void topId
  })

  test('stopForDevice stops every stream on that device even with subscribers still attached', async () => {
    const { hub, calls, endedEvents } = setup()
    const { streamId } = await hub.subscribe('client-a', 'dev-1', 'logcat', {})
    await hub.subscribe('client-b', 'dev-1', 'logcat', {})

    hub.stopForDevice('dev-1')
    await sleep(10) // the stop's onEnd callback resolves asynchronously

    expect(calls[0]?.stopped).toBe(true)
    expect(endedEvents.some((e) => e.streamId === streamId)).toBe(true)

    // Both subscriptions were cleared — a fresh subscribe starts a NEW stream.
    const rejoined = await hub.subscribe('client-a', 'dev-1', 'logcat', {})
    expect(calls).toHaveLength(2)
    void rejoined
  })

  test('subscribing to a one-shot kind (ps/meminfo/df) is rejected — those go through monitor.oneshot, not the hub', async () => {
    const { hub } = setup()
    await expect(hub.subscribe('client-a', 'dev-1', 'ps', {})).rejects.toThrow()
  })

  test('an unknown device rejects, and does not leave a zombie entry behind', async () => {
    const { hub, dataEvents } = setup()
    await expect(hub.subscribe('client-a', 'no-such-device', 'logcat', {})).rejects.toThrow()
    // A second attempt does not silently join a broken entry — it tries again cleanly.
    await expect(hub.subscribe('client-a', 'no-such-device', 'logcat', {})).rejects.toThrow()
    expect(dataEvents).toHaveLength(0)
  })
})

describe('MonitorHub — per-kind stream clocks (plan 85 §3.2, §5 step 85.4)', () => {
  test('the crash kind gets both clocks OFF and a 32 MiB byte cap, mirroring the ui-server precedent (inspector-factory.ts:86-93)', async () => {
    const { hub, calls } = setup()
    await hub.subscribe('internal:crash', 'dev-1', 'crash', {})
    expect(calls).toHaveLength(1)
    expect(calls[0]?.idleTimeoutMs).toBe(0)
    expect(calls[0]?.absoluteTimeoutMs).toBe(0)
    expect(calls[0]?.maxBytes).toBe(32 * 1024 * 1024)
  })

  test('every other streaming kind is untouched — no clock override is passed at all', async () => {
    const { hub, calls } = setup()
    await hub.subscribe('client-a', 'dev-1', 'logcat', {})
    await hub.subscribe('client-a', 'dev-1', 'top', {})
    await hub.subscribe('client-a', 'dev-1', 'thermal', {})
    for (const call of calls) {
      expect(call.idleTimeoutMs).toBeUndefined()
      expect(call.absoluteTimeoutMs).toBeUndefined()
      expect(call.maxBytes).toBeUndefined()
    }
  })

  test('STREAM_CLOCK_OVERRIDES only names "crash" — the documented single exception', () => {
    expect(Object.keys(STREAM_CLOCK_OVERRIDES)).toEqual(['crash'])
    expect(STREAM_CLOCK_OVERRIDES.crash).toEqual({ idleTimeoutMs: 0, absoluteTimeoutMs: 0, maxBytes: 32 * 1024 * 1024 })
  })
})

describe('runOneshotMonitor (plan 24 §4.3) — ps/meminfo/df, through the normal queue, never the lane', () => {
  test('runs the fixed command for the kind and returns its output', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    seedDevice(opened.db, 'dev-1', 'SER1')
    const seenCommands: string[] = []
    const shellPort = (): ShellPort => ({
      async exec(cmd) {
        seenCommands.push(cmd)
        return { stdout: 'total 100  used 40  free 60', stderr: '', exitCode: null, truncated: false }
      },
      async stream() {
        throw new Error('not used by this test')
      },
    })
    const result = await runOneshotMonitor({ shellPort }, 'dev-1', 'df')
    expect(seenCommands).toEqual(['df -h'])
    expect(result).toEqual({ text: 'total 100  used 40  free 60', truncated: false })
  })

  test('rejects a streaming kind — that path is monitor.start, not monitor.oneshot', async () => {
    const shellPort = (): ShellPort => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: null, truncated: false }
      },
      async stream() {
        throw new Error('not used by this test')
      },
    })
    await expect(runOneshotMonitor({ shellPort }, 'dev-1', 'logcat')).rejects.toThrow()
  })

  test('rejects an unknown device', async () => {
    const shellPort = (deviceId: string): ShellPort => {
      throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
    }
    await expect(runOneshotMonitor({ shellPort }, 'ghost', 'ps')).rejects.toThrow()
  })
})
