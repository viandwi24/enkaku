import { describe, expect, test } from 'bun:test'
import {
  createGuestAgentLauncher,
  GUEST_AGENT_PACKAGE,
  GUEST_AGENT_SOCKET,
  type GuestAgentArtifactMismatch,
  type GuestAgentLauncherDeps,
} from './launcher'

/** A shell result, defaulting to the success shape (plan 53). */
function sh(stdout = '', exitCode: number | null = 0, stderr = ''): { stdout: string; stderr: string; exitCode: number | null } {
  return { stdout, stderr, exitCode }
}

/** A realistic `dumpsys package <pkg>` excerpt, shaped like `verify.test.ts`'s fixture — mirrors `ui-server/launcher.test.ts`'s own helper (plan 90 §3.8, F8). */
function dumpsysOutput(opts: { installed?: boolean; versionCode?: number } = {}): string {
  if (opts.installed === false) return 'Unable to find package: dev.enkaku.guestagent\n'
  const versionCode = opts.versionCode ?? 5
  return ['Packages:', `  Package [${GUEST_AGENT_PACKAGE}] (39a4179):`, `    versionCode=${versionCode} minSdk=29 targetSdk=34`, '    versionName=1.0.0', ''].join(
    '\n',
  )
}

/**
 * A fake `exec`/`hostAdb`/`adb` good enough to drive the happy path: the
 * package is already installed and matches (`dumpsysReply`'s default), `cmd
 * package path` (still used by `isInstalled()`, unchanged by plan 90)
 * reports installed, `appops get` echoes back `allow`, and `adb.listForward`
 * reports the port as owned by the launcher's own serial — matching real
 * device behaviour once `adb.forward` has run (plan 119 §4.1, §4.2: the
 * direct-socket trio replacing `hostAdb`'s `forward`/`forward --list`/
 * `forward --remove` CLI spawns).
 */
function fakeDeps(
  overrides: Partial<GuestAgentLauncherDeps> = {},
  opts: { dumpsysReply?: (cmd: string) => string } = {},
): {
  deps: GuestAgentLauncherDeps
  execCalls: string[]
  hostAdbCalls: Array<{ args: string[]; opts?: { lane?: 'default' | 'install'; serial?: string } }>
  adbForwardCalls: Array<{ serial: string; local: string; remote: string }>
  adbKillForwardCalls: Array<{ serial: string; local: string }>
  logs: Array<{ level: string; msg: string }>
  mismatches: GuestAgentArtifactMismatch[]
} {
  const execCalls: string[] = []
  const hostAdbCalls: Array<{ args: string[]; opts?: { lane?: 'default' | 'install'; serial?: string } }> = []
  const adbForwardCalls: Array<{ serial: string; local: string; remote: string }> = []
  const adbKillForwardCalls: Array<{ serial: string; local: string }> = []
  const logs: Array<{ level: string; msg: string }> = []
  const mismatches: GuestAgentArtifactMismatch[] = []
  const serial = 'serial-1'

  const deps: GuestAgentLauncherDeps = {
    serial,
    exec: async (cmd) => {
      execCalls.push(cmd)
      if (cmd.startsWith('cmd package path')) {
        return { stdout: `package:/data/app/~~x/${GUEST_AGENT_PACKAGE}/base.apk`, stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('dumpsys package')) return { stdout: opts.dumpsysReply?.(cmd) ?? dumpsysOutput(), stderr: '', exitCode: 0 }
      if (cmd.startsWith('appops get')) return { stdout: 'ACTIVATE_VPN: allow', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    hostAdb: async (args, hostAdbOpts) => {
      hostAdbCalls.push({ args, opts: hostAdbOpts })
      return ''
    },
    adb: {
      forward: async (s, local, remote) => {
        adbForwardCalls.push({ serial: s, local, remote })
      },
      listForward: async () => [{ serial, local: 'tcp:9200', remote: `localabstract:${GUEST_AGENT_SOCKET}` }],
      killForward: async (s, local) => {
        adbKillForwardCalls.push({ serial: s, local })
      },
    },
    apkPath: async () => '/tools/guest-agent.apk',
    onLog: (level, msg) => logs.push({ level, msg }),
    onMismatch: (info) => mismatches.push(info),
    ...overrides,
  }
  return { deps, execCalls, hostAdbCalls, adbForwardCalls, adbKillForwardCalls, logs, mismatches }
}

/** Flattened arg lists — most assertions below only care about `args`, not the lane opts. */
function argLists(calls: Array<{ args: string[] }>): string[][] {
  return calls.map((c) => c.args)
}

describe('createGuestAgentLauncher (plan 44 §4.4, §5.5)', () => {
  describe('isInstalled', () => {
    test('true when `cmd package path` prints the package: prefix', async () => {
      const { deps } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.isInstalled()).resolves.toBe(true)
    })

    test('false when `cmd package path` prints nothing (not installed, non-zero exit on the device)', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          // A real device prints nothing and exits 1 when the package is absent.
          if (cmd.startsWith('cmd package path')) return sh('', 1)
          return sh()
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.isInstalled()).resolves.toBe(false)
    })

    test('a zero exit with output in some other shape is NOT treated as installed', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          // Exit 0, but nothing resembling the documented `package:` line.
          if (cmd.startsWith('cmd package path')) return sh('something unexpected', 0)
          return sh()
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.isInstalled()).resolves.toBe(false)
    })

    test('falls back to the prefix alone when the device cannot report an exit code (plan 53 §3.4)', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          // `null` is what a shell too old for `shell,v2,raw` yields — "unknown",
          // which must not be read as "not installed".
          if (cmd.startsWith('cmd package path')) {
            return sh(`package:/data/app/~~x/${GUEST_AGENT_PACKAGE}/base.apk`, null)
          }
          return sh('', null)
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.isInstalled()).resolves.toBe(true)
    })

    test('uses `cmd package path`, never the substring-matching `pm list packages`', async () => {
      const { deps, execCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await launcher.isInstalled()
      expect(execCalls).toHaveLength(1)
      expect(execCalls[0]).toContain('cmd package path')
      expect(execCalls[0]).toContain(GUEST_AGENT_PACKAGE)
      expect(execCalls[0]).not.toContain('pm list packages')
    })
  })

  describe('ensureInstalled() — on-device artifact verification (plan 90 §3.8, fixes F7, mirrors ui-server/launcher.ts, F8)', () => {
    test('already matching: verifies via dumpsys, installs nothing, reports the observed versionCode', async () => {
      const { deps, hostAdbCalls } = fakeDeps({ expectedArtifact: { versionCode: 5 } }, { dumpsysReply: () => dumpsysOutput({ versionCode: 5 }) })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensureInstalled()).resolves.toEqual({ versionCode: 5 })
      expect(argLists(hostAdbCalls).some((a) => a.includes('install'))).toBe(false)
      expect(argLists(hostAdbCalls).some((a) => a.includes('uninstall'))).toBe(false)
    })

    test('not installed at all → installed once via the install lane, no uninstall, no mismatch report', async () => {
      const { deps, hostAdbCalls, mismatches } = fakeDeps(
        { expectedArtifact: { versionCode: 5 } },
        { dumpsysReply: () => dumpsysOutput({ installed: false }) },
      )
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensureInstalled()).resolves.toEqual({ versionCode: 5 })
      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(0)
      const installCall = hostAdbCalls.find((c) => c.args.includes('install'))
      expect(installCall?.args).toEqual(['-s', 'serial-1', 'install', '-r', '-g', '/tools/guest-agent.apk'])
      // F12: installs ride the bounded install lane, serialised per device — the same rule
      // `ui-server/launcher.ts` already follows.
      expect(installCall?.opts).toEqual({ lane: 'install', serial: 'serial-1' })
      expect(mismatches).toHaveLength(0)
    })

    test('a versionCode mismatch is detected, reinstalled exactly once, and reverified', async () => {
      let dumpsysCalls = 0
      const { deps, hostAdbCalls, mismatches } = fakeDeps(
        { expectedArtifact: { versionCode: 5 } },
        {
          dumpsysReply: () => {
            dumpsysCalls++
            // First read: the stale version installed elsewhere. After the reinstall
            // (second read onward): the expected version.
            return dumpsysCalls === 1 ? dumpsysOutput({ versionCode: 3 }) : dumpsysOutput({ versionCode: 5 })
          },
        },
      )
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensureInstalled()).resolves.toEqual({ versionCode: 5 })

      expect(dumpsysCalls).toBe(2) // verify → mismatch → reinstall → re-verify, no more
      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(1)
      expect(argLists(hostAdbCalls).filter((a) => a.includes('install'))).toHaveLength(1)
      expect(mismatches).toHaveLength(0) // repaired — never reaches onMismatch
    })

    test('a repair that fails a second time reports the mismatch once, throws, and does not loop', async () => {
      // Always reports the stale version, even after the reinstall — the scenario
      // where something keeps reinstalling a conflicting package.
      const { deps, hostAdbCalls, mismatches } = fakeDeps(
        { expectedArtifact: { versionCode: 5 } },
        { dumpsysReply: () => dumpsysOutput({ versionCode: 3 }) },
      )
      const launcher = createGuestAgentLauncher(deps)

      await expect(launcher.ensureInstalled()).rejects.toThrow(/version_mismatch/)

      // Exactly ONE uninstall/reinstall cycle — not a retry loop (plan 41 §3.3, reused as-is).
      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(1)
      expect(argLists(hostAdbCalls).filter((a) => a.includes('install'))).toHaveLength(1)
      expect(mismatches).toEqual([{ reason: 'version_mismatch', observed: { versionCode: 3 } }])
    })

    test('a signature mismatch is detected and reinstalled the same way as a versionCode mismatch', async () => {
      const expectedSig = 'AA'.repeat(32)
      const wrongSigOutput = `${dumpsysOutput({ versionCode: 5 })}    signatures=PackageSignatures{x [1]}\n    cert=${'BB'.repeat(32)}\n`
      const okOutput = `${dumpsysOutput({ versionCode: 5 })}    signatures=PackageSignatures{x [1]}\n    cert=${expectedSig}\n`
      let dumpsysCalls = 0
      const { deps, hostAdbCalls, mismatches } = fakeDeps(
        { expectedArtifact: { versionCode: 5, signatureSha256: expectedSig } },
        { dumpsysReply: () => (++dumpsysCalls === 1 ? wrongSigOutput : okOutput) },
      )
      const launcher = createGuestAgentLauncher(deps)
      await launcher.ensureInstalled()

      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(1)
      expect(mismatches).toHaveLength(0)
    })

    test('a manifest with no recorded expectation never blocks provisioning, and logs a notice (F6)', async () => {
      const { deps, hostAdbCalls, logs } = fakeDeps({}, { dumpsysReply: () => dumpsysOutput({ versionCode: 999 }) })
      const launcher = createGuestAgentLauncher(deps)
      await launcher.ensureInstalled()

      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(0)
      expect(logs.some((l) => l.level === 'info' && l.msg.includes('installed presence only'))).toBe(true)
    })

    test('an unreadable verification result is skipped, not treated as a mismatch', async () => {
      const { deps, hostAdbCalls, logs } = fakeDeps(
        { expectedArtifact: { versionCode: 5 } },
        // Installed, but no versionCode line at all — unparseable.
        { dumpsysReply: () => `Packages:\n  Package [${GUEST_AGENT_PACKAGE}] (39a4179):\n` },
      )
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensureInstalled()).resolves.toEqual({ versionCode: null })

      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(0)
      expect(logs.some((l) => l.level === 'warn' && l.msg.includes('skipping artifact verification'))).toBe(true)
    })

    test('opts.force skips the fast path and goes straight to uninstall/reinstall/reverify once (R1)', async () => {
      // Reports as already matching throughout — force must still trigger the full repair cycle
      // rather than short-circuiting on the "already ok" fast path.
      const { deps, hostAdbCalls, execCalls } = fakeDeps({ expectedArtifact: { versionCode: 5 } }, { dumpsysReply: () => dumpsysOutput({ versionCode: 5 }) })
      const launcher = createGuestAgentLauncher(deps)
      execCalls.length = 0
      await expect(launcher.ensureInstalled({ force: true })).resolves.toEqual({ versionCode: 5 })

      expect(argLists(hostAdbCalls).filter((a) => a.includes('uninstall'))).toHaveLength(1)
      expect(argLists(hostAdbCalls).filter((a) => a.includes('install'))).toHaveLength(1)
      // Two dumpsys reads: the re-verify after the forced reinstall. No FIRST verify pass — the
      // fast path never ran.
      expect(execCalls.filter((c) => c.startsWith('dumpsys package'))).toHaveLength(1)
    })

    test('opts.force still throws and reports the mismatch when the forced repair does not fix it', async () => {
      const { deps, mismatches } = fakeDeps({ expectedArtifact: { versionCode: 5 } }, { dumpsysReply: () => dumpsysOutput({ versionCode: 3 }) })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensureInstalled({ force: true })).rejects.toThrow(/version_mismatch/)
      expect(mismatches).toEqual([{ reason: 'version_mismatch', observed: { versionCode: 3 } }])
    })

    test('isInstalled() is unchanged by this rewrite — still a presence-only `cmd package path` check', async () => {
      // Deliberately mismatched by dumpsys standards, but isInstalled() never calls verifyDeviceArtifact.
      const { deps } = fakeDeps({ expectedArtifact: { versionCode: 999 } }, { dumpsysReply: () => dumpsysOutput({ versionCode: 5 }) })
      await expect(createGuestAgentLauncher(deps).isInstalled()).resolves.toBe(true)
    })
  })

  describe('ensurePreGranted', () => {
    test('sets and reads back ACTIVATE_VPN allow, reporting granted', async () => {
      const { deps, execCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensurePreGranted()).resolves.toEqual({ state: 'granted', reason: null })
      expect(execCalls.some((c) => c.startsWith('appops set') && c.includes('ACTIVATE_VPN allow'))).toBe(true)
      expect(execCalls.some((c) => c.startsWith('appops get') && c.includes('ACTIVATE_VPN'))).toBe(true)
    })

    test('reports pending — never throws — when the read-back does not say allow', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('appops get')) return sh('ACTIVATE_VPN: ignore')
          return sh()
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      const consent = await launcher.ensurePreGranted()
      expect(consent.state).toBe('pending')
      // The reason is the product: it has to name the op, say the agent still
      // works, and name the dialog that clears it.
      expect(consent.reason).toContain('ACTIVATE_VPN')
      expect(consent.reason).toContain('Connection request')
    })

    test('reports pending when the read-back is empty (op unset or unsupported)', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('appops get')) return sh('')
          return sh()
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensurePreGranted()).resolves.toMatchObject({ state: 'pending' })
    })

    test("names the platform's own refusal when `appops set` itself is denied (ColorOS: no MANAGE_APP_OPS_MODES for the shell user)", async () => {
      const denial = 'java.lang.SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES.'
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('appops set')) return { stdout: '', stderr: `\nException occurred while executing 'set':\n${denial}`, exitCode: 255 }
          if (cmd.startsWith('appops get')) return sh('No operations.\nDefault mode: ignore')
          return sh()
        },
      })
      const consent = await createGuestAgentLauncher(deps).ensurePreGranted()
      expect(consent.state).toBe('pending')
      expect(consent.reason).toContain('MANAGE_APP_OPS_MODES')
    })

    test('still throws when the package has no UID — that is a failed install, not a consent problem', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('appops get')) return { stdout: '', stderr: 'No UID for dev.enkaku.guestagent in user 0', exitCode: 1 }
          return sh()
        },
      })
      await expect(createGuestAgentLauncher(deps).ensurePreGranted()).rejects.toThrow(/not registered with package manager/)
    })

    test('vpnConsent() reads back without attempting a set of its own', async () => {
      const { deps, execCalls } = fakeDeps()
      await expect(createGuestAgentLauncher(deps).vpnConsent()).resolves.toEqual({ state: 'granted', reason: null })
      expect(execCalls.some((c) => c.startsWith('appops set'))).toBe(false)
    })
  })

  describe('ensureAccessibilityEnabled (plan 221 §4.10)', () => {
    const UI_TREE = `${GUEST_AGENT_PACKAGE}/${GUEST_AGENT_PACKAGE}.ui.UiTreeService`

    test('runs the appops call before the settings write', async () => {
      const calls: string[] = []
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          calls.push(cmd)
          if (cmd.startsWith('settings get secure enabled_accessibility_services')) return sh(UI_TREE)
          if (cmd.startsWith('settings get secure accessibility_enabled')) return sh('1')
          return sh()
        },
      })
      await createGuestAgentLauncher(deps).ensureAccessibilityEnabled()
      const appopsIndex = calls.findIndex((c) => c.startsWith('cmd appops set'))
      const settingsWriteIndex = calls.findIndex((c) => c.startsWith('settings put secure accessibility_enabled'))
      expect(appopsIndex).toBeGreaterThanOrEqual(0)
      expect(appopsIndex).toBeLessThan(settingsWriteIndex)
    })

    test('it appends to an existing list and never overwrites another service', async () => {
      const otherService = 'com.other.app/.SomeService'
      const puts: string[] = []
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('settings put secure enabled_accessibility_services')) puts.push(cmd)
          if (cmd.startsWith('settings get secure enabled_accessibility_services')) {
            return puts.length > 0 ? sh(`${otherService}:${UI_TREE}`) : sh(otherService)
          }
          if (cmd.startsWith('settings get secure accessibility_enabled')) return sh('1')
          return sh()
        },
      })
      const result = await createGuestAgentLauncher(deps).ensureAccessibilityEnabled()
      expect(puts).toHaveLength(1)
      expect(puts[0]).toContain(otherService)
      expect(puts[0]).toContain(UI_TREE)
      expect(result.state).toBe('enabled')
    })

    test('it skips the write when the component is already present but still sets accessibility_enabled', async () => {
      const listPuts: string[] = []
      const enabledPuts: string[] = []
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('settings put secure enabled_accessibility_services')) listPuts.push(cmd)
          if (cmd.startsWith('settings put secure accessibility_enabled')) enabledPuts.push(cmd)
          if (cmd.startsWith('settings get secure enabled_accessibility_services')) return sh(UI_TREE)
          if (cmd.startsWith('settings get secure accessibility_enabled')) return sh('1')
          return sh()
        },
      })
      const result = await createGuestAgentLauncher(deps).ensureAccessibilityEnabled()
      expect(listPuts).toHaveLength(0)
      expect(enabledPuts).toHaveLength(1)
      expect(result.state).toBe('enabled')
    })

    test('a refused write produces state pending with the platform own line', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          // Every read-back stays empty — the write never actually stuck, as R4's OEM caveat says can happen.
          if (cmd.startsWith('settings get secure enabled_accessibility_services')) return sh('')
          if (cmd.startsWith('settings get secure accessibility_enabled')) return sh('0')
          return sh()
        },
      })
      const result = await createGuestAgentLauncher(deps).ensureAccessibilityEnabled()
      expect(result.state).toBe('pending')
      expect(result.reason).toContain('Open accessibility settings')
    })

    test('a read-back of 1 plus the component produces state enabled', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('settings get secure enabled_accessibility_services')) return sh(UI_TREE)
          if (cmd.startsWith('settings get secure accessibility_enabled')) return sh('1')
          return sh()
        },
      })
      await expect(createGuestAgentLauncher(deps).ensureAccessibilityEnabled()).resolves.toEqual({
        state: 'enabled',
        reason: null,
      })
    })
  })

  describe('bootstrap', () => {
    test('starts the BootstrapActivity with the token, clearing the stopped state', async () => {
      const { deps, execCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await launcher.bootstrap('test-token')
      const cmd = execCalls.find((c) => c.startsWith('am start'))
      expect(cmd).toBeDefined()
      expect(cmd).toContain(`${GUEST_AGENT_PACKAGE}/.BootstrapActivity`)
      expect(cmd).toContain('--es token')
      expect(cmd).toContain('test-token')
    })

    test('throws when `am start` fails, even though its stdout still reads like success', async () => {
      // Measured on a moto g06 (Android 15): a failing `am start` exits 1 with
      // the reason on stderr while stdout still says `Starting: Intent {...}`.
      // Before the streams were separated, this looked exactly like a success
      // and was logged at debug — the agent stayed dead and nothing said so.
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('am start')) {
            return sh(
              'Starting: Intent { cmp=dev.enkaku.guestagent/.BootstrapActivity }',
              1,
              'Error type 3\nError: Activity class {dev.enkaku.guestagent/.BootstrapActivity} does not exist.',
            )
          }
          return sh()
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.bootstrap('test-token')).rejects.toThrow(/does not exist/)
      await expect(launcher.bootstrap('test-token')).rejects.toThrow(/exit 1/)
    })

    test('a device that cannot report an exit code does not fail the bootstrap', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => (cmd.startsWith('am start') ? sh('Starting: Intent { ... }', null) : sh()),
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.bootstrap('test-token')).resolves.toBeUndefined()
    })
  })

  describe('forward (plan 119 §4.1, §4.2 — the direct-socket trio, off the `adb.exe` spawn path)', () => {
    test('forwards tcp:<port> to the localabstract socket via AdbClient.forward, not hostAdb', async () => {
      const { deps, adbForwardCalls, hostAdbCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await launcher.forward(9200)
      expect(adbForwardCalls).toContainEqual({ serial: 'serial-1', local: 'tcp:9200', remote: `localabstract:${GUEST_AGENT_SOCKET}` })
      // No `adb.exe` spawn at all for the forward/list/remove trio (acceptance criterion 3).
      expect(hostAdbCalls).toHaveLength(0)
    })

    test('throws when `listForward` names a different serial as owner (ownership check)', async () => {
      const { deps } = fakeDeps({
        adb: {
          forward: async () => undefined,
          listForward: async () => [{ serial: 'some-other-serial', local: 'tcp:9200', remote: `localabstract:${GUEST_AGENT_SOCKET}` }],
          killForward: async () => undefined,
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.forward(9200)).rejects.toThrow(/refusing to drive another device/)
    })

    test('throws when the port is not present in `listForward` at all', async () => {
      const { deps } = fakeDeps({
        adb: {
          forward: async () => undefined,
          listForward: async () => [],
          killForward: async () => undefined,
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.forward(9200)).rejects.toThrow(/bound to nothing/)
    })
  })

  describe('removeForward', () => {
    test('tolerates the forward already being gone', async () => {
      const { deps } = fakeDeps({
        adb: {
          forward: async () => undefined,
          listForward: async () => [],
          killForward: async () => {
            throw new Error('adb: forward: not found')
          },
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.removeForward(9200)).resolves.toBeUndefined()
    })
  })

  describe('stop', () => {
    test('force-stops the package', async () => {
      const { deps, execCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await launcher.stop()
      // The package name is shell-quoted (packages/adb/src/shell-quote.ts),
      // so this checks for the command shape rather than an exact string.
      expect(execCalls.some((c) => c.startsWith('am force-stop') && c.includes(GUEST_AGENT_PACKAGE))).toBe(true)
    })

    test('tolerates exec rejecting (transport failure)', async () => {
      const { deps } = fakeDeps({
        exec: async () => {
          throw new Error('adb: device offline')
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.stop()).resolves.toBeUndefined()
    })
  })
})
