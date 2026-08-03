import { describe, expect, test } from 'bun:test'
import type { AdbStreamEndReason } from '@enkaku/adb'
import {
  createUiServerLauncher,
  UI_SERVER_DEVICE_PORT,
  UI_SERVER_INSTRUMENTATION,
  UI_SERVER_PACKAGE,
  UI_SERVER_STUB_CLASS,
  UI_SERVER_TEST_PACKAGE,
  type UiServerArtifactMismatch,
  type UiServerLauncherDeps,
} from './launcher'

/** A realistic `dumpsys package <pkg>` excerpt, shaped like `verify.test.ts`'s fixture. */
function dumpsysOutput(opts: { installed?: boolean; versionCode?: number } = {}): string {
  if (opts.installed === false) return 'Unable to find package: com.github.uiautomator\n'
  const versionCode = opts.versionCode ?? 2003003
  return [
    'Packages:',
    `  Package [${UI_SERVER_PACKAGE}] (39a4179):`,
    `    versionCode=${versionCode} minSdk=21 targetSdk=29`,
    '    versionName=2.3.3',
    '',
  ].join('\n')
}

/**
 * A fake `hostAdb` good enough to drive `start()`/`stop()`: `forward` always
 * succeeds, and `forward --list` reports the port as owned by the launcher's
 * own serial — matching the real device behaviour once `adb forward` has run.
 * `exec`'s `dumpsys package` reply defaults to "installed, versionCode
 * 2003003" (the plan's own real-farm evidence) — tests that care about the
 * verification outcome override it via `dumpsysReply`.
 */
function fakeDeps(
  overrides: Partial<UiServerLauncherDeps> = {},
  opts: { dumpsysReply?: (cmd: string) => string } = {},
): {
  deps: UiServerLauncherDeps
  execCalls: string[]
  hostAdbCalls: string[][]
  streamCalls: Array<{ cmd: string; onEnd: (reason: AdbStreamEndReason, err?: unknown) => void }>
  logs: Array<{ level: string; msg: string }>
  mismatches: UiServerArtifactMismatch[]
} {
  const execCalls: string[] = []
  const hostAdbCalls: string[][] = []
  const streamCalls: Array<{ cmd: string; onEnd: (reason: AdbStreamEndReason, err?: unknown) => void }> = []
  const logs: Array<{ level: string; msg: string }> = []
  const mismatches: UiServerArtifactMismatch[] = []
  const serial = 'serial-1'

  const deps: UiServerLauncherDeps = {
    serial,
    exec: async (cmd) => {
      execCalls.push(cmd)
      if (cmd.startsWith('dumpsys package')) return opts.dumpsysReply?.(cmd) ?? dumpsysOutput()
      return ''
    },
    hostAdb: async (args) => {
      hostAdbCalls.push(args)
      if (args[0] === 'forward' && args[1] === '--list') return `${serial} tcp:9123 tcp:${UI_SERVER_DEVICE_PORT}\n`
      return ''
    },
    apkPaths: async () => ({ app: '/tools/ui-server.apk', test: '/tools/ui-server-test.apk' }),
    execStream: async (cmd, opts) => {
      streamCalls.push({ cmd, onEnd: opts.onEnd })
      let stopped = false
      return {
        stop: async () => {
          if (stopped) return
          stopped = true
          opts.onEnd('stopped')
        },
      }
    },
    onLog: (level, msg) => logs.push({ level, msg }),
    onMismatch: (info) => mismatches.push(info),
    ...overrides,
  }
  return { deps, execCalls, hostAdbCalls, streamCalls, logs, mismatches }
}

describe('createUiServerLauncher (plan 34 §3.1, §3.2, §4.1)', () => {
  test('start() sends the corrected stub class — never the wrong test-package class', async () => {
    const { deps, streamCalls } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await launcher.start(9123)

    expect(streamCalls).toHaveLength(1)
    const cmd = streamCalls[0]?.cmd ?? ''
    expect(cmd).toContain(UI_SERVER_STUB_CLASS)
    expect(cmd).toContain('com.github.uiautomator.stub.Stub')
    expect(cmd).not.toContain('com.github.uiautomator.test.Stub')
    expect(cmd).toContain(UI_SERVER_INSTRUMENTATION)
  })

  test('start() runs the instrumentation through execStream, never through exec', async () => {
    const { deps, execCalls, streamCalls } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await launcher.start(9123)

    expect(streamCalls).toHaveLength(1)
    // `exec` is still used for `dumpsys package` (ensureInstalled) — just
    // never for the instrumentation itself.
    expect(execCalls.some((c) => c.startsWith('am instrument'))).toBe(false)
  })

  test('stop() stops the stream handle and force-stops both packages', async () => {
    const { deps, execCalls, streamCalls } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await launcher.start(9123)
    await launcher.stop(9123)

    expect(streamCalls).toHaveLength(1)
    expect(execCalls).toContain(`am force-stop ${UI_SERVER_PACKAGE}`)
    expect(execCalls).toContain(`am force-stop ${UI_SERVER_TEST_PACKAGE}`)
  })

  test('stop() before any start() is a no-op on the stream handle (nothing to tear down)', async () => {
    const { deps } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await expect(launcher.stop(9123)).resolves.toBeUndefined()
  })

  test('an unexpected stream end (not "stopped") is logged at warn, naming the class — plan 34 §8 risk row 1', async () => {
    const { deps, streamCalls, logs } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await launcher.start(9123)

    streamCalls[0]?.onEnd('closed', new Error('ClassNotFoundException'))

    const warn = logs.find((l) => l.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn?.msg).toContain(UI_SERVER_STUB_CLASS)
    expect(warn?.msg).toContain('closed')
  })

  test('stop() ending the stream ("stopped") is never logged as a warning', async () => {
    const { deps, logs } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await launcher.start(9123)
    logs.length = 0 // clear start()'s own debug logs
    await launcher.stop(9123)

    expect(logs.some((l) => l.level === 'warn')).toBe(false)
  })

  test('a lost port race after execStream succeeds still tears the stream down (no leak)', async () => {
    let stoppedCount = 0
    const deps: UiServerLauncherDeps = {
      serial: 'serial-2',
      exec: async (cmd) => {
        if (cmd.startsWith('dumpsys package')) return dumpsysOutput()
        return ''
      },
      hostAdb: async (args) => {
        // Reports a DIFFERENT serial as the owner — the race this guards against.
        if (args[0] === 'forward' && args[1] === '--list') return `some-other-serial tcp:9123 tcp:${UI_SERVER_DEVICE_PORT}\n`
        return ''
      },
      apkPaths: async () => ({ app: '/tools/ui-server.apk', test: '/tools/ui-server-test.apk' }),
      execStream: async () => ({
        stop: async () => {
          stoppedCount++
        },
      }),
    }
    const launcher = createUiServerLauncher(deps)
    await expect(launcher.start(9123)).rejects.toThrow(/refusing to inspect another device/)
    expect(stoppedCount).toBe(1)
  })
})

describe('ensureInstalled() — on-device artifact verification (plan 41 §3.2, §3.3, §4.2)', () => {
  test('AC1: a versionCode mismatch is detected, reinstalled exactly once, and reverified', async () => {
    let dumpsysCalls = 0
    const { deps, hostAdbCalls, mismatches } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      {
        dumpsysReply: () => {
          dumpsysCalls++
          // First read: the stale version installed elsewhere. After the
          // reinstall (second read onward): the expected version.
          return dumpsysCalls === 1 ? dumpsysOutput({ versionCode: 2001001 }) : dumpsysOutput({ versionCode: 2003003 })
        },
      },
    )
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()

    expect(dumpsysCalls).toBe(2) // verify → mismatch → reinstall → re-verify, no more
    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(1)
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2) // app + test
    expect(mismatches).toHaveLength(0) // repaired — never reaches onMismatch
  })

  test('AC2: a right-name, different-signature package is detected as signature_mismatch and reinstalled', async () => {
    const expectedSig = 'AA'.repeat(32)
    const wrongSigOutput = `${dumpsysOutput({ versionCode: 2003003 })}    signatures=PackageSignatures{x [1]}\n    cert=${'BB'.repeat(32)}\n`
    const okOutput = `${dumpsysOutput({ versionCode: 2003003 })}    signatures=PackageSignatures{x [1]}\n    cert=${expectedSig}\n`
    let dumpsysCalls = 0
    const { deps, hostAdbCalls, mismatches } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003, signatureSha256: expectedSig } },
      { dumpsysReply: () => (++dumpsysCalls === 1 ? wrongSigOutput : okOutput) },
    )
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(1)
    expect(mismatches).toHaveLength(0)
  })

  test('AC3: a repair that fails a second time reports the mismatch once and does not loop', async () => {
    // Always reports the stale version, even after the reinstall — the
    // scenario where something keeps reinstalling a conflicting package.
    const { deps, hostAdbCalls, mismatches } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      { dumpsysReply: () => dumpsysOutput({ versionCode: 2001001 }) },
    )
    const launcher = createUiServerLauncher(deps)

    await expect(launcher.ensureInstalled()).rejects.toThrow(/version_mismatch/)

    // Exactly ONE uninstall/reinstall cycle — not a retry loop (§3.3).
    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(1)
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2)
    expect(mismatches).toEqual([{ reason: 'version_mismatch', observed: { versionCode: 2001001 } }])
  })

  test('AC3 (integration): start() falls through the same failed-repair path and still tears the stream down', async () => {
    const { deps, streamCalls } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      { dumpsysReply: () => dumpsysOutput({ versionCode: 2001001 }) },
    )
    const launcher = createUiServerLauncher(deps)
    await expect(launcher.start(9123)).rejects.toThrow(/version_mismatch/)
    // ensureInstalled() throws before execStream is ever reached.
    expect(streamCalls).toHaveLength(0)
  })

  test('AC4: a manifest with no recorded expectation never blocks the inspector, and logs a notice', async () => {
    const { deps, hostAdbCalls, logs } = fakeDeps({}, { dumpsysReply: () => dumpsysOutput({ versionCode: 999999 }) })
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(0)
    expect(logs.some((l) => l.level === 'info' && l.msg.includes('installed presence only'))).toBe(true)
  })

  test('not installed at all → installed once, no uninstall, no mismatch report', async () => {
    const { deps, hostAdbCalls, mismatches } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      { dumpsysReply: () => dumpsysOutput({ installed: false }) },
    )
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(0)
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2)
    expect(mismatches).toHaveLength(0)
  })

  test('an unreadable verification result is skipped, not treated as a mismatch', async () => {
    const { deps, hostAdbCalls, logs } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      // Installed, but no versionCode line at all — unparseable.
      { dumpsysReply: () => 'Packages:\n  Package [com.github.uiautomator] (39a4179):\n' },
    )
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(0)
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('skipping artifact verification'))).toBe(true)
  })

  test('isInstalled() reflects verifyDeviceArtifact, not a bare package-name substring match', async () => {
    const { deps: installedDeps } = fakeDeps({}, { dumpsysReply: () => dumpsysOutput() })
    expect(await createUiServerLauncher(installedDeps).isInstalled()).toBe(true)

    const { deps: missingDeps } = fakeDeps({}, { dumpsysReply: () => dumpsysOutput({ installed: false }) })
    expect(await createUiServerLauncher(missingDeps).isInstalled()).toBe(false)
  })
})
