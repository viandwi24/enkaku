import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { GuestAgentClient, GuestAgentLauncher } from '@enkaku/drivers'
import type { PreparationComponentStatus, RouteStatusResult, ShellResult } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { createDeviceStateMachine } from '../device/state-machine'
import { createLeaseManager, type LeaseManager } from '../lease/lease-manager'
import type { Logger } from '../util/logger'
import { createReverseRegistry, type ReverseRegistry } from './reverse-registry'
import { createRouteService, type DeviceSession, type RouteService, type RouteServiceDeps } from './route-service'

/**
 * The shared harness for plan 114's core tests — `route-service.test.ts`,
 * `../api/devices.network-apply.test.ts` and the capability tests all drive the
 * SAME construction, because the thing under test is "one door" and three test
 * files each building their own slightly different door would be exactly the
 * drift plan 114 §3.3 exists to prevent.
 *
 * Everything below the door is a fake and nothing here touches a real device:
 *
 * - `exec` is a fake phone whose four `Settings.Global` keys live in a Map, so
 *   the REAL `@enkaku/drivers` engines run against it (capture, write, read
 *   back, restore) rather than being mocked out — an engine mocked at this
 *   seam would make every capture-once and restore assertion vacuous.
 * - the reverse registry is the REAL one over a fake `hostAdb` recording argv.
 * - the lease manager and the device state machine are REAL, over an in-memory
 *   database, because "held by somebody else" is precisely what the bulk path's
 *   classification turns on.
 * - only the guest agent's session/launcher/client are stubs, which is the same
 *   boundary `api/guest-agent.test.ts` already fakes.
 */

/** The four keys the advisory engines touch, as one fake phone. */
export interface FakePhone {
  serial: string
  settings: Map<string, string>
  /** Every shell command this phone was asked to run, in order. */
  execs: string[]
  /** Makes every `exec` throw — an unreachable phone. */
  offline: boolean
  /** Accepts writes but never stores them: the device DECLINED (`E_SETTING_NOT_ACCEPTED`). */
  ignoreWrites: boolean
}

function makePhone(serial: string): FakePhone {
  return { serial, settings: new Map(), execs: [], offline: false, ignoreWrites: false }
}

/** `shellQuote`'s inverse — the fake phone is the other end of `settings put global <key> '<value>'`. */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("'")) return trimmed
  return trimmed.slice(1, -1).replaceAll("'\\''", "'")
}

function execAgainst(phones: Map<string, FakePhone>): (serial: string, cmd: string) => Promise<ShellResult> {
  return async (serial, cmd) => {
    const phone = phones.get(serial)
    if (!phone) throw new Error(`no fake phone for serial ${serial}`)
    phone.execs.push(cmd)
    if (phone.offline) throw new Error(`device ${serial} is not reachable`)
    const m = /^settings (get|put|delete) global (\S+)\s*(.*)$/.exec(cmd)
    if (!m) return { stdout: '', stderr: '', exitCode: 0 }
    const [, verb, key, rest] = m
    if (verb === 'get') return { stdout: `${phone.settings.get(key!) ?? 'null'}\n`, stderr: '', exitCode: 0 }
    if (verb === 'delete') {
      if (!phone.ignoreWrites) phone.settings.delete(key!)
      return { stdout: 'Deleted 1 rows\n', stderr: '', exitCode: 0 }
    }
    if (!phone.ignoreWrites) phone.settings.set(key!, unquote(rest ?? ''))
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

export interface RecordedEvent {
  deviceId: string
  stream: string
  kind: string
  actor?: string | null
  meta?: Record<string, unknown>
}

export interface RouteHarness {
  db: Db
  service: RouteService
  /** `service.routes` behind a middleware that sets `c.get('user')`, like the real auth middleware does. */
  app: Hono<AuthEnv>
  leases: LeaseManager
  /** Every manual acquire/release the SERVICE itself made — the bulk path's transient hold (plan 114 §3.9). */
  leaseCalls: Array<{ op: 'acquire' | 'release'; deviceId: string; clientId: string }>
  events: RecordedEvent[]
  warns: string[]
  phones: Map<string, FakePhone>
  /** Every `hostAdb.run` argv the reverse registry issued. */
  adbCalls: string[][]
  /** Flips the fake adb server into refusing every `adb reverse`. */
  failReverse: (predicate: (args: string[]) => boolean) => void
  reverse: ReverseRegistry | undefined
  seed: (deviceId: string, overrides?: Partial<DeviceRow>) => DeviceRow
  phone: (deviceId: string) => FakePhone
  route: (deviceId: string) => unknown
}

export interface RouteHarnessOptions {
  /** Omit the reverse registry entirely — the `E_NOT_SUPPORTED` case (plan 114 §4.2). */
  withoutReverse?: boolean
  user?: { id: string; email: string; role: 'admin' | 'operator' } | null
  /** Fails the VPN engine's `route.start`, for the `assertLockFree` refusal paths. */
  vpnClient?: Partial<GuestAgentClient>
  /**
   * Makes a `vpn-helper` session's `close()` throw — the one seam that makes
   * `NetworkRoute.revert()` itself fail, which is what `assertLockFree`'s
   * `E_ROUTE_LOCK_HELD` refusal exists for (a port that could not be released,
   * a launcher that could not remove its forward).
   */
  sessionCloseError?: string
}

const serialFor = (deviceId: string): string => `SER-${deviceId}`

export function makeRouteHarness(opts: RouteHarnessOptions = {}): RouteHarness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const warns: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warns.push(msg)
    },
    error: (msg) => {
      warns.push(msg)
    },
    child: () => log,
  }
  const states = createDeviceStateMachine({ db, log, onChange: () => {} })
  const leaseCalls: RouteHarness['leaseCalls'] = []
  const realLeases = createLeaseManager({
    states,
    jobStore: { expiredRunning: () => [] } as never,
    config: { jobTtlSec: 60, manualIdleTimeoutSec: 600, reaperIntervalMs: 1_000_000 },
    log,
    onJobLeaseExpired: () => {},
  })
  /** Records what the service does with leases without changing what it gets back. */
  const leases: LeaseManager = {
    ...realLeases,
    acquireManual: (deviceId, clientId, userId, o) => {
      leaseCalls.push({ op: 'acquire', deviceId, clientId })
      return realLeases.acquireManual(deviceId, clientId, userId, o)
    },
    releaseManual: (deviceId, clientId, reason) => {
      leaseCalls.push({ op: 'release', deviceId, clientId })
      return realLeases.releaseManual(deviceId, clientId, reason)
    },
  }

  const phones = new Map<string, FakePhone>()
  const events: RecordedEvent[] = []
  const adbCalls: string[][] = []
  let reverseFails: (args: string[]) => boolean = () => false
  /** What the fake guest agent answers `route.status` with — up, on the upstream the VPN tests declare. */
  const agentStatus: RouteStatusResult = { prepared: true, up: true, upstream: 'proxy.example:1080' }

  const reverse = opts.withoutReverse
    ? undefined
    : createReverseRegistry({
        hostAdb: async (args) => {
          adbCalls.push([...args])
          if (reverseFails(args)) throw new Error(`adb ${args.join(' ')} failed`)
          return args.includes('--list') ? adbListing() : ''
        },
        serialOf: (deviceId) => (phones.has(serialFor(deviceId)) ? serialFor(deviceId) : null),
        range: { rangeStart: 28100, rangeEnd: 28299 },
      })

  /** The fake adb server's own view of what is bound — driven by the calls it accepted. */
  const bound = new Map<string, { devicePort: number; hostPort: number }>()
  function adbListing(): string {
    return [...bound.values()].map((b) => `UsbFfs tcp:${b.devicePort} tcp:${b.hostPort}`).join('\n')
  }

  const launcher: GuestAgentLauncher = {
    isInstalled: async () => true,
    ensureInstalled: async () => ({ versionCode: null }),
    ensurePreGranted: async () => ({ state: 'granted', reason: null }),
    vpnConsent: async () => ({ state: 'granted', reason: null }),
    bootstrap: async () => {},
    forward: async () => {},
    removeForward: async () => {},
    stop: async () => {},
  }

  const client = {
    hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 35, capabilities: ['socks5-route', 'vpn-status'] }),
    ping: async () => ({ pong: true }),
    routeStart: async () => ({ started: true }),
    routeStop: async () => ({ stopped: true }),
    routeStatus: async () => agentStatus,
    ...opts.vpnClient,
  } as unknown as GuestAgentClient

  /** The guest agent is on the phone: an unreachable phone cannot be handshaked with, whatever the fake client would have answered. */
  function assertReachable(serial: string): void {
    if (phones.get(serial)?.offline) throw new Error(`device ${serial} is not reachable`)
  }

  function makeSession(row: DeviceRow): DeviceSession {
    let active = false
    return {
      async withClient(fn) {
        assertReachable(row.serial)
        active = true
        return fn(client)
      },
      get active() {
        return active
      },
      async close() {
        active = false
        if (opts.sessionCloseError) throw new Error(opts.sessionCloseError)
      },
    }
  }

  const deps: RouteServiceDeps = {
    db,
    exec: execAgainst(phones),
    apkPath: async () => '/fake/guest-agent.apk',
    leases,
    dataDir: mkdtempSync(join(tmpdir(), 'enkaku-route-service-test-')),
    log,
    record: (e) => events.push(e as RecordedEvent),
    makeLauncher: () => launcher,
    makeSession: (row) => makeSession(row),
    withEphemeralSession: async (row, fn) => {
      assertReachable(row.serial)
      return fn(client)
    },
    routeTimings: { applySettleTimeoutMs: 0, applySettleIntervalMs: 0, revertPollTimeoutMs: 0 },
    ...(reverse ? { reverse } : {}),
  }

  const service = createRouteService(deps)

  // The registry's own bookkeeping is in-memory; this mirrors it into the fake
  // adb server's listing so `verify()` answers what a real `adb reverse --list`
  // would after the calls it just accepted.
  const originalEstablish = reverse?.establish.bind(reverse)
  if (reverse && originalEstablish) {
    reverse.establish = async (deviceId, o) => {
      const entry = await originalEstablish(deviceId, o)
      bound.set(deviceId, { devicePort: entry.devicePort, hostPort: entry.hostPort })
      return entry
    }
    const originalRelease = reverse.release.bind(reverse)
    reverse.release = async (deviceId) => {
      bound.delete(deviceId)
      await originalRelease(deviceId)
    }
  }

  const user = opts.user === undefined ? { id: 'u1', email: 'u@test', role: 'admin' as const } : opts.user
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    if (user) c.set('user', user)
    await next()
  })
  app.route('/', service.routes)

  return {
    db,
    service,
    app,
    leases,
    leaseCalls,
    events,
    warns,
    phones,
    adbCalls,
    failReverse: (predicate) => {
      reverseFails = predicate
    },
    reverse,
    seed: (deviceId, overrides = {}) => {
      const serial = serialFor(deviceId)
      phones.set(serial, makePhone(serial))
      db.insert(devices)
        .values({ id: deviceId, stableId: `stable-${deviceId}`, serial, label: `Phone ${deviceId}`, status: 'idle', apiLevel: 35, ...overrides })
        .run()
      return db.select().from(devices).all().find((r) => r.id === deviceId)!
    },
    phone: (deviceId) => phones.get(serialFor(deviceId))!,
    route: (deviceId) => db.select().from(devices).all().find((r) => r.id === deviceId)?.networkRoute ?? null,
  }
}

/** A guest agent preparation record for `devices.preparation['guest-agent']` — what `vpnPrecondition` reads (plan 106 step 106.5). */
export function preparation(state: PreparationComponentStatus['state'], reason: string | null = null): Record<string, PreparationComponentStatus> {
  return { 'guest-agent': { state, version: null, reason, checkedAt: null, attempts: 0, nextAttemptAt: null } }
}

/**
 * Captures every `setInterval` started while `fn` runs, so a test can assert
 * that the network heartbeat did not start at all — and can drive the tick it
 * would have run without waiting out a real 20 s.
 */
export async function withCapturedIntervals<T>(fn: (started: Array<{ handler: () => void; ms: number }>) => Promise<T>): Promise<T> {
  const started: Array<{ handler: () => void; ms: number }> = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    started.push({ handler, ms: ms ?? 0 })
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  try {
    return await fn(started)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

/** Freezes `Date.now()` for the duration of `fn` — `nowSeconds()` floors to the second, and the advisory read throttle is measured in them. */
export async function withFakeClock<T>(startMs: number, fn: (advance: (deltaMs: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now
  let current = startMs
  Date.now = () => current
  try {
    return await fn((deltaMs) => {
      current += deltaMs
    })
  } finally {
    Date.now = realNow
  }
}

/** Opens a real loopback listener so the advisory `upstream` check can genuinely pass; returns the port and a stop function. */
export function listenOnLoopback(): { port: number; stop: () => void } {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: () => {},
      open: (s) => {
        s.end()
      },
      error: () => {},
      close: () => {},
    },
  })
  return { port: server.port, stop: () => server.stop(true) }
}
