import { describe, expect, test } from 'bun:test'
import { UI_SERVER_PACKAGE, UI_SERVER_TEST_PACKAGE } from '@enkaku/drivers'
import type { DeviceRow } from '../db/schema'
import { createLogger } from '../util/logger'
import { createUiServerComponent, type UiServerComponentDeps } from './preparation/ui-server-component'

/**
 * The preparation readiness row Studio renders ("UI server (openatx)") used to
 * report `ready, version 2003003` on a device that carried ONLY the app APK —
 * `2003003` being the app package's versionCode, read while the instrumentation
 * package `com.github.uiautomator.test` was absent and every job was failing.
 * Observed on ZP2222RMBS (moto g06).
 *
 * These live outside `preparation/ui-server-component.test.ts` on purpose: the
 * verdict is produced by `createUiServerLauncher().ensureInstalled()`, and this
 * file asserts the END-TO-END consequence for the readiness surface.
 */

function makeRow(): DeviceRow {
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
    groupId: null,
    desiredReadiness: null,
    networkRoute: null,
    agent: null,
    preparation: null,
    labelFingerprint: null,
    labelState: null,
  } as DeviceRow
}

/** The app package installed and readable — exactly what the broken device reported. */
function dumpsysOutput(): string {
  return [
    'Packages:',
    `  Package [${UI_SERVER_PACKAGE}] (39a4179):`,
    '    versionCode=2003003 minSdk=21 targetSdk=29',
    '    versionName=2.3.3',
    '',
  ].join('\n')
}

function pmListOutput(opts: { test: boolean }): string {
  const lines = [`package:${UI_SERVER_PACKAGE}`]
  if (opts.test) lines.push(`package:${UI_SERVER_TEST_PACKAGE}`)
  return `${lines.join('\n')}\n`
}

function fakeDeps(opts: { testPackageInstallable: boolean }): { deps: UiServerComponentDeps; installs: string[] } {
  const installs: string[] = []
  let testInstalled = false
  const deps: UiServerComponentDeps = {
    exec: async (_serial, cmd) => {
      if (cmd.startsWith('dumpsys package')) return { stdout: dumpsysOutput(), stderr: '', exitCode: 0 }
      if (cmd.startsWith('pm list packages')) return { stdout: pmListOutput({ test: testInstalled }), stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    hostAdb: async (args) => {
      if (args.includes('install')) {
        installs.push(args[args.length - 1] ?? '')
        if (opts.testPackageInstallable) testInstalled = true
      }
      return ''
    },
    apkPaths: async () => ({ app: '/tools/ui-server.apk', test: '/tools/ui-server-test.apk' }),
    expectedArtifact: async () => ({ versionCode: 2003003 }),
    log: createLogger('test'),
  }
  return { deps, installs }
}

describe('preparation readiness when only the app APK is installed', () => {
  test('the verdict is NOT ready, and the reason names the missing instrumentation package', async () => {
    const { deps, installs } = fakeDeps({ testPackageInstallable: false })
    const result = await createUiServerComponent(deps).run(makeRow())

    expect(result.state).not.toBe('ready')
    expect(result.state).toBe('failed')
    expect(result.reason).toContain(UI_SERVER_TEST_PACKAGE)
    // Never the app package's versionCode dressed up as a working component.
    expect(result.version).toBeNull()
    // One repair attempt (app + test), then degrade — not a loop.
    expect(installs).toHaveLength(2)
  })

  test('when the repair sticks, the verdict is ready again', async () => {
    const { deps } = fakeDeps({ testPackageInstallable: true })
    const result = await createUiServerComponent(deps).run(makeRow())

    expect(result).toEqual({ state: 'ready', version: '2003003', reason: null })
  })
})
