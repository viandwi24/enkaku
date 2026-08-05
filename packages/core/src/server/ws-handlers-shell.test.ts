import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { AdbError, type AdbClient, type AdbExecOptions, type ShellResult } from '@enkaku/adb'
import type { DisplaySource, InputSink, ServerMessage, ShellMode, Transport } from '@enkaku/protocol'
import type { DeviceSession, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createJobStore } from '../queue/job-store'
import { createLeaseManager } from '../lease/lease-manager'
import { createLogger } from '../util/logger'
import type { Role } from '../auth/service'
import { createWsMessageHandler, type WsHandlerDeps } from './ws-handlers'

/**
 * The interactive terminal's WS wiring (plan 26 §4.3, §7; transport
 * migrated to the framed shell by plan 53): the refusal matrix (no lease /
 * busy / wrong holder / no permission / mode off), the record-ordering rule
 * (a refusal records nothing, an accepted command records exactly two
 * rows), redaction, and the exit-code/cd round trip — all exercised against
 * the REAL `createWsMessageHandler` and REAL `LeaseManager`, with only the
 * adb socket and the surrounding services faked.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string, status: 'idle' | 'busy' | 'offline' = 'idle'): void {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status }).run()
}

function fakeSession(deviceId: string): DeviceSession {
  return {
    deviceId,
    transport: {} as unknown as Transport,
    display: {} as unknown as DisplaySource,
    input: {} as unknown as InputSink,
    displayEngineId: 'screencap-loop',
    quality: 'control',
    inputEngineId: 'adb-input',
    videoConfig: () => null,
    videoKeyframe: () => null,
    inspector: null,
    whenInspectorReady: async () => {},
    releaseInspector: async () => {},
    inspectorEngineId: 'ui-server',
    inspectorPollIntervalMs: 200,
    frameSize: { width: 1080, height: 2400 },
    clipboard: null,
    close: async () => {},
  }
}

function fakeSessionManager(): SessionManager {
  const sessions = new Map<string, DeviceSession>()
  return {
    async acquire(deviceId) {
      let s = sessions.get(deviceId)
      if (!s) {
        s = fakeSession(deviceId)
        sessions.set(deviceId, s)
      }
      return s
    },
    release() {},
    get: (deviceId) => sessions.get(deviceId) ?? null,
    async closeDevice() {},
    async closeIfIdle() {},
    idleSessions: () => [],
    async closeAll() {},
  }
}

function fakeConn(): { ws: ServerWebSocket<unknown>; sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  const ws = {
    readyState: 1,
    data: { userId: null },
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
    getBufferedAmount: () => 0,
  } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

interface RecordedEvent {
  deviceId: string
  stream: string
  kind: string
  actor?: string | null
  meta?: Record<string, unknown>
}

/** A scriptable `AdbClient.exec` — enough surface for the local `ShellPort` (plan 25 §4.3). */
function fakeAdbClient(execImpl: (serial: string, cmd: string, opts?: AdbExecOptions) => Promise<ShellResult>): AdbClient {
  return { exec: execImpl } as unknown as AdbClient
}

function setUpHandler(
  db: Db,
  client: AdbClient,
  opts?: { role?: Role; shellMode?: ShellMode },
): { handler: ReturnType<typeof createWsMessageHandler>; events: RecordedEvent[] } {
  const log = createLogger('test')
  const states = createDeviceStateMachine({ db, log })
  const jobStore = createJobStore(db)
  const leases = createLeaseManager({
    states,
    jobStore,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
    log,
    onJobLeaseExpired: () => {},
  })
  const events: RecordedEvent[] = []
  const deps: WsHandlerDeps = {
    sessions: fakeSessionManager(),
    pairing: {
      request: async () => {
        throw new Error('not used')
      },
      submitCode: async () => {
        throw new Error('not used')
      },
    },
    leases,
    jobs: {
      enqueue: () => {
        throw new Error('not used')
      },
      cancel: () => {
        throw new Error('not used')
      },
      get: () => null,
      list: () => ({ jobs: [], nextCursor: null, total: 0 }),
    },
    broadcast: () => {},
    recorder: { record: (e) => void events.push(e), stop: async () => {} },
    audit: { record: () => {}, list: () => [] },
    isLogInputTextEnabled: () => false,
    roleOf: () => opts?.role ?? 'admin',
    shellSettings: () => ({ mode: opts?.shellMode ?? 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
    // This suite is about the terminal (plan 26), not the adb endpoint
    // (plan 27) — a fake that never actually opens anything is enough here.
    adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
    adb: () => client,
    // Crash detection (plan 37) is exercised in its own suites
    // (`crash-watcher.test.ts`); this suite is about the terminal.
    crashPolicy: () => 'declared',
    targetPackagesForJob: () => [],
    saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
    db,
    log,
  }
  return { handler: createWsMessageHandler(deps), events }
}

async function acquireLease(handler: ReturnType<typeof createWsMessageHandler>, ws: ServerWebSocket<unknown>, deviceId: string): Promise<void> {
  await handler.handleMessage(ws, JSON.stringify({ type: 'lease.acquire', id: 'l1', payload: { deviceId } }))
}

/** A framed shell result — real `stdout`/`stderr`/`exitCode`, no marker involved (plan 53). */
function shellResult(stdout: string, exitCode: number | null, stderr = ''): ShellResult {
  return { stdout, stderr, exitCode }
}

describe('shell.exec refusal matrix (plan 26 acceptance #1-4, §7)', () => {
  test('no lease → refused with no_lease, even though the device is idle', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('no_lease')
    expect(events).toHaveLength(0) // a refused command produces no event-log rows (acceptance #5)
  })

  test('device busy (a job is running) → refused with device_busy', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'busy')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('device_busy')
    expect(events).toHaveLength(0)
  })

  test('another client holds the lease → refused (not the lease holder)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client)
    const holder = fakeConn()
    const bystander = fakeConn()

    await acquireLease(handler, holder.ws, 'dev-1')
    events.length = 0 // drop the `control.acquired` row from the acquire above — not what this test checks
    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const err = bystander.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(['not_lease_holder', 'no_lease']).toContain(err.payload.code)
    expect(events).toHaveLength(0)
  })

  test('no device.shell permission (operator, mode "admin") → refused with auth.forbidden', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client, { role: 'operator', shellMode: 'admin' })
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('auth.forbidden')
    expect(events).toHaveLength(0)
  })

  test('shell.mode "off" refuses even an admin holding the lease', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client, { role: 'admin', shellMode: 'off' })
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const err = a.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    if (err?.type === 'error') expect(err.payload.code).toBe('auth.forbidden')
    expect(events).toHaveLength(0)
  })

  test('shell.mode "operator" admits an operator holding the lease', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client, { role: 'operator', shellMode: 'operator' })
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    expect(a.sent.some((m) => m.type === 'error')).toBe(false)
    expect(a.sent.some((m) => m.type === 'shell.result')).toBe(true)
  })
})

describe('shell.exec accepted path (plan 26 acceptance #5-7, #9)', () => {
  test('echo hi → stdout "hi", exit 0, and exactly two event-log rows in order (shell.exec then shell.result)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async (_serial, cmd) => {
      expect(cmd).toContain('echo hi')
      return shellResult('hi', 0)
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const echo = a.sent.find((m) => m.type === 'shell.echo')
    const result = a.sent.find((m) => m.type === 'shell.result')
    expect(echo).toBeDefined()
    expect(result).toBeDefined()
    if (result?.type === 'shell.result') {
      expect(result.payload.stdout).toBe('hi')
      expect(result.payload.exitCode).toBe(0)
      expect(result.payload.truncated).toBe(false)
    }
    expect(events.map((e) => e.kind)).toEqual(['shell.exec', 'shell.result'])
  })

  test('a non-zero exit (`false`) is reported as exitCode 1, not swallowed as an error', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('', 1))
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'false' } }))

    const result = a.sent.find((m) => m.type === 'shell.result')
    if (result?.type === 'shell.result') expect(result.payload.exitCode).toBe(1)
    else throw new Error('no shell.result received')
  })

  test('stderr travels to the terminal as its own field, never folded into stdout (plan 53)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('normal output', 1, 'the error text'))
    const { handler } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'a-command' } }))

    const result = a.sent.find((m) => m.type === 'shell.result')
    if (result?.type === 'shell.result') {
      expect(result.payload.stdout).toBe('normal output')
      expect(result.payload.stderr).toBe('the error text')
      expect(result.payload.exitCode).toBe(1)
    } else throw new Error('no shell.result received')
  })

  test('a failure raised by the core reports itself on stderr — stdout stays empty because the command printed nothing', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => {
      throw new AdbError('E_ADB_TIMEOUT', 'adb shell:sleep 99 exceeded 15000ms')
    })
    const { handler } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'sleep 99' } }))

    const result = a.sent.find((m) => m.type === 'shell.result')
    if (result?.type === 'shell.result') {
      expect(result.payload.stdout).toBe('')
      expect(result.payload.stderr).toBe('adb shell:sleep 99 exceeded 15000ms')
      expect(result.payload.exitCode).toBeNull()
    } else throw new Error('no shell.result received')
  })

  test('a command whose output exceeds the cap (E_ADB_OUTPUT_LIMIT) reports truncated: true and a null exit code', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => {
      // The local ShellPort has no partial-truncation return value — it
      // throws instead of resolving with a truncated flag (`shell-port.ts`).
      throw new AdbError('E_ADB_OUTPUT_LIMIT', 'output exceeded the configured cap')
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'yes' } }))

    const result = a.sent.find((m) => m.type === 'shell.result')
    if (result?.type === 'shell.result') {
      expect(result.payload.exitCode).toBeNull()
      expect(result.payload.truncated).toBe(true)
      expect(result.payload.hint).toBeUndefined() // a cap hit is not a deadline — no stream_suggested
    } else throw new Error('no shell.result received')
    expect(events.map((e) => e.kind)).toEqual(['shell.exec', 'shell.result'])
  })

  test('a device that could not report an exit code (killed shell, or an unframed fallback) reports exitCode null and truncated: false', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('partial output — the shell was killed before it could exit normally', null))
    const { handler } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'yes' } }))

    const result = a.sent.find((m) => m.type === 'shell.result')
    if (result?.type === 'shell.result') {
      expect(result.payload.exitCode).toBeNull()
      expect(result.payload.truncated).toBe(false)
    } else throw new Error('no shell.result received')
  })

  test('credential-bearing flags are redacted in the recorded shell.exec event, but not in what runs', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    let sentToDevice = ''
    const client = fakeAdbClient(async (_serial, cmd) => {
      sentToDevice = cmd
      return shellResult('ok', 0)
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'login --password hunter2' } }),
    )

    const execEvent = events.find((e) => e.kind === 'shell.exec')
    expect(execEvent).toBeDefined()
    expect(JSON.stringify(execEvent?.meta)).not.toContain('hunter2')
    // The real command sent to the device is UNCHANGED — redaction is a
    // logging measure only (plan 26 §3.3, §3.4), never a rewrite of behaviour.
    expect(sentToDevice).toContain('hunter2')
  })

  test('cd to an existing path updates the cwd; the next command runs there', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async (_serial, cmd) => {
      if (cmd.includes('&& pwd')) return shellResult('/data/local/tmp', 0)
      return shellResult('ok', 0)
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'cd /data/local/tmp' } }),
    )
    const cdResult = a.sent.find((m) => m.type === 'shell.result')
    if (cdResult?.type === 'shell.result') {
      expect(cdResult.payload.exitCode).toBe(0)
      expect(cdResult.payload.cwd).toBe('/data/local/tmp')
    } else throw new Error('no shell.result for cd')

    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x2', payload: { deviceId: 'dev-1', cmd: 'pwd' } }))
    const echo = a.sent.find((m) => m.type === 'shell.echo')
    if (echo?.type === 'shell.echo') expect(echo.payload.cwd).toBe('/data/local/tmp')
    else throw new Error('no shell.echo for pwd')
  })

  test('a failed cd leaves the cwd unchanged (acceptance #9)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async (_serial, cmd) => {
      if (cmd.includes('&& pwd')) throw new AdbError('E_ADB_FAIL', 'No such file or directory')
      return shellResult('ok', 0)
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'cd /nope' } }),
    )
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x2', payload: { deviceId: 'dev-1', cmd: 'pwd' } }))
    const echo = a.sent.find((m) => m.type === 'shell.echo')
    if (echo?.type === 'shell.echo') expect(echo.payload.cwd).toBe('/') // unchanged: the default, since the cd never succeeded
    else throw new Error('no shell.echo for pwd')
  })

  test('releasing the lease resets the cwd — the next holder starts at / (acceptance #11)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async (_serial, cmd) => {
      if (cmd.includes('&& pwd')) return shellResult('/data/local/tmp', 0)
      return shellResult('ok', 0)
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    await handler.handleMessage(
      a.ws,
      JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'cd /data/local/tmp' } }),
    )
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'lease.release', payload: { deviceId: 'dev-1' } }))

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x2', payload: { deviceId: 'dev-1', cmd: 'pwd' } }))
    const echo = a.sent.find((m) => m.type === 'shell.echo')
    if (echo?.type === 'shell.echo') expect(echo.payload.cwd).toBe('/')
    else throw new Error('no shell.echo for pwd')
  })

  test('a deadline (E_ADB_TIMEOUT) reports the coded error and the stream_suggested hint', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => {
      throw new AdbError('E_ADB_TIMEOUT', 'adb shell:logcat exceeded 15000ms')
    })
    const { handler, events } = setUpHandler(db, client)
    const a = fakeConn()

    await acquireLease(handler, a.ws, 'dev-1')
    a.sent.length = 0
    events.length = 0
    await handler.handleMessage(a.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'logcat' } }))

    const result = a.sent.find((m) => m.type === 'shell.result')
    expect(result).toBeDefined()
    if (result?.type === 'shell.result') {
      expect(result.payload.exitCode).toBeNull()
      expect(result.payload.hint).toBe('stream_suggested')
    }
    // Still exactly two event rows — a deadline is an OUTCOME, not a refusal.
    expect(events.map((e) => e.kind)).toEqual(['shell.exec', 'shell.result'])
  })

  test('every viewer of the device (not just the sender) receives shell.echo and shell.result', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client)
    const holder = fakeConn()
    const viewer = fakeConn()

    // Both "watch" the device the same way presence does: an open video stream.
    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'stream.start', id: 's1', payload: { deviceId: 'dev-1' } }))
    await handler.handleMessage(viewer.ws, JSON.stringify({ type: 'stream.start', id: 's2', payload: { deviceId: 'dev-1' } }))
    await acquireLease(handler, holder.ws, 'dev-1')
    viewer.sent.length = 0

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    expect(viewer.sent.some((m) => m.type === 'shell.echo')).toBe(true)
    expect(viewer.sent.some((m) => m.type === 'shell.result')).toBe(true)
  })

  test('a viewer on the Terminal tab alone (no video open) still sees the transcript, via log.subscribe presence (acceptance #10)', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler } = setUpHandler(db, client)
    const holder = fakeConn()
    const viewer = fakeConn()

    // Studio's TerminalPane registers presence by subscribing to the
    // device's `input` event stream (plan 26 §3.8) — no video stream
    // required, unlike the Control tab.
    await handler.handleMessage(viewer.ws, JSON.stringify({ type: 'log.subscribe', payload: { deviceId: 'dev-1', streams: ['input'] } }))
    await acquireLease(handler, holder.ws, 'dev-1')
    viewer.sent.length = 0

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    expect(viewer.sent.some((m) => m.type === 'shell.echo')).toBe(true)
    expect(viewer.sent.some((m) => m.type === 'shell.result')).toBe(true)
  })

  test('a bystander watching a DIFFERENT device sees nothing', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    seedDevice(db, 'dev-2', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler } = setUpHandler(db, client)
    const holder = fakeConn()
    const bystander = fakeConn()

    await handler.handleMessage(bystander.ws, JSON.stringify({ type: 'log.subscribe', payload: { deviceId: 'dev-2', streams: ['input'] } }))
    await acquireLease(handler, holder.ws, 'dev-1')
    bystander.sent.length = 0

    await handler.handleMessage(holder.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    expect(bystander.sent.some((m) => m.type === 'shell.echo' || m.type === 'shell.result')).toBe(false)
  })

  test('a non-holder cannot type: sending shell.exec without the lease is refused even while another viewer watches', async () => {
    const db = setUpDb()
    seedDevice(db, 'dev-1', 'idle')
    const client = fakeAdbClient(async () => shellResult('hi', 0))
    const { handler, events } = setUpHandler(db, client)
    const holder = fakeConn()
    const viewer = fakeConn()

    await acquireLease(handler, holder.ws, 'dev-1')
    events.length = 0
    await handler.handleMessage(viewer.ws, JSON.stringify({ type: 'shell.exec', id: 'x1', payload: { deviceId: 'dev-1', cmd: 'echo hi' } }))

    const err = viewer.sent.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(events).toHaveLength(0)
  })
})
