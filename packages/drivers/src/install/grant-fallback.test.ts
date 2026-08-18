import { describe, expect, test } from 'bun:test'
import type { ShellResult } from '@enkaku/protocol'
import { grantRuntimePermissions, installWithGrantFallback, isGrantAllPermissionsRejection, readRuntimePermissions } from './grant-fallback'

/** Verbatim from the Xiaomi 25128PC17G (HyperOS, Android 16) capture that this module exists for. */
const XIAOMI_G_REJECTION = [
  'adb -s 19625O001132 install -r -g app-release.apk exited 1 after 0.1s',
  '  stdout: Performing Streamed Install',
  "  stderr: adb: failed to install app-release.apk: \nException occurred while executing 'install':",
  'java.lang.SecurityException: You need the android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS permission to use the PackageManager.INSTALL_GRANT_ALL_REQUESTED_PERMISSIONS flag',
  '\tat com.android.server.pm.PackageInstallerService.createSessionInternal(PackageInstallerService.java:973)',
].join('\n')

function sh(stdout = '', exitCode: number | null = 0, stderr = ''): ShellResult {
  return { stdout, stderr, exitCode }
}

/** A `dumpsys package` excerpt with a `runtime permissions:` block, in the shape three OEMs were observed to print. */
function dumpsys(perms: Record<string, boolean>): string {
  return [
    'Packages:',
    '  Package [dev.enkaku.guestagent] (39a4179):',
    '    requested permissions:',
    '      android.permission.INTERNET',
    '    runtime permissions:',
    ...Object.entries(perms).map(([name, granted]) => `        ${name}: granted=${granted}, flags=[ USER_SENSITIVE_WHEN_GRANTED]`),
    '',
  ].join('\n')
}

describe('isGrantAllPermissionsRejection', () => {
  test('matches the platform refusing the -g flag itself', () => {
    expect(isGrantAllPermissionsRejection(XIAOMI_G_REJECTION)).toBe(true)
  })

  test('does NOT match an ordinary install failure — the fallback must never be a blind retry', () => {
    for (const other of [
      'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signatures do not match]',
      'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
      'adb: failed to stat app-release.apk: No such file or directory',
      'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
    ]) {
      expect(isGrantAllPermissionsRejection(other)).toBe(false)
    }
  })
})

describe('readRuntimePermissions', () => {
  test('parses the granted= line for each runtime permission', async () => {
    const map = await readRuntimePermissions(
      async () => sh(dumpsys({ 'android.permission.POST_NOTIFICATIONS': false, 'android.permission.READ_PHONE_STATE': true })),
      'dev.enkaku.guestagent',
    )
    expect(map.get('android.permission.POST_NOTIFICATIONS')).toBe(false)
    expect(map.get('android.permission.READ_PHONE_STATE')).toBe(true)
  })

  test('an output this parser finds nothing in reads as unreadable (empty), never as "no permissions"', async () => {
    const map = await readRuntimePermissions(async () => sh('some OEM shape nobody has seen'), 'dev.enkaku.guestagent')
    expect(map.size).toBe(0)
  })

  test('an exec that throws reads as unreadable rather than propagating', async () => {
    const map = await readRuntimePermissions(async () => {
      throw new Error('device offline')
    }, 'dev.enkaku.guestagent')
    expect(map.size).toBe(0)
  })
})

describe('grantRuntimePermissions', () => {
  test('grants only what the device reports as ungranted, and verifies with a readback', async () => {
    const calls: string[] = []
    let granted = false
    await grantRuntimePermissions({
      packageName: 'dev.enkaku.guestagent',
      exec: async (cmd) => {
        calls.push(cmd)
        if (cmd.startsWith('dumpsys package')) {
          return sh(dumpsys({ 'android.permission.POST_NOTIFICATIONS': granted, 'android.permission.READ_PHONE_STATE': true }))
        }
        if (cmd.startsWith('pm grant')) {
          granted = true
          return sh()
        }
        return sh()
      },
    })
    expect(calls.filter((c) => c.startsWith('pm grant'))).toEqual([
      "pm grant 'dev.enkaku.guestagent' 'android.permission.POST_NOTIFICATIONS'",
    ])
    // Two dumpsys reads: the "what is missing" one and the verification one.
    expect(calls.filter((c) => c.startsWith('dumpsys package'))).toHaveLength(2)
  })

  test('"not a changeable permission type" is tolerated — that is API < 33 saying POST_NOTIFICATIONS is install-time here, not a failure', async () => {
    await expect(
      grantRuntimePermissions({
        packageName: 'dev.enkaku.guestagent',
        expected: ['android.permission.POST_NOTIFICATIONS'],
        exec: async (cmd) => {
          if (cmd.startsWith('dumpsys package')) return sh('nothing this parser recognises')
          if (cmd.startsWith('pm grant')) {
            return sh('', 255, 'java.lang.SecurityException: Permission android.permission.POST_NOTIFICATIONS is not a changeable permission type')
          }
          return sh()
        },
      }),
    ).resolves.toBeUndefined()
  })

  test('a pm grant that exits non-zero for a real reason throws, naming the permission and the device’s own words', async () => {
    const promise = grantRuntimePermissions({
      packageName: 'dev.enkaku.guestagent',
      exec: async (cmd) => {
        if (cmd.startsWith('dumpsys package')) return sh(dumpsys({ 'android.permission.POST_NOTIFICATIONS': false }))
        if (cmd.startsWith('pm grant')) return sh('', 255, 'Operation not allowed: uid 2000 cannot grant to package')
        return sh()
      },
    })
    await expect(promise).rejects.toThrow(/POST_NOTIFICATIONS/)
    await expect(promise).rejects.toThrow(/Operation not allowed/)
  })

  test('a pm grant that exits 0 and does nothing is caught by the readback', async () => {
    await expect(
      grantRuntimePermissions({
        packageName: 'dev.enkaku.guestagent',
        exec: async (cmd) => {
          if (cmd.startsWith('dumpsys package')) return sh(dumpsys({ 'android.permission.POST_NOTIFICATIONS': false }))
          return sh() // pm grant "succeeds" and changes nothing
        },
      }),
    ).rejects.toThrow(/still reads granted=false/)
  })

  test('an expected permission the device never mentions is still attempted (unreadable dumpsys must not skip the grant)', async () => {
    const calls: string[] = []
    await grantRuntimePermissions({
      packageName: 'dev.enkaku.guestagent',
      expected: ['android.permission.POST_NOTIFICATIONS'],
      exec: async (cmd) => {
        calls.push(cmd)
        return sh('an OEM dumpsys shape this parser does not recognise')
      },
    })
    expect(calls.some((c) => c.startsWith('pm grant'))).toBe(true)
  })
})

describe('installWithGrantFallback', () => {
  function fake(opts: { rejectG: boolean; grantWorks?: boolean }) {
    const hostAdbCalls: string[][] = []
    const execCalls: string[] = []
    let granted = false
    return {
      hostAdbCalls,
      execCalls,
      deps: {
        serial: 'serial-1',
        hostAdb: async (args: string[]) => {
          hostAdbCalls.push(args)
          if (opts.rejectG && args.includes('-g')) throw new Error(XIAOMI_G_REJECTION)
          return ''
        },
        exec: async (cmd: string) => {
          execCalls.push(cmd)
          if (cmd.startsWith('dumpsys package')) return sh(dumpsys({ 'android.permission.POST_NOTIFICATIONS': granted }))
          if (cmd.startsWith('pm grant')) {
            if (opts.grantWorks !== false) granted = true
            return sh()
          }
          return sh()
        },
        apkPath: '/tools/app.apk',
        packageName: 'dev.enkaku.guestagent',
        flags: ['-r'],
      },
    }
  }

  test('uses -g when the platform accepts it, and never touches the shell', async () => {
    const { deps, hostAdbCalls, execCalls } = fake({ rejectG: false })
    await installWithGrantFallback(deps)
    expect(hostAdbCalls).toEqual([['-s', 'serial-1', 'install', '-r', '-g', '/tools/app.apk']])
    expect(execCalls).toEqual([])
  })

  test('falls back to install-without--g plus explicit grants when the platform refuses the flag', async () => {
    const { deps, hostAdbCalls, execCalls } = fake({ rejectG: true })
    await installWithGrantFallback(deps)
    expect(hostAdbCalls).toEqual([
      ['-s', 'serial-1', 'install', '-r', '-g', '/tools/app.apk'],
      ['-s', 'serial-1', 'install', '-r', '/tools/app.apk'],
    ])
    expect(execCalls.some((c) => c.startsWith('pm grant'))).toBe(true)
  })

  test('a grant that does not take fails the install — never a half-installed package reported as ready', async () => {
    const { deps } = fake({ rejectG: true, grantWorks: false })
    await expect(installWithGrantFallback(deps)).rejects.toThrow(/could not be granted/)
  })

  test('any other install failure is rethrown untouched — the fallback is not a blind retry', async () => {
    const hostAdbCalls: string[][] = []
    await expect(
      installWithGrantFallback({
        serial: 'serial-1',
        hostAdb: async (args) => {
          hostAdbCalls.push(args)
          throw new Error('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]')
        },
        exec: async () => sh(),
        apkPath: '/tools/app.apk',
        packageName: 'dev.enkaku.guestagent',
        flags: ['-r'],
      }),
    ).rejects.toThrow(/INSTALL_FAILED_UPDATE_INCOMPATIBLE/)
    expect(hostAdbCalls).toHaveLength(1)
  })
})
