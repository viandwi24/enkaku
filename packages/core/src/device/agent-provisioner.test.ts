import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { GuestAgentClientError, type GuestAgentArtifactMismatch, type GuestAgentLauncher, type GuestAgentVpnConsent } from '@enkaku/drivers'
import type { GuestAgentCapability, HelloResult } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createAgentProvisioner, createAgentProvisionerRoutes, MIN_SUPPORTED_SDK, type AgentProvisionerDeps } from './agent-provisioner'

/** Mirrors `authMiddleware` well enough for a route test — same pattern `api/guest-agent.test.ts` uses. */
function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function makeDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, overrides: Partial<DeviceRow> = {}): void {
  db.insert(devices)
    .values({
      id: 'dev-1',
      stableId: 'stable-dev-1',
      serial: 'serial-dev-1',
      label: 'Test Phone',
      status: 'idle',
      apiLevel: 34,
      ...overrides,
    })
    .run()
}

function readRow(db: Db, id = 'dev-1'): DeviceRow {
  const row = db.select().from(devices).where(eq(devices.id, id)).get()
  if (!row) throw new Error(`no such device: ${id}`)
  return row
}

const HELLO_OK: HelloResult = {
  protocol: 1,
  appVersion: '1.0.0',
  androidSdkInt: 34,
  capabilities: ['socks5-route', 'egress-probe'] as GuestAgentCapability[],
}

interface LauncherBehavior {
  /** One call per `ensureInstalled()` invocation (including R1's forced retry). Throwing after calling `fireMismatch` simulates F8's "still mismatched after one repair attempt" path; throwing WITHOUT calling it simulates any other install failure (e.g. a missing/corrupt APK). */
  ensureInstalled: (
    opts: { force?: boolean } | undefined,
    fireMismatch: (info: GuestAgentArtifactMismatch) => void,
  ) => Promise<{ versionCode: number | null }>
  /** Defaults to `granted` — only the `consent-required` tests override it. */
  vpnConsent?: () => GuestAgentVpnConsent
}

function fakeMakeLauncher(behavior: LauncherBehavior): NonNullable<AgentProvisionerDeps['makeLauncher']> {
  return (_row, opts): GuestAgentLauncher => ({
    isInstalled: async () => true,
    ensureInstalled: (o) => behavior.ensureInstalled(o, opts.onMismatch),
    ensurePreGranted: async () => ({ state: 'granted', reason: null }),
    vpnConsent: async () => behavior.vpnConsent?.() ?? { state: 'granted', reason: null },
    ensureAccessibilityEnabled: async () => ({ state: 'enabled', reason: null }),
    bootstrap: async () => undefined,
    forward: async () => undefined,
    removeForward: async () => undefined,
    stop: async () => undefined,
  })
}

/** Everything a test needs to override — the happy path installs cleanly and `hello()` answers `HELLO_OK`. */
function fakeDeps(overrides: Partial<AgentProvisionerDeps> = {}): {
  deps: AgentProvisionerDeps
  db: Db
  hostAdbCalls: Array<{ args: string[]; opts?: { lane?: 'default' | 'install'; serial?: string } }>
  execCalls: string[]
  events: Array<{ deviceId: string; kind: string; meta: Record<string, unknown> | undefined | null }>
  logs: Array<{ level: string; msg: string }>
} {
  const db = makeDb()
  const hostAdbCalls: Array<{ args: string[]; opts?: { lane?: 'default' | 'install'; serial?: string } }> = []
  const execCalls: string[] = []
  const events: Array<{ deviceId: string; kind: string; meta: Record<string, unknown> | undefined | null }> = []
  const logs: Array<{ level: string; msg: string }> = []

  const deps: AgentProvisionerDeps = {
    db,
    exec: async (_serial, cmd) => {
      execCalls.push(cmd)
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    hostAdb: async (args, opts) => {
      hostAdbCalls.push({ args, opts })
      return ''
    },
    // Plan 119 §4.1, §4.2 — every test in this file drives the launcher via `makeLauncher`'s
    // seam (`fakeMakeLauncher` above), never the real `createGuestAgentLauncher`, so this stub is
    // never actually called; it exists only to satisfy `AgentProvisionerDeps['adb']`.
    adb: {
      forward: async () => undefined,
      listForward: async () => [],
      killForward: async () => undefined,
    },
    apkPath: async () => '/tools/guest-agent.apk',
    expectedArtifact: async () => ({ versionCode: 5 }),
    hello: async () => HELLO_OK,
    provision: () => 'auto',
    record: (e) => events.push({ deviceId: e.deviceId, kind: e.kind, meta: e.meta }),
    log: {
      debug: (msg) => logs.push({ level: 'debug', msg }),
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
      child: () => deps.log,
    },
    makeLauncher: fakeMakeLauncher({ ensureInstalled: async () => ({ versionCode: 5 }) }),
    retryBackoffS: [5, 20, 60],
    now: () => 1_000_000_000_000,
    ...overrides,
  }
  return { deps, db, hostAdbCalls, execCalls, events, logs }
}

describe('createAgentProvisioner (plan 90 §3.8, §4.3, fixes F7, F9, F10)', () => {
  describe('ensure()', () => {
    test('absent → installs, confirms via hello(), reaches ready with a version and capability list (acceptance criterion 4)', async () => {
      const { deps, db, events } = fakeDeps({
        makeLauncher: fakeMakeLauncher({ ensureInstalled: async () => ({ versionCode: 5 }) }),
      })
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)
      const status = await provisioner.ensure('dev-1')

      expect(status.state).toBe('ready')
      expect(status.appVersion).toBe('1.0.0')
      expect(status.androidSdkInt).toBe(34)
      expect(status.capabilities).toEqual(['socks5-route', 'egress-probe'])
      expect(status.attempts).toBe(0)
      expect(status.nextAttemptAt).toBeNull()

      // Persisted, not just returned — split across two columns since plan
      // 106 §5 step 106.5: `devices.preparation['guest-agent']` carries the
      // state-machine facts (authoritative), `devices.agent` carries only
      // the identity facts learned from `hello()` (no `state` field at all).
      const row = readRow(db)
      expect(row.preparation).toMatchObject({ 'guest-agent': { state: 'ready' } })
      expect(row.agent).toMatchObject({ appVersion: '1.0.0' })
      expect(row.agent).not.toHaveProperty('state')

      // Exactly one transition event, absent → ready.
      const agentEvents = events.filter((e) => e.kind === 'device.agent')
      expect(agentEvents).toHaveLength(1)
      expect(agentEvents[0]?.meta).toMatchObject({ state: 'ready', from: 'absent' })
    })

    test('installed, answering, but VPN consent ungranted → `consent-required`, NOT ready and NOT failed', async () => {
      const consentReason =
        'the guest agent is installed and answering, but Android VPN consent (ACTIVATE_VPN) is not granted on this phone ' +
        'and this build will not let adb grant it: `appops set ...` was refused by the platform ' +
        '(java.lang.SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES.)'
      const { deps, db, events } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => ({ versionCode: 5 }),
          vpnConsent: () => ({ state: 'pending', reason: consentReason }),
        }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')

      expect(status.state).toBe('consent-required')
      // The identity facts from `hello()` survive — this device's agent WORKS,
      // and reporting it with no version or capabilities would read as broken.
      expect(status.appVersion).toBe('1.0.0')
      expect(status.capabilities).toEqual(['socks5-route', 'egress-probe'])
      expect(status.reason).toBe(consentReason)
      // Not a bounded-retry failure: retrying cannot clear it, only a human can.
      expect(status.attempts).toBe(0)
      expect(status.nextAttemptAt).toBeNull()

      expect(readRow(db).preparation).toMatchObject({ 'guest-agent': { state: 'consent-required' } })
      expect(events.filter((e) => e.kind === 'device.agent')[0]?.meta).toMatchObject({ state: 'consent-required', from: 'absent' })
    })

    test('a consent readback that cannot be read leaves the device ready — an unreadable answer is not a verdict', async () => {
      const { deps, db } = fakeDeps({
        makeLauncher: (_row, opts) => ({
          isInstalled: async () => true,
          ensureInstalled: async () => ({ versionCode: 5 }),
          ensurePreGranted: async () => ({ state: 'granted' as const, reason: null }),
          vpnConsent: async () => {
            throw new Error('device went away mid-read')
          },
          ensureAccessibilityEnabled: async () => ({ state: 'enabled' as const, reason: null }),
          bootstrap: async () => undefined,
          forward: async () => undefined,
          removeForward: async () => undefined,
          stop: async () => undefined,
          ...opts,
        }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('ready')
    })

    test('a clean reconnect (already ready, nothing changed) runs one verification pass and emits no event (acceptance criterion 5)', async () => {
      const { deps, db, events } = fakeDeps()
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)
      await provisioner.ensure('dev-1')
      events.length = 0

      const second = await provisioner.ensure('dev-1')
      expect(second.state).toBe('ready')
      expect(events.filter((e) => e.kind === 'device.agent')).toHaveLength(0)
    })

    test('a version mismatch is repaired once and reaches ready', async () => {
      let calls = 0
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            calls++
            return { versionCode: 5 }
          },
        }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('ready')
      expect(calls).toBe(1) // the launcher itself owns the repair-once cycle; the provisioner calls it once
    })

    test('still mismatched after one repair attempt reports outdated with the observed version, and stops — no loop (acceptance criterion 6)', async () => {
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async (_opts, fireMismatch) => {
            fireMismatch({ reason: 'version_mismatch', observed: { versionCode: 3 } })
            throw new Error('guest agent artifact verification failed after one repair attempt: version_mismatch')
          },
        }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('outdated')
      expect(status.versionCode).toBe(3)
      expect(status.reason).toContain('version_mismatch')
      // 'outdated' is not the bounded-retry ladder's concern — it stays visible, not accumulating attempts.
      expect(status.attempts).toBe(0)
    })

    test('unreadable is skipped, not treated as a failure — no install/uninstall, still reaches ready via hello()', async () => {
      const { deps, db, hostAdbCalls } = fakeDeps({
        makeLauncher: fakeMakeLauncher({ ensureInstalled: async () => ({ versionCode: null }) }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('ready')
      expect(hostAdbCalls.filter((c) => c.args.includes('install') || c.args.includes('uninstall'))).toHaveLength(0)
    })

    test('a device whose agent cannot be installed reports failed with the verbatim reason (acceptance criterion 7)', async () => {
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            throw new Error('E_CHECKSUM_MISSING: no sha256 recorded for guest-agent — refusing to install an unverified artifact')
          },
        }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('failed')
      expect(status.reason).toContain('E_CHECKSUM_MISSING')
    })

    test('a device whose agent cannot be installed still opens a session, streams video, and answers a shell — DeviceStatus is never touched (acceptance criterion 7)', async () => {
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            throw new Error('corrupt APK')
          },
        }),
      })
      seedDevice(db, { status: 'idle', quarantineReason: null })
      const before = readRow(db)
      await createAgentProvisioner(deps).ensure('dev-1')
      const after = readRow(db)
      expect(after.status).toBe(before.status)
      expect(after.status).toBe('idle')
      expect(after.quarantineReason).toBeNull()
    })

    test('a device whose agent install failed while the device was quarantined for an unrelated reason leaves the quarantine untouched too', async () => {
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            throw new Error('corrupt APK')
          },
        }),
      })
      seedDevice(db, { status: 'quarantined', quarantineReason: 'thermal:49.8C' })
      await createAgentProvisioner(deps).ensure('dev-1')
      const after = readRow(db)
      expect(after.status).toBe('quarantined')
      expect(after.quarantineReason).toBe('thermal:49.8C')
    })

    test('retries are bounded: three failed attempts, then automatic calls stop until an explicit retry', async () => {
      let calls = 0
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            calls++
            throw new Error('device offline mid-install')
          },
        }),
        // Zeroed so the cooldown between attempts never blocks this test.
        retryBackoffS: [0, 0, 0],
      })
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)

      const s1 = await provisioner.ensure('dev-1')
      expect(s1.attempts).toBe(1)
      const s2 = await provisioner.ensure('dev-1')
      expect(s2.attempts).toBe(2)
      const s3 = await provisioner.ensure('dev-1')
      expect(s3.attempts).toBe(3)
      expect(calls).toBe(3)

      // Exhausted — a fourth AUTOMATIC call does no work at all.
      const s4 = await provisioner.ensure('dev-1')
      expect(s4.attempts).toBe(3)
      expect(calls).toBe(3)

      // An explicit (forced) retry bypasses the bound.
      const s5 = await provisioner.ensure('dev-1', { force: true })
      expect(calls).toBe(4)
      expect(s5.attempts).toBe(1) // still failing, but the bound restarted from a clean slate
    })

    test('a cooldown between automatic attempts prevents an install storm from closely-spaced hook firings', async () => {
      let calls = 0
      let clock = 1_000_000
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            calls++
            throw new Error('device offline mid-install')
          },
        }),
        retryBackoffS: [5, 20, 60],
        now: () => clock * 1000,
      })
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)

      await provisioner.ensure('dev-1') // attempt 1, calls=1
      await provisioner.ensure('dev-1') // still inside the 5s cooldown — no-op
      expect(calls).toBe(1)

      clock += 10 // past the 5s cooldown
      await provisioner.ensure('dev-1') // attempt 2
      expect(calls).toBe(2)
    })

    test("guestAgent.provision: 'off' is a no-op for automatic calls — no adb work at all (acceptance criterion 8)", async () => {
      const { deps, db, hostAdbCalls, execCalls } = fakeDeps({ provision: () => 'off' })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('absent')
      expect(hostAdbCalls).toHaveLength(0)
      expect(execCalls).toHaveLength(0)
    })

    test("guestAgent.provision: 'off' does not block an explicit (forced) request", async () => {
      const { deps, db } = fakeDeps({ provision: () => 'off' })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1', { force: true })
      expect(status.state).toBe('ready')
    })

    test("guestAgent.provision: 'manual' behaves the same as 'off' for automatic calls", async () => {
      const { deps, db, hostAdbCalls } = fakeDeps({ provision: () => 'manual' })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('absent')
      expect(hostAdbCalls).toHaveLength(0)
    })

    test('a device below the API floor reports unsupported, terminally, with no adb call', async () => {
      const { deps, db, hostAdbCalls, execCalls } = fakeDeps()
      seedDevice(db, { apiLevel: MIN_SUPPORTED_SDK - 1 })
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('unsupported')
      expect(status.reason).toContain(String(MIN_SUPPORTED_SDK))
      expect(hostAdbCalls).toHaveLength(0)
      expect(execCalls).toHaveLength(0)
    })

    test('R1 (plan 90 §3.9 rule 1): a repairable hello() error forces exactly one reinstall, then re-hello, and reaches ready', async () => {
      let ensureInstalledCalls = 0
      let helloCalls = 0
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            ensureInstalledCalls++
            return { versionCode: 5 }
          },
        }),
        hello: async () => {
          helloCalls++
          if (helloCalls === 1) throw new GuestAgentClientError('E_PROTOCOL_MISMATCH', 'guest agent speaks protocol 0, this host expects 1')
          return HELLO_OK
        },
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('ready')
      expect(ensureInstalledCalls).toBe(2) // the ordinary pass, then R1's one forced repair
      expect(helloCalls).toBe(2)
    })

    test('R1 still degrades to failed when the forced repair does not fix the handshake', async () => {
      const { deps, db } = fakeDeps({
        hello: async () => {
          throw new GuestAgentClientError('E_PROTOCOL_MISMATCH', 'still stale')
        },
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('failed')
      expect(status.reason).toContain('still stale')
    })

    test('a non-repairable hello() failure (e.g. unreachable) is failed, never retried as R1', async () => {
      let ensureInstalledCalls = 0
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            ensureInstalledCalls++
            return { versionCode: 5 }
          },
        }),
        hello: async () => {
          throw new GuestAgentClientError('E_TIMEOUT', 'guest agent did not respond within 15000ms')
        },
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('failed')
      expect(ensureInstalledCalls).toBe(1) // never forced a second repair for a non-repairable code
    })

    test('throws device_not_found for an unknown device id', async () => {
      const { deps } = fakeDeps()
      await expect(createAgentProvisioner(deps).ensure('does-not-exist')).rejects.toThrow(/no such device/)
    })

    test('concurrent ensure() calls for the same device in flight are coalesced onto one pass', async () => {
      let calls = 0
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            calls++
            await new Promise((r) => setTimeout(r, 10))
            return { versionCode: 5 }
          },
        }),
      })
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)
      const [a, b] = await Promise.all([provisioner.ensure('dev-1'), provisioner.ensure('dev-1')])
      expect(a).toEqual(b)
      expect(calls).toBe(1)
    })
  })

  describe('status()', () => {
    test('reads the persisted row without issuing any adb call', async () => {
      const { deps, db, hostAdbCalls, execCalls } = fakeDeps()
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)
      await provisioner.ensure('dev-1')
      hostAdbCalls.length = 0
      execCalls.length = 0

      const status = await provisioner.status('dev-1')
      expect(status.state).toBe('ready')
      expect(hostAdbCalls).toHaveLength(0)
      expect(execCalls).toHaveLength(0)
    })

    test('a never-provisioned device reads absent', async () => {
      const { deps, db } = fakeDeps()
      seedDevice(db)
      const status = await createAgentProvisioner(deps).status('dev-1')
      expect(status.state).toBe('absent')
    })

    test('a corrupt stored value reads as the safe default rather than throwing', async () => {
      const { deps, db } = fakeDeps()
      seedDevice(db, { agent: { garbage: true } as unknown as DeviceRow['agent'] })
      const status = await createAgentProvisioner(deps).status('dev-1')
      expect(status.state).toBe('absent')
    })
  })

  describe('ensureAll()', () => {
    test('provisions every online device and reports the outcome (acceptance criterion 9 — bounded by the shared install lane, not a second mechanism)', async () => {
      const { deps, db } = fakeDeps()
      seedDevice(db, { id: 'dev-1', stableId: 'stable-1', serial: 'serial-1' })
      seedDevice(db, { id: 'dev-2', stableId: 'stable-2', serial: 'serial-2' })
      const report = await createAgentProvisioner(deps).ensureAll()
      expect(report.total).toBe(2)
      expect(report.results.every((r) => r.state === 'ready')).toBe(true)
    })

    test('skips offline devices — nothing to verify, unreachable by construction', async () => {
      const { deps, db, hostAdbCalls, execCalls } = fakeDeps()
      seedDevice(db, { id: 'dev-1', status: 'offline' })
      const report = await createAgentProvisioner(deps).ensureAll()
      expect(report.total).toBe(0)
      expect(hostAdbCalls).toHaveLength(0)
      expect(execCalls).toHaveLength(0)
    })

    test("respects guestAgent.provision: 'off' for every device — a no-op sweep", async () => {
      const { deps, db, hostAdbCalls } = fakeDeps({ provision: () => 'off' })
      seedDevice(db, { id: 'dev-1' })
      seedDevice(db, { id: 'dev-2', stableId: 'stable-2', serial: 'serial-2' })
      const report = await createAgentProvisioner(deps).ensureAll()
      expect(report.results.every((r) => r.state === 'absent')).toBe(true)
      expect(hostAdbCalls).toHaveLength(0)
    })

    test('one device throwing an unexpected error never aborts the rest of the sweep', async () => {
      let calls = 0
      const { deps, db } = fakeDeps({
        makeLauncher: (row, opts) => {
          calls++
          if (row.id === 'dev-1') {
            return {
              isInstalled: async () => true,
              ensureInstalled: async () => {
                throw new Error('unexpected')
              },
              ensurePreGranted: async () => ({ state: 'granted' as const, reason: null }),
              vpnConsent: async () => ({ state: 'granted' as const, reason: null }),
              ensureAccessibilityEnabled: async () => ({ state: 'enabled' as const, reason: null }),
              bootstrap: async () => undefined,
              forward: async () => undefined,
              removeForward: async () => undefined,
              stop: async () => undefined,
            }
          }
          return fakeMakeLauncher({ ensureInstalled: async () => ({ versionCode: 5 }) })(row, opts)
        },
      })
      seedDevice(db, { id: 'dev-1' })
      seedDevice(db, { id: 'dev-2', stableId: 'stable-2', serial: 'serial-2' })
      const report = await createAgentProvisioner(deps).ensureAll()
      expect(report.total).toBe(2)
      expect(calls).toBe(2)
      const dev1 = report.results.find((r) => r.deviceId === 'dev-1')
      const dev2 = report.results.find((r) => r.deviceId === 'dev-2')
      expect(dev1?.state).toBe('failed')
      expect(dev2?.state).toBe('ready')
    })
  })

  describe('remove()', () => {
    test('uninstalls and clears the persisted row back to absent', async () => {
      const { deps, db, hostAdbCalls, events } = fakeDeps()
      seedDevice(db)
      const provisioner = createAgentProvisioner(deps)
      await provisioner.ensure('dev-1')
      events.length = 0

      const status = await provisioner.remove('dev-1', 'user-1')
      expect(status.state).toBe('absent')
      expect(hostAdbCalls.some((c) => c.args.includes('uninstall'))).toBe(true)
      const row = readRow(db)
      expect(row.preparation).toMatchObject({ 'guest-agent': { state: 'absent' } })
      expect(events.some((e) => e.kind === 'device.agent')).toBe(true)
    })
  })

  describe('plan 106 §5 step 106.5: devices.preparation is authoritative, devices.agent is derived', () => {
    test('an existing legacy devices.agent value (pre-106.5 shape, full AgentStatus with no preparation entry) survives with the same meaning', async () => {
      const { deps, db } = fakeDeps()
      seedDevice(db, {
        agent: {
          state: 'failed',
          appVersion: '2.3.0',
          versionCode: 9,
          androidSdkInt: 33,
          capabilities: ['socks5-route'],
          reason: 'device offline mid-install',
          checkedAt: 1_700_000_000,
          attempts: 3,
          nextAttemptAt: null,
        } as unknown as DeviceRow['agent'],
        // No `preparation` column populated — exactly the shape every row
        // written before this step has.
      })
      const status = await createAgentProvisioner(deps).status('dev-1')
      expect(status).toMatchObject({
        state: 'failed',
        appVersion: '2.3.0',
        versionCode: 9,
        androidSdkInt: 33,
        capabilities: ['socks5-route'],
        reason: 'device offline mid-install',
        checkedAt: 1_700_000_000,
        attempts: 3,
        nextAttemptAt: null,
      })
    })

    test('a real pass writes BOTH columns from the same computed value, in one update — they cannot disagree because there is exactly one writer', async () => {
      const { deps, db } = fakeDeps({
        makeLauncher: fakeMakeLauncher({
          ensureInstalled: async () => {
            throw new Error('device offline mid-install')
          },
        }),
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('failed')

      const row = readRow(db)
      const prep = row.preparation as Record<string, { state: string; reason: string | null; attempts: number }>
      expect(prep['guest-agent']?.state).toBe('failed')
      expect(prep['guest-agent']?.reason).toBe(status.reason)
      expect(prep['guest-agent']?.attempts).toBe(status.attempts)
      // The identity cache no longer carries a state-bearing fact at all —
      // nothing left for it to disagree with `devices.preparation` about.
      expect(row.agent).not.toHaveProperty('state')
      expect(row.agent).not.toHaveProperty('reason')
      expect(row.agent).not.toHaveProperty('attempts')
    })

    test('an unregistered, unrelated preparation component already recorded for this device survives a guest-agent write untouched', async () => {
      const { deps, db } = fakeDeps()
      seedDevice(db, { preparation: { 'ui-server': { state: 'ready', version: '7', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null } } as unknown as DeviceRow['preparation'] })
      await createAgentProvisioner(deps).ensure('dev-1')
      const row = readRow(db)
      const prep = row.preparation as Record<string, { state: string; version: string | null }>
      expect(prep['ui-server']).toMatchObject({ state: 'ready', version: '7' })
      expect(prep['guest-agent']?.state).toBe('ready')
    })
  })

  describe('the install lane (F12) — installs ride the real launcher end to end', () => {
    test('a fresh install carries { lane: "install", serial } through hostAdb, never a second concurrency mechanism', async () => {
      const { deps, db, hostAdbCalls } = fakeDeps({
        makeLauncher: undefined, // use the REAL createGuestAgentLauncher
        exec: async (_serial, cmd) => {
          if (cmd.startsWith('dumpsys package')) return { stdout: 'Unable to find package: dev.enkaku.guestagent\n', stderr: '', exitCode: 0 }
          // The provisioner reads VPN consent back after `hello()` succeeds;
          // a device that grants the app op normally answers `allow`.
          if (cmd.startsWith('appops get')) return { stdout: 'ACTIVATE_VPN: allow', stderr: '', exitCode: 0 }
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      })
      seedDevice(db)
      const status = await createAgentProvisioner(deps).ensure('dev-1')
      expect(status.state).toBe('ready')
      const installCall = hostAdbCalls.find((c) => c.args.includes('install'))
      expect(installCall?.opts).toEqual({ lane: 'install', serial: 'serial-dev-1' })
    })
  })
})

describe('createAgentProvisioner — runningSince (plan 106 §5 step 106.7)', () => {
  test('reports in flight while runOnePass is pending (including a R1 forced-repair recursion), and clears on settle', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, db } = fakeDeps({
      hello: async () => {
        await gate
        return HELLO_OK
      },
    })
    seedDevice(db)
    const provisioner = createAgentProvisioner(deps)

    expect(provisioner.runningSince('dev-1')).toBeNull()
    const pending = provisioner.ensure('dev-1')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(provisioner.runningSince('dev-1')).toBe(1_000_000_000)
    expect(provisioner.runningSince('dev-2')).toBeNull() // never leaks into another device's slot

    release!()
    const status = await pending
    expect(status.state).toBe('ready')
    expect(provisioner.runningSince('dev-1')).toBeNull()
  })

  test('clears on an E_ADB_UNAVAILABLE defer too — never left looking in flight forever', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, db } = fakeDeps({
      makeLauncher: fakeMakeLauncher({
        ensureInstalled: async () => {
          await gate
          throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
        },
      }),
    })
    seedDevice(db)
    const provisioner = createAgentProvisioner(deps)

    const pending = provisioner.ensure('dev-1')
    await Promise.resolve()
    await Promise.resolve()
    expect(provisioner.runningSince('dev-1')).toBe(1_000_000_000)

    release!()
    const status = await pending
    expect(status.state).toBe('absent') // deferred, untouched prior
    expect(provisioner.runningSince('dev-1')).toBeNull()
  })
})

describe('createAgentProvisionerRoutes (plan 90 §4.7)', () => {
  test('GET /summary aggregates byState and byVersion across every device', async () => {
    const { deps, db } = fakeDeps()
    seedDevice(db, { id: 'dev-1', stableId: 'stable-1', serial: 'serial-1' })
    seedDevice(db, { id: 'dev-2', stableId: 'stable-2', serial: 'serial-2' })
    const provisioner = createAgentProvisioner(deps)
    await provisioner.ensure('dev-1')
    // dev-2 stays absent (never provisioned).

    const { routes } = createAgentProvisionerRoutes({ provisioner, db })
    const res = await withUser('admin', routes).request('/summary')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; byState: Record<string, number>; byVersion: Record<string, number> }
    expect(body.total).toBe(2)
    expect(body.byState.ready).toBe(1)
    expect(body.byState.absent).toBe(1)
    expect(body.byVersion['1.0.0']).toBe(1)
  })

  test('POST /provision runs a forced fleet-wide pass and returns a per-device report', async () => {
    const { deps, db } = fakeDeps()
    seedDevice(db, { id: 'dev-1', stableId: 'stable-1', serial: 'serial-1' })
    const provisioner = createAgentProvisioner(deps)
    const { routes } = createAgentProvisionerRoutes({ provisioner, db })
    const res = await withUser('admin', routes).request('/provision', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; results: Array<{ deviceId: string; state: string }> }
    expect(body.total).toBe(1)
    expect(body.results[0]).toMatchObject({ deviceId: 'dev-1', state: 'ready' })
  })
})
