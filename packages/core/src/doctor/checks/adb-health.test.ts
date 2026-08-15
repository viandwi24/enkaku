import { describe, expect, test } from 'bun:test'
import { fakeDoctorContext } from '../test-helpers'
import { adbHealthCheck } from './adb-health'

describe('adb-health check (plan 88 §3.9, §4.7 — "is adb stuck?", fixes F21/F23)', () => {
  test('skips when no core is running — the verdict is only known while it is up', async () => {
    const result = await adbHealthCheck.run(fakeDoctorContext({ adbHealth: { probe: async () => null } }))
    expect(result.status).toBe('skip')
  })

  test('ok when the live verdict is ok, and no remedy is attached', async () => {
    const ctx = fakeDoctorContext({
      adbHealth: {
        probe: async () => ({
          status: 'ok',
          versionRttMs: 4,
          lastCheckedAt: 1_000,
          window: { seconds: 600, execs: 40, timeouts: 0, timeoutRate: 0 },
          wedged: [],
          stuckOffline: [],
          symptoms: [],
          restartAdvised: false,
        }),
      },
    })
    const result = await adbHealthCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('4ms')
    expect(result.remedy).toBeUndefined()
  })

  test('warns (never fails) on a degraded verdict, with a remedy naming what to do', async () => {
    const ctx = fakeDoctorContext({
      adbHealth: {
        probe: async () => ({
          status: 'degraded',
          versionRttMs: null,
          lastCheckedAt: 1_000,
          window: { seconds: 600, execs: 0, timeouts: 0, timeoutRate: 0 },
          wedged: [],
          stuckOffline: [],
          symptoms: [{ symptom: 'server-unreachable', detail: 'no adb server answered on 127.0.0.1:5037', since: 900 }],
          restartAdvised: false,
        }),
      },
    })
    const result = await adbHealthCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.observed).toContain('no adb server answered')
    expect(result.remedy).toBeDefined()
    expect(result.remedy).toContain('self-heals')
  })

  test('fails on a stuck verdict, with a remedy that names the Tools restart action', async () => {
    const ctx = fakeDoctorContext({
      adbHealth: {
        probe: async () => ({
          status: 'stuck',
          versionRttMs: null,
          lastCheckedAt: 1_000,
          window: { seconds: 600, execs: 40, timeouts: 5, timeoutRate: 0.125 },
          wedged: [],
          stuckOffline: [],
          symptoms: [
            { symptom: 'server-unresponsive', detail: 'host:version has not answered within 2000ms across 2 consecutive probes', since: 900 },
          ],
          restartAdvised: true,
        }),
      },
    })
    const result = await adbHealthCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.observed).toContain('host:version has not answered')
    expect(result.remedy).toContain('Restart adb server')
  })

  test('a "reconnect-ineffective"-only verdict is honest that restarting adb may not be the fix', async () => {
    const ctx = fakeDoctorContext({
      adbHealth: {
        probe: async () => ({
          status: 'degraded',
          versionRttMs: 3,
          lastCheckedAt: 1_000,
          window: { seconds: 600, execs: 40, timeouts: 0, timeoutRate: 0 },
          wedged: [],
          stuckOffline: [{ serial: 'SER1', state: 'offline', sinceSec: 300, nudges: 4 }],
          symptoms: [{ symptom: 'reconnect-ineffective', detail: 'SER1 still offline after 4 nudges', since: 700 }],
          restartAdvised: false,
        }),
      },
    })
    const result = await adbHealthCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('may not help')
  })

  test('multiple symptoms produce one remedy per symptom, joined', async () => {
    const ctx = fakeDoctorContext({
      adbHealth: {
        probe: async () => ({
          status: 'stuck',
          versionRttMs: null,
          lastCheckedAt: 1_000,
          window: { seconds: 600, execs: 40, timeouts: 25, timeoutRate: 0.625 },
          wedged: [
            { serial: 'SER1', consecutiveTimeouts: 3, adbState: 'device' },
            { serial: 'SER2', consecutiveTimeouts: 4, adbState: 'device' },
          ],
          stuckOffline: [],
          symptoms: [
            { symptom: 'transports-wedged', detail: '2 device(s) have 3+ consecutive adb timeouts: SER1, SER2', since: 800 },
            { symptom: 'timeout-storm', detail: '62% of the last 40 adb commands timed out over 600s', since: 850 },
          ],
          restartAdvised: true,
        }),
      },
    })
    const result = await adbHealthCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.remedy).toContain('shared server')
    expect(result.remedy).toContain('USB')
  })
})
