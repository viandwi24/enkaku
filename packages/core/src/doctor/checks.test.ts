import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations } from '../db'
import { devices } from '../db/schema'
import {
  adbServerCheck,
  configCheck,
  coreCheck,
  dataDirCheck,
  dbCheck,
  devicesCheck,
  egressCheck,
  portCheck,
  runtimeCheck,
  toolsCheck,
} from './checks/index'
import { fakeDoctorContext } from './test-helpers'

/**
 * A real, on-disk `enkaku.db` with the given device rows (plan 85 §5 step
 * 85.2's doctor check reads the file directly rather than through
 * `DoctorContext` — see `checks/devices.ts`'s own comment for why). Returns
 * the temp data dir; callers clean it up with `rmSync`.
 */
function tempDataDirWithDevices(rows: Array<{ serial: string; status: string }>): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-doctor-devices-'))
  const opened = openDb(join(dataDir, 'enkaku.db'))
  runMigrations(opened.db, opened.sqlite)
  for (const [i, r] of rows.entries()) {
    opened.db
      .insert(devices)
      .values({ id: `d${i}`, stableId: `stable-${i}`, serial: r.serial, label: `Phone ${i}`, status: r.status })
      .run()
  }
  opened.sqlite.close()
  return dataDir
}

describe('runtime check', () => {
  test('ok when Bun meets the minimum version', async () => {
    const result = await runtimeCheck.run(fakeDoctorContext({ runtime: { bunVersion: '1.3.14', platform: 'darwin', arch: 'arm64' } }))
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('1.3.14')
  })

  test('fails with a remedy when Bun is too old', async () => {
    const result = await runtimeCheck.run(fakeDoctorContext({ runtime: { bunVersion: '1.1.4', platform: 'linux', arch: 'x64' } }))
    expect(result.status).toBe('fail')
    expect(result.remedy).toBeDefined()
    expect(result.remedy).toContain('bun upgrade')
  })
})

describe('data-dir check', () => {
  test('fails with a remedy for an unwritable directory', async () => {
    const ctx = fakeDoctorContext({ fs: { exists: async () => true, writable: async () => false, freeBytes: async () => null } })
    const result = await dataDirCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.remedy).toContain('chmod')
  })

  test('fails with a remedy when the directory does not exist', async () => {
    const ctx = fakeDoctorContext({ fs: { exists: async () => false, writable: async () => false, freeBytes: async () => null } })
    const result = await dataDirCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.remedy).toBeDefined()
  })

  test('warns on low free space even though the directory is writable', async () => {
    const ctx = fakeDoctorContext({ fs: { exists: async () => true, writable: async () => true, freeBytes: async () => 10 * 1024 * 1024 } })
    const result = await dataDirCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toBeDefined()
  })
})

describe('config check', () => {
  test('fails with a remedy when the config file/env is invalid', async () => {
    const ctx = fakeDoctorContext({ config: { load: () => ({ ok: false, code: 'E_BAD_CONFIG', message: 'bad host' }) } })
    const result = await configCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.remedy).toBeDefined()
  })

  test('fails with the TLS policy error as the remedy when server mode has no TLS and no override', async () => {
    const ctx = fakeDoctorContext({
      config: {
        load: () => ({
          ok: true,
          host: '0.0.0.0',
          port: 7700,
          authMode: 'server',
          tlsMode: 'off',
          tlsConfigured: false,
          tlsPolicyError: 'server mode requires TLS: set tls.mode to "self" or "external"',
        }),
      },
    })
    const result = await configCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.remedy).toContain('TLS')
  })

  test('warns when server mode is running insecure via the explicit override', async () => {
    const ctx = fakeDoctorContext({
      config: {
        load: () => ({ ok: true, host: '0.0.0.0', port: 7700, authMode: 'server', tlsMode: 'off', tlsConfigured: false }),
      },
    })
    const result = await configCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('trusted network')
  })

  test('never echoes a cert/key path — only presence', async () => {
    const ctx = fakeDoctorContext({
      config: {
        load: () => ({ ok: true, host: '127.0.0.1', port: 7700, authMode: 'local', tlsMode: 'self', tlsConfigured: true }),
      },
    })
    const result = await configCheck.run(ctx)
    expect(result.observed).not.toContain('/')
    expect(result.observed).toContain('configured')
  })
})

describe('port check', () => {
  test('ok when a live core answers /api/health on that port', async () => {
    const ctx = fakeDoctorContext({ port: { probeHealth: async () => ({ ok: true, version: '0.1.2', deviceCount: 3 }), tryBind: async () => false, findHolder: async () => null } })
    const result = await portCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('0.1.2')
  })

  test('ok when the port is simply free', async () => {
    const ctx = fakeDoctorContext({ port: { probeHealth: async () => ({ ok: false }), tryBind: async () => true, findHolder: async () => null } })
    const result = await portCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('free')
  })

  test('fails with the holder pid in the remedy for an occupied port that is not our core', async () => {
    const ctx = fakeDoctorContext({
      port: { probeHealth: async () => ({ ok: false }), tryBind: async () => false, findHolder: async () => ({ pid: 1234, processName: 'node' }) },
    })
    const result = await portCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.remedy).toContain('1234')
    expect(result.remedy).toContain('ENKAKU_PORT')
  })

  test('skips when the config failed to load', async () => {
    const ctx = fakeDoctorContext({ config: { load: () => ({ ok: false, code: 'E_BAD_CONFIG', message: 'x' }) } })
    const result = await portCheck.run(ctx)
    expect(result.status).toBe('skip')
  })
})

describe('db check', () => {
  test('ok — not yet created is a legitimate first-run state', async () => {
    const result = await dbCheck.run(fakeDoctorContext({ db: { inspect: async () => ({ state: 'absent' }) } }))
    expect(result.status).toBe('ok')
  })

  test('fails with a remedy on a corrupt database, pointing at the real backup command', async () => {
    const result = await dbCheck.run(fakeDoctorContext({ db: { inspect: async () => ({ state: 'corrupt', detail: 'malformed' }) } }))
    expect(result.status).toBe('fail')
    // `enkaku backup` exists (packages/core/src/backup/) — the remedy must not
    // point an operator at a backup mechanism the product never gave them.
    expect(result.remedy).toContain('enkaku backup')
  })

  test('warns with a remedy on pending migrations', async () => {
    const result = await dbCheck.run(fakeDoctorContext({ db: { inspect: async () => ({ state: 'ok', pendingMigrations: 3 }) } }))
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('migrations run automatically')
  })

  test('ok, no pending migrations', async () => {
    const result = await dbCheck.run(fakeDoctorContext({ db: { inspect: async () => ({ state: 'ok', pendingMigrations: 0 }) } }))
    expect(result.status).toBe('ok')
  })
})

describe('tools check', () => {
  test('fails with a remedy when a required tool is not provisioned', async () => {
    const ctx = fakeDoctorContext({
      tools: { status: async () => [{ id: 'adb', displayName: 'ADB', provisioned: false, version: null, healthOk: null, detail: null }] },
    })
    const result = await toolsCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.observed).toContain('not provisioned')
    expect(result.remedy).toBeDefined()
  })

  test('fails with a remedy when a tool is provisioned but its health check failed', async () => {
    const ctx = fakeDoctorContext({
      tools: {
        status: async () => [{ id: 'scrcpy-server', displayName: 'scrcpy', provisioned: true, version: '3.3.1', healthOk: false, detail: 'sha256 mismatch' }],
      },
    })
    const result = await toolsCheck.run(ctx)
    expect(result.status).toBe('fail')
    expect(result.observed).toContain('sha256 mismatch')
  })

  test('ok when every tool is provisioned and healthy', async () => {
    const result = await toolsCheck.run(fakeDoctorContext())
    expect(result.status).toBe('ok')
  })
})

describe('adb-server check', () => {
  test('ok with the reported version when reachable', async () => {
    const result = await adbServerCheck.run(fakeDoctorContext({ adbServer: { check: async () => ({ reachable: true, version: '0041' }) } }))
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('0041')
  })

  test('warns (not fails) with a remedy when unreachable — this is a common, non-fatal state', async () => {
    const result = await adbServerCheck.run(fakeDoctorContext({ adbServer: { check: async () => ({ reachable: false, error: 'ECONNREFUSED' }) } }))
    expect(result.status).toBe('warn')
    expect(result.remedy).toBeDefined()
  })
})

describe('devices check', () => {
  test('ok with an empty fleet', async () => {
    const result = await devicesCheck.run(fakeDoctorContext({ devices: { list: async () => [] } }))
    expect(result.status).toBe('ok')
  })

  test('ok when every device is authorized and online', async () => {
    const result = await devicesCheck.run(fakeDoctorContext({ devices: { list: async () => [{ serial: 'ZP1', state: 'device' }] } }))
    expect(result.status).toBe('ok')
  })

  test('warns with a per-device remedy for an unauthorized device', async () => {
    const result = await devicesCheck.run(fakeDoctorContext({ devices: { list: async () => [{ serial: 'ZP2222T7K5', state: 'unauthorized' }] } }))
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('ZP2222T7K5')
    expect(result.remedy).toContain('RSA prompt')
  })

  test('warns with a per-device remedy for an offline device', async () => {
    const result = await devicesCheck.run(fakeDoctorContext({ devices: { list: async () => [{ serial: 'ZP3', state: 'offline' }] } }))
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('ZP3')
  })
})

describe('devices check — adb vs the registry, side by side (plan 85 §3.3, §5 step 85.2, testing H3)', () => {
  test('no local database yet: falls back to adb-only reporting, exactly as before this plan', async () => {
    // `fakeDoctorContext`'s default dataDir points nowhere on disk.
    const result = await devicesCheck.run(fakeDoctorContext({ devices: { list: async () => [{ serial: 'ZP1', state: 'device' }] } }))
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('registry: no local database yet')
  })

  test('a database that exists and will not open says so — never "no local database yet"', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-doctor-devices-'))
    try {
      writeFileSync(join(dataDir, 'enkaku.db'), 'this is not a database')
      const result = await devicesCheck.run(fakeDoctorContext({ dataDir, devices: { list: async () => [{ serial: 'ZP1', state: 'device' }] } }))
      expect(result.observed).toContain('could not be read')
      expect(result.observed).not.toContain('no local database yet')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('agrees: adb connected and the registry already has it non-offline — ok, side by side in observed', async () => {
    const dataDir = tempDataDirWithDevices([{ serial: 'ZP1', status: 'idle' }])
    try {
      const result = await devicesCheck.run(fakeDoctorContext({ dataDir, devices: { list: async () => [{ serial: 'ZP1', state: 'device' }] } }))
      expect(result.status).toBe('ok')
      expect(result.observed).toContain('adb: ZP1:device')
      // Plan 89 §4.7, §5 step 89.4 — the registry summary now names the
      // device by its own composed `#N label` (here numberless, so just the
      // bare label) alongside the serial, not the serial alone.
      expect(result.observed).toContain('registry: Phone 0 (ZP1):idle')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('disagrees: adb sees it connected, the registry still has it offline — fails, names the serial and both sides', async () => {
    const dataDir = tempDataDirWithDevices([{ serial: 'ZP1', status: 'offline' }])
    try {
      const result = await devicesCheck.run(fakeDoctorContext({ dataDir, devices: { list: async () => [{ serial: 'ZP1', state: 'device' }] } }))
      expect(result.status).toBe('fail')
      expect(result.remedy).toContain('ZP1')
      expect(result.remedy).toContain('rescan')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('disagrees the other way: the registry thinks it is online, adb does not see it at all — fails', async () => {
    const dataDir = tempDataDirWithDevices([{ serial: 'ZP-GONE', status: 'busy' }])
    try {
      const result = await devicesCheck.run(fakeDoctorContext({ dataDir, devices: { list: async () => [] } }))
      expect(result.status).toBe('fail')
      expect(result.remedy).toContain('ZP-GONE')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a device adb sees that the registry has never heard of at all is NOT a disagreement — ordinary Discovered-tray territory', async () => {
    const dataDir = tempDataDirWithDevices([])
    try {
      const result = await devicesCheck.run(fakeDoctorContext({ dataDir, devices: { list: async () => [{ serial: 'ZP-NEW', state: 'device' }] } }))
      expect(result.status).toBe('ok')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('egress check', () => {
  test('ok when reachable', async () => {
    const result = await egressCheck.run(fakeDoctorContext())
    expect(result.status).toBe('ok')
  })

  test('warns with a remedy (HTTPS_PROXY) when unreachable', async () => {
    const ctx = fakeDoctorContext({ egress: { host: 'github.com', check: async () => ({ reachable: false, error: 'timeout' }) } })
    const result = await egressCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('HTTPS_PROXY')
  })
})

describe('core check', () => {
  test('skips when no core is running — the standalone case', async () => {
    const result = await coreCheck.run(fakeDoctorContext({ core: { probe: async () => ({ running: false }) } }))
    expect(result.status).toBe('skip')
  })

  test('ok when a core is running with nothing quarantined', async () => {
    const ctx = fakeDoctorContext({
      core: {
        probe: async () => ({
          running: true,
          health: { version: '0.1.2', deviceCount: 4, uptimeMs: 60_000, mode: 'local' },
          quarantined: [],
        }),
      },
    })
    const result = await coreCheck.run(ctx)
    expect(result.status).toBe('ok')
  })

  test('warns with each quarantined device named in the remedy', async () => {
    const ctx = fakeDoctorContext({
      core: {
        probe: async () => ({
          running: true,
          health: { version: '0.1.2', deviceCount: 4, uptimeMs: 60_000, mode: 'local' },
          quarantined: [{ deviceId: 'd1', label: 'ZP2222T7K5', reason: 'adb:unreachable' }],
        }),
      },
    })
    const result = await coreCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('ZP2222T7K5')
    expect(result.remedy).toContain('adb:unreachable')
  })
})
