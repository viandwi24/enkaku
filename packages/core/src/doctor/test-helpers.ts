import type { DoctorContext } from './types'

/**
 * A fully-wired "everything is fine" fake context — every check in the
 * registry passes `ok` against it untouched. Tests override just the
 * namespace(s) relevant to the check under test (plan 41 §4.3, §7 — "no
 * check may require real hardware", so every field here is a plain fake).
 */
export function fakeDoctorContext(overrides: Partial<DoctorContext> = {}): DoctorContext {
  const base: DoctorContext = {
    dataDir: '/fake/data-dir',
    runtime: { bunVersion: '1.3.0', platform: 'darwin', arch: 'arm64' },
    fs: {
      exists: async () => true,
      writable: async () => true,
      freeBytes: async () => 50 * 1024 * 1024 * 1024,
    },
    config: {
      load: () => ({
        ok: true,
        host: '127.0.0.1',
        port: 7700,
        authMode: 'local',
        tlsMode: 'off',
        tlsConfigured: false,
      }),
    },
    port: {
      probeHealth: async () => ({ ok: false }),
      tryBind: async () => true,
      findHolder: async () => null,
    },
    db: {
      inspect: async () => ({ state: 'absent' }),
    },
    tools: {
      status: async () => [{ id: 'adb', displayName: 'ADB', provisioned: true, version: '36.0.0', healthOk: true, detail: null }],
    },
    adbServer: {
      check: async () => ({ reachable: true, version: '0029' }),
    },
    devices: {
      list: async () => [],
    },
    egress: {
      host: 'github.com',
      check: async () => ({ reachable: true }),
    },
    core: {
      probe: async () => ({ running: false }),
    },
    streams: {
      probe: async () => null,
    },
    hostAdb: {
      countAdbProcesses: async () => 0,
      probeCoreStats: async () => null,
    },
    adbHealth: {
      probe: async () => null,
    },
  }
  return { ...base, ...overrides }
}
