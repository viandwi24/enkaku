import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { defaultDeviceSettings } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import { CHECKS } from './checks/index'
import { renderHuman, renderJson } from './render'
import { runChecks } from './run'
import { fakeDoctorContext } from './test-helpers'
import type { DoctorContext } from './types'

/**
 * A real, on-disk data dir carrying one device with physical labelling
 * enabled and `state: 'unavailable'` (plan 89 §4.7, §5 step 89.4/89.9) — the
 * `labelling` check reads `enkaku.db` directly, the same way `devices` does,
 * so `unhappyContext` needs a real file to trip it into `warn` rather than
 * `skip` (skip is the CORRECT answer for a farm that never opted in, but
 * this context's whole job is to trip every check that CAN warn/fail).
 * `status: 'offline'` and a `stableId`/`serial` that never appear in
 * `devices.list()` below, deliberately: this row must not also perturb the
 * `devices` check's own adb-vs-registry disagreement logic, which is a
 * different check reading the SAME file.
 */
let unhappyDataDirCache: string | null = null
function unhappyDataDir(): string {
  if (unhappyDataDirCache) return unhappyDataDirCache
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-doctor-unhappy-'))
  const { db, sqlite } = openDb(join(dir, 'enkaku.db'))
  runMigrations(db, sqlite)
  db.insert(devices)
    .values({
      id: 'd-unhappy-label',
      stableId: 'stable-unhappy-label',
      serial: 'serial-unhappy-label',
      label: 'Stuck Phone',
      status: 'offline',
      settings: { ...defaultDeviceSettings(), labelling: { mode: 'wallpaper', showName: true } },
      labelState: {
        mode: 'wallpaper',
        state: 'unavailable',
        reason: 'no guest agent',
        fingerprint: null,
        appliedAt: null,
        originalCaptured: false,
        capturedLockScreen: null,
      },
    })
    .run()
  sqlite.close()
  unhappyDataDirCache = dir
  return dir
}

/** Trips every one of the registered checks into `warn` or `fail` — none stays `ok`/`skip`. */
function unhappyContext(): DoctorContext {
  return fakeDoctorContext({
    dataDir: unhappyDataDir(),
    runtime: { bunVersion: '0.9.0', platform: 'linux', arch: 'x64' },
    fs: { exists: async () => false, writable: async () => false, freeBytes: async () => null },
    config: {
      load: () => ({
        ok: true,
        host: '0.0.0.0',
        port: 7700,
        authMode: 'server',
        tlsMode: 'off',
        tlsConfigured: false,
        tlsPolicyError: 'server mode requires TLS',
      }),
    },
    port: {
      probeHealth: async () => ({ ok: false }),
      tryBind: async () => false,
      findHolder: async () => ({ pid: 1234, processName: 'node' }),
    },
    db: { inspect: async () => ({ state: 'corrupt', detail: 'malformed database schema' }) },
    tools: {
      status: async () => [{ id: 'adb', displayName: 'ADB', provisioned: false, version: null, healthOk: null, detail: null }],
    },
    adbServer: { check: async () => ({ reachable: false, error: 'ECONNREFUSED' }) },
    devices: { list: async () => [{ serial: 'ZP1', state: 'unauthorized' }] },
    egress: { host: 'github.com', check: async () => ({ reachable: false, error: 'timeout' }) },
    core: {
      probe: async () => ({
        running: true,
        health: { version: '0.1.2', deviceCount: 2, uptimeMs: 1000, mode: 'local' },
        quarantined: [{ deviceId: 'd1', label: 'Phone 1', reason: 'adb:unreachable' }],
      }),
    },
    streams: {
      probe: async () => ({ maxStreams: 10, maxStreamsPerDevice: 4, active: 10, perDevice: { d1: 10 } }),
    },
    hostAdb: {
      countAdbProcesses: async () => 5,
      probeCoreStats: async () => ({ running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 0 }),
    },
    adbHealth: {
      probe: async () => ({
        status: 'stuck',
        versionRttMs: null,
        lastCheckedAt: 1_000,
        window: { seconds: 600, execs: 40, timeouts: 25, timeoutRate: 0.625 },
        wedged: [],
        stuckOffline: [],
        symptoms: [
          { symptom: 'server-unresponsive', detail: 'host:version has not answered within 2000ms across 2 consecutive probes', since: 900 },
        ],
        restartAdvised: true,
      }),
    },
    coControl: {
      probe: async () => ({
        lanes: {
          pointer: { depth: 5, waitMsP50: 2000, waitMsP95: 4500, refusals: 3 },
          keys: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
          text: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
        },
        assistsActive: 2,
        mirrorGroups: 1,
        mirrorMembers: 3,
        mirrorFanoutMsP50: 40,
        mirrorFanoutMsP95: 120,
        queueWaitMs: 5_000,
        uncollectedGrants: 1,
        orphanedMirrorGroups: 1,
      }),
    },
  })
}

/** Everything that CAN be a `warn` is, but nothing `fail`s — proves warnings alone don't fail the exit code. */
function warnOnlyContext(): DoctorContext {
  return fakeDoctorContext({
    adbServer: { check: async () => ({ reachable: false, error: 'ECONNREFUSED' }) },
    devices: { list: async () => [{ serial: 'ZP1', state: 'unauthorized' }] },
    egress: { host: 'github.com', check: async () => ({ reachable: false, error: 'timeout' }) },
    core: {
      probe: async () => ({
        running: true,
        health: { version: '0.1.2', deviceCount: 2, uptimeMs: 1000, mode: 'local' },
        quarantined: [{ deviceId: 'd1', label: 'Phone 1', reason: 'adb:unreachable' }],
      }),
    },
  })
}

describe('doctor report — remedy coverage (plan 41 §3.5, §6.7)', () => {
  test('every registered check that resolves warn/fail carries a remedy', async () => {
    const { results } = await runChecks(unhappyContext())
    expect(results).toHaveLength(CHECKS.length)
    for (const r of results) {
      expect(['warn', 'fail']).toContain(r.status) // this context is designed to trip every one of them
      expect(r.remedy, `${r.id} (${r.status}) has no remedy`).toBeDefined()
      expect((r.remedy ?? '').length).toBeGreaterThan(0)
    }
  })

  test('an ok/skip result is never required to carry a remedy, and the happy path has none set', async () => {
    const { results } = await runChecks(fakeDoctorContext())
    for (const r of results) {
      expect(['ok', 'skip']).toContain(r.status)
      expect(r.remedy).toBeUndefined()
    }
  })
})

describe('doctor report — exit codes (plan 41 §6.9)', () => {
  test('exit code 1 when any check fails', async () => {
    const { exitCode } = await runChecks(unhappyContext())
    expect(exitCode).toBe(1)
  })

  test('exit code 0 when only warnings are present — warnings never fail it', async () => {
    const { exitCode } = await runChecks(warnOnlyContext())
    expect(exitCode).toBe(0)
  })

  test('exit code 0 on an all-clear run', async () => {
    const { exitCode } = await runChecks(fakeDoctorContext())
    expect(exitCode).toBe(0)
  })
})

describe('doctor report — human/json parity (plan 41 §6.8)', () => {
  test('the JSON output carries exactly the same results and exit code as the human report was computed from', async () => {
    const run = await runChecks(unhappyContext())
    const json = JSON.parse(renderJson(run)) as typeof run
    expect(json).toEqual(run)

    const human = renderHuman(run)
    for (const r of run.results) {
      expect(human).toContain(r.observed)
      if (r.remedy) expect(human).toContain(r.remedy)
    }
    expect(human).toContain(`exit code ${run.exitCode}`)
  })
})

describe('doctor package — never runs adb kill-server (repo rule, plan 41 §6.10)', () => {
  // Deliberately excludes THIS file (and anything else whose job is talking
  // ABOUT the rule) — those necessarily spell the forbidden string out in a
  // test name/comment to check for it elsewhere. What must never contain it
  // is the doctor package's actual implementation.
  const files = [
    'types.ts',
    'run.ts',
    'render.ts',
    'context.ts',
    'index.ts',
    'test-helpers.ts',
    'checks/index.ts',
    'checks/runtime.ts',
    'checks/data-dir.ts',
    'checks/config.ts',
    'checks/port.ts',
    'checks/db.ts',
    'checks/tools.ts',
    'checks/adb-server.ts',
    'checks/devices.ts',
    'checks/egress.ts',
    'checks/core.ts',
    'checks/streams.ts',
    'checks/host-adb.ts',
    'checks/adb-health.ts',
    'checks/co-control.ts',
    'checks/labelling.ts',
  ]

  test('the literal string "kill-server" appears nowhere in the doctor package\'s implementation', () => {
    for (const rel of files) {
      const content = readFileSync(join(import.meta.dir, rel), 'utf8')
      expect(content.toLowerCase(), `${rel} must never mention the forbidden command`).not.toContain('kill' + '-server')
    }
  })
})
