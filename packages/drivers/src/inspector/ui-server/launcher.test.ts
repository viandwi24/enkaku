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
 * `pm list packages com.github.uiautomator` as a real device answers it — the
 * substring filter matches BOTH packages on a healthy device. `app`/`test`
 * select which of the two lines are present.
 */
function pmListOutput(opts: { app?: boolean; test?: boolean } = {}): string {
  const lines: string[] = []
  if (opts.app !== false) lines.push(`package:${UI_SERVER_PACKAGE}`)
  if (opts.test !== false) lines.push(`package:${UI_SERVER_TEST_PACKAGE}`)
  return `${lines.join('\n')}\n`
}

/**
 * A fake `hostAdb`/`forward`/`listForward`/`killForward` good enough to
 * drive `start()`/`stop()`: `forward` always succeeds, and `listForward`
 * reports the port as owned by the launcher's own serial — matching the
 * real device behaviour once a forward has been added (plan 119 §4.1's
 * `AdbClient.forward`/`listForward`/`killForward`, replacing the old
 * `hostAdb(['forward', ...])` CLI-spawn trio for JUST the forward
 * lifecycle — `hostAdb` itself is still exercised below for install/
 * uninstall). `exec`'s `dumpsys package` reply defaults to "installed,
 * versionCode 2003003" (the plan's own real-farm evidence) and its `pm
 * list packages` reply to "both APKs present" — tests that care about
 * either verification outcome override them via `dumpsysReply`/`pmListReply`.
 */
function fakeDeps(
  overrides: Partial<UiServerLauncherDeps> = {},
  opts: { dumpsysReply?: (cmd: string) => string; pmListReply?: () => string } = {},
): {
  deps: UiServerLauncherDeps
  execCalls: string[]
  hostAdbCalls: string[][]
  forwardCalls: Array<{ serial: string; local: string; remote: string }>
  killForwardCalls: Array<{ serial: string; local: string }>
  streamCalls: Array<{ cmd: string; onEnd: (reason: AdbStreamEndReason, err?: unknown) => void }>
  logs: Array<{ level: string; msg: string }>
  mismatches: UiServerArtifactMismatch[]
} {
  const execCalls: string[] = []
  const hostAdbCalls: string[][] = []
  const forwardCalls: Array<{ serial: string; local: string; remote: string }> = []
  const killForwardCalls: Array<{ serial: string; local: string }> = []
  const streamCalls: Array<{ cmd: string; onEnd: (reason: AdbStreamEndReason, err?: unknown) => void }> = []
  const logs: Array<{ level: string; msg: string }> = []
  const mismatches: UiServerArtifactMismatch[] = []
  const serial = 'serial-1'

  const deps: UiServerLauncherDeps = {
    serial,
    exec: async (cmd) => {
      execCalls.push(cmd)
      if (cmd.startsWith('dumpsys package')) return opts.dumpsysReply?.(cmd) ?? dumpsysOutput()
      if (cmd.startsWith('pm list packages')) return opts.pmListReply?.() ?? pmListOutput()
      return ''
    },
    hostAdb: async (args) => {
      hostAdbCalls.push(args)
      return ''
    },
    forward: async (fwdSerial, local, remote) => {
      forwardCalls.push({ serial: fwdSerial, local, remote })
    },
    listForward: async () => [{ serial, local: 'tcp:9123', remote: `tcp:${UI_SERVER_DEVICE_PORT}` }],
    killForward: async (fwdSerial, local) => {
      killForwardCalls.push({ serial: fwdSerial, local })
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
  return { deps, execCalls, hostAdbCalls, forwardCalls, killForwardCalls, streamCalls, logs, mismatches }
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

  test('start()/stop() drive the forward lifecycle through the smartsocket trio, never through hostAdb (plan 119 §4.2, §6.3)', async () => {
    const { deps, hostAdbCalls, forwardCalls, killForwardCalls } = fakeDeps()
    const launcher = createUiServerLauncher(deps)
    await launcher.start(9123)
    await launcher.stop(9123)

    expect(forwardCalls).toEqual([{ serial: 'serial-1', local: 'tcp:9123', remote: `tcp:${UI_SERVER_DEVICE_PORT}` }])
    expect(killForwardCalls).toEqual([{ serial: 'serial-1', local: 'tcp:9123' }])
    // `hostAdb` is only ever used for install/uninstall (plan 119 §2) — this
    // device is already correctly installed, so nothing calls it at all.
    expect(hostAdbCalls).toHaveLength(0)
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
      hostAdb: async () => '',
      forward: async () => {},
      // Reports a DIFFERENT serial as the owner — the race this guards against.
      listForward: async () => [{ serial: 'some-other-serial', local: 'tcp:9123', remote: `tcp:${UI_SERVER_DEVICE_PORT}` }],
      killForward: async () => {},
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

  test('isInstalled() is false when only the app package is there — the instrumentation cannot run without the test one', async () => {
    const { deps } = fakeDeps({}, { pmListReply: () => pmListOutput({ test: false }) })
    expect(await createUiServerLauncher(deps).isInstalled()).toBe(false)
  })
})

/**
 * The app-installed/test-missing state, observed on ZP2222RMBS (moto g06):
 * `dumpsys package com.github.uiautomator` answers perfectly, `pm list
 * packages | grep uiautomator` shows only the app, and the instrumentation
 * (which targets the TEST package) dies with `ended unexpectedly: closed`.
 */
describe('ensureInstalled() — the instrumentation package is verified too, not just the app', () => {
  test('app installed, test package missing → detected, installBoth() runs, and the device is usable afterwards', async () => {
    let installed = false
    const { deps, hostAdbCalls, logs } = fakeDeps({}, { pmListReply: () => pmListOutput({ test: installed }) })
    const baseHostAdb = deps.hostAdb
    deps.hostAdb = async (args, opts) => {
      if (args.includes('install')) installed = true
      return baseHostAdb(args, opts)
    }
    const launcher = createUiServerLauncher(deps)

    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2) // app + test
    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(0)
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes(`${UI_SERVER_TEST_PACKAGE} is missing`))).toBe(true)
    expect(logs.some((l) => l.level === 'info' && l.msg.includes(`${UI_SERVER_TEST_PACKAGE} installed and verified`))).toBe(true)
  })

  test('both packages missing → unchanged from today: one installBoth(), no uninstall, no throw', async () => {
    let installed = false
    const { deps, hostAdbCalls, mismatches } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      {
        dumpsysReply: () => dumpsysOutput({ installed }),
        pmListReply: () => (installed ? pmListOutput() : ''),
      },
    )
    const originalHostAdb = deps.hostAdb
    deps.hostAdb = async (args, opts) => {
      if (args.includes('install')) installed = true
      return originalHostAdb(args, opts)
    }
    const launcher = createUiServerLauncher(deps)

    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(0)
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2)
    expect(mismatches).toHaveLength(0)
  })

  test('both packages present → NO reinstall (this is the hot path: every session start runs it)', async () => {
    const { deps, hostAdbCalls } = fakeDeps({ expectedArtifact: { versionCode: 2003003 } })
    const launcher = createUiServerLauncher(deps)

    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(0)
    expect(hostAdbCalls.filter((a) => a.includes('uninstall'))).toHaveLength(0)
  })

  test('a repair that does not bring the test package back throws ONE error naming it — never a socket timeout', async () => {
    const { deps, hostAdbCalls, mismatches } = fakeDeps({}, { pmListReply: () => pmListOutput({ test: false }) })
    const launcher = createUiServerLauncher(deps)

    await expect(launcher.ensureInstalled()).rejects.toThrow(
      `${UI_SERVER_TEST_PACKAGE} is not installed on serial-1 after one repair attempt — ${UI_SERVER_PACKAGE} alone cannot run the ui-server instrumentation (${UI_SERVER_INSTRUMENTATION})`,
    )
    // Exactly one repair cycle, then degrade — the same budget as plan 41 §3.3.
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2)
    expect(mismatches).toEqual([{ reason: 'not_installed' }])
  })

  test('start() degrades through the same path, before the instrumentation is ever launched', async () => {
    const { deps, streamCalls } = fakeDeps({}, { pmListReply: () => pmListOutput({ test: false }) })
    const launcher = createUiServerLauncher(deps)

    await expect(launcher.start(9123)).rejects.toThrow(UI_SERVER_TEST_PACKAGE)
    expect(streamCalls).toHaveLength(0)
  })

  test('after the version-mismatch repair, a still-absent test package is reported without a SECOND install cycle', async () => {
    let dumpsysCalls = 0
    const { deps, hostAdbCalls } = fakeDeps(
      { expectedArtifact: { versionCode: 2003003 } },
      {
        // First read: stale (drives the version_mismatch repair). After the
        // reinstall: the expected version — but the test package never appears.
        dumpsysReply: () => (++dumpsysCalls === 1 ? dumpsysOutput({ versionCode: 2001001 }) : dumpsysOutput({ versionCode: 2003003 })),
        pmListReply: () => pmListOutput({ test: false }),
      },
    )
    const launcher = createUiServerLauncher(deps)

    await expect(launcher.ensureInstalled()).rejects.toThrow(
      `${UI_SERVER_TEST_PACKAGE} is not installed on serial-1 after reinstalling both APKs`,
    )
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2) // the mismatch repair's, and no more
  })

  test('an unreadable package listing is skipped, not treated as a missing test package', async () => {
    const { deps, hostAdbCalls, logs } = fakeDeps({}, { pmListReply: () => '' })
    const launcher = createUiServerLauncher(deps)

    await launcher.ensureInstalled()

    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(0)
    expect(logs.some((l) => l.msg.includes('could not read the installed package list'))).toBe(true)
  })
})

describe('installApk (plan 106 §5 step 106.8) — routes installBoth() through the transfer machinery instead of a raw hostAdb install', () => {
  test('when supplied, BOTH apks go through installApk, and hostAdb never sees an "install" call', async () => {
    const installCalls: Array<{ localPath: string; label: 'app' | 'test' }> = []
    const { deps, hostAdbCalls } = fakeDeps(
      {
        installApk: async (localPath, label) => {
          installCalls.push({ localPath, label })
        },
      },
      { dumpsysReply: () => dumpsysOutput({ installed: false }) },
    )
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()

    expect(installCalls).toEqual([
      { localPath: '/tools/ui-server.apk', label: 'app' },
      { localPath: '/tools/ui-server-test.apk', label: 'test' },
    ])
    expect(hostAdbCalls.some((a) => a.includes('install'))).toBe(false)
  })

  test('a rejection from installApk propagates — the repair-once loop still applies on top of it', async () => {
    const { deps, hostAdbCalls } = fakeDeps(
      {
        installApk: async () => {
          throw new Error('E_INSTALL_FAILED: INSTALL_FAILED_VERIFICATION_FAILURE')
        },
      },
      { dumpsysReply: () => dumpsysOutput({ installed: false }) },
    )
    const launcher = createUiServerLauncher(deps)

    await expect(launcher.ensureInstalled()).rejects.toThrow(/INSTALL_FAILED_VERIFICATION_FAILURE/)
    expect(hostAdbCalls.some((a) => a.includes('install'))).toBe(false)
  })

  test('absent (the default): falls back to the raw hostAdb install path unchanged — every OTHER test in this file proves this', async () => {
    const { deps, hostAdbCalls } = fakeDeps({}, { dumpsysReply: () => dumpsysOutput({ installed: false }) })
    expect(deps.installApk).toBeUndefined()
    const launcher = createUiServerLauncher(deps)
    await launcher.ensureInstalled()
    expect(hostAdbCalls.filter((a) => a.includes('install'))).toHaveLength(2)
  })
})
