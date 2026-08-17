import { describe, expect, test } from 'bun:test'
import { UI_SERVER_PACKAGE } from '@enkaku/drivers'
import type { DeviceRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'
import { createLogger } from '../../util/logger'
import { createUiServerComponent, type UiServerComponentDeps } from './ui-server-component'

function makeRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'dev-1',
    stableId: 'stable-1',
    serial: 'serial-1',
    label: 'Test phone',
    ownerId: null,
    androidVersion: null,
    apiLevel: 34,
    screenW: null,
    screenH: null,
    density: null,
    transport: 'adb-usb',
    display: 'scrcpy',
    input: 'scrcpy-uhid',
    inspection: 'ui-server',
    battery: null,
    settings: null,
    status: 'idle',
    quarantineReason: null,
    nodeId: null,
    tenantId: null,
    lastSeen: null,
    clusterId: null,
    desiredReadiness: null,
    networkRoute: null,
    agent: null,
    preparation: null,
    labelFingerprint: null,
    labelState: null,
    ...overrides,
  } as DeviceRow
}

function dumpsysOutput(opts: { installed?: boolean; versionCode?: number } = {}): string {
  if (opts.installed === false) return 'Unable to find package: com.github.uiautomator\n'
  const versionCode = opts.versionCode ?? 2003003
  return [`Packages:`, `  Package [${UI_SERVER_PACKAGE}] (39a4179):`, `    versionCode=${versionCode} minSdk=21 targetSdk=29`, `    versionName=2.3.3`, ''].join('\n')
}

function fakeDeps(overrides: Partial<UiServerComponentDeps> = {}, opts: { dumpsysReply?: () => string } = {}): UiServerComponentDeps {
  return {
    exec: async (_serial, cmd) => {
      if (cmd.startsWith('dumpsys package')) return { stdout: opts.dumpsysReply?.() ?? dumpsysOutput(), stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    hostAdb: async () => '',
    apkPaths: async () => ({ app: '/tools/ui-server.apk', test: '/tools/ui-server-test.apk' }),
    expectedArtifact: async () => null,
    log: createLogger('test'),
    ...overrides,
  }
}

describe('createUiServerComponent (plan 106 §3.2, §4)', () => {
  test('applicable() is always true today — no known SDK floor for ui-server', () => {
    const component = createUiServerComponent(fakeDeps())
    expect(component.applicable(makeRow({ apiLevel: 1 }))).toBe(true)
  })

  test('already installed and verified resolves ready with the observed version', async () => {
    const component = createUiServerComponent(fakeDeps({}, { dumpsysReply: () => dumpsysOutput({ versionCode: 2003003 }) }))
    const result = await component.run(makeRow())
    expect(result).toEqual({ state: 'ready', version: '2003003', reason: null })
  })

  test('not installed: ensureInstalled() installs it, then the re-verify reports ready', async () => {
    let installCount = 0
    let installed = false
    const deps = fakeDeps(
      {
        hostAdb: async (args) => {
          if (args.includes('install')) {
            installCount++
            installed = true
          }
          return ''
        },
      },
      { dumpsysReply: () => dumpsysOutput({ installed }) },
    )
    const component = createUiServerComponent(deps)
    const result = await component.run(makeRow())
    expect(installCount).toBe(2) // app + test APK
    expect(result.state).toBe('ready')
  })

  test('a persistent install failure resolves failed with a verbatim reason, never crashes', async () => {
    const deps = fakeDeps({
      hostAdb: async (args) => {
        if (args.includes('install')) throw new Error('adb: failed to install /tools/ui-server.apk: INSTALL_FAILED_INSUFFICIENT_STORAGE')
        return ''
      },
    }, { dumpsysReply: () => dumpsysOutput({ installed: false }) })
    const component = createUiServerComponent(deps)
    const result = await component.run(makeRow())
    expect(result.state).toBe('failed')
    expect(result.reason).toContain('INSTALL_FAILED_INSUFFICIENT_STORAGE')
  })

  test('E_ADB_UNAVAILABLE from exec is rethrown unchanged, never folded into failed (plan 106 §3.3, §96.25)', async () => {
    const deps = fakeDeps({
      exec: async () => {
        throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
      },
    })
    const component = createUiServerComponent(deps)
    await expect(component.run(makeRow())).rejects.toMatchObject({ code: 'E_ADB_UNAVAILABLE' })
  })

  test('E_ADB_UNAVAILABLE from hostAdb (during install) is also rethrown unchanged', async () => {
    const deps = fakeDeps(
      {
        hostAdb: async (args) => {
          if (args.includes('install')) throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
          return ''
        },
      },
      { dumpsysReply: () => dumpsysOutput({ installed: false }) },
    )
    const component = createUiServerComponent(deps)
    await expect(component.run(makeRow())).rejects.toMatchObject({ code: 'E_ADB_UNAVAILABLE' })
  })

  test('E_ADB_UNAVAILABLE from installApk (plan 106 §5 step 106.8) is also rethrown unchanged — a core-side error must not consume the retry budget on the new path either', async () => {
    const deps = fakeDeps(
      {
        installApk: async () => {
          throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb is not ready yet')
        },
      },
      { dumpsysReply: () => dumpsysOutput({ installed: false }) },
    )
    const component = createUiServerComponent(deps)
    await expect(component.run(makeRow())).rejects.toMatchObject({ code: 'E_ADB_UNAVAILABLE' })
  })

  test('installApk (plan 106 §5 step 106.8): when supplied, installs are routed through it, bound to the device id, never through hostAdb', async () => {
    const calls: Array<{ deviceId: string; localPath: string; label: 'app' | 'test' }> = []
    const hostAdbCalls: string[][] = []
    let installed = false
    const deps = fakeDeps(
      {
        hostAdb: async (args) => {
          hostAdbCalls.push(args)
          return ''
        },
        installApk: async (deviceId, localPath, label) => {
          calls.push({ deviceId, localPath, label })
          installed = true
        },
      },
      { dumpsysReply: () => dumpsysOutput({ installed }) },
    )
    const component = createUiServerComponent(deps)
    const result = await component.run(makeRow({ id: 'dev-42' }))

    expect(calls).toEqual([
      { deviceId: 'dev-42', localPath: '/tools/ui-server.apk', label: 'app' },
      { deviceId: 'dev-42', localPath: '/tools/ui-server-test.apk', label: 'test' },
    ])
    expect(hostAdbCalls.some((a) => a.includes('install'))).toBe(false)
    expect(result.state).toBe('ready')
  })

  test('a manifest-expectation read failure degrades to failed rather than throwing', async () => {
    const deps = fakeDeps({
      expectedArtifact: async () => {
        throw new Error('manifest unreadable')
      },
    })
    const component = createUiServerComponent(deps)
    const result = await component.run(makeRow())
    expect(result).toEqual({ state: 'failed', version: null, reason: 'manifest unreadable' })
  })
})
