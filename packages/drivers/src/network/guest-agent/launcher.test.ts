import { describe, expect, test } from 'bun:test'
import {
  createGuestAgentLauncher,
  GUEST_AGENT_PACKAGE,
  GUEST_AGENT_SOCKET,
  type GuestAgentLauncherDeps,
} from './launcher'

/**
 * A fake `exec`/`hostAdb` good enough to drive the happy path: the package
 * is already installed, `appops get` echoes back `allow`, and
 * `forward --list` reports the port as owned by the launcher's own serial —
 * matching real device behaviour once `adb forward` has run.
 */
function fakeDeps(overrides: Partial<GuestAgentLauncherDeps> = {}): {
  deps: GuestAgentLauncherDeps
  execCalls: string[]
  hostAdbCalls: string[][]
  logs: Array<{ level: string; msg: string }>
} {
  const execCalls: string[] = []
  const hostAdbCalls: string[][] = []
  const logs: Array<{ level: string; msg: string }> = []
  const serial = 'serial-1'

  const deps: GuestAgentLauncherDeps = {
    serial,
    exec: async (cmd) => {
      execCalls.push(cmd)
      if (cmd.startsWith('cmd package path')) return `package:/data/app/~~x/${GUEST_AGENT_PACKAGE}/base.apk`
      if (cmd.startsWith('appops get')) return 'ACTIVATE_VPN: allow'
      return ''
    },
    hostAdb: async (args) => {
      hostAdbCalls.push(args)
      if (args[0] === 'forward' && args[1] === '--list') {
        return `${serial} tcp:9200 localabstract:${GUEST_AGENT_SOCKET}\n`
      }
      return ''
    },
    apkPath: async () => '/tools/guest-agent.apk',
    onLog: (level, msg) => logs.push({ level, msg }),
    ...overrides,
  }
  return { deps, execCalls, hostAdbCalls, logs }
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
          if (cmd.startsWith('cmd package path')) return ''
          return ''
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.isInstalled()).resolves.toBe(false)
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

  describe('ensureInstalled', () => {
    test('is idempotent: does not reinstall when already installed', async () => {
      const { deps, hostAdbCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await launcher.ensureInstalled()
      expect(hostAdbCalls.some((c) => c.includes('install'))).toBe(false)
    })

    test('installs with -r -g when not installed', async () => {
      const { deps, hostAdbCalls } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('cmd package path')) return ''
          return ''
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await launcher.ensureInstalled()
      const installCall = hostAdbCalls.find((c) => c.includes('install'))
      expect(installCall).toEqual(['-s', 'serial-1', 'install', '-r', '-g', '/tools/guest-agent.apk'])
    })
  })

  describe('ensurePreGranted', () => {
    test('sets and reads back ACTIVATE_VPN allow without throwing', async () => {
      const { deps, execCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensurePreGranted()).resolves.toBeUndefined()
      expect(execCalls.some((c) => c.startsWith('appops set') && c.includes('ACTIVATE_VPN allow'))).toBe(true)
      expect(execCalls.some((c) => c.startsWith('appops get') && c.includes('ACTIVATE_VPN'))).toBe(true)
    })

    test('throws naming the app op when the read-back does not say allow', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('appops get')) return 'ACTIVATE_VPN: ignore'
          return ''
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensurePreGranted()).rejects.toThrow(/ACTIVATE_VPN/)
      await expect(launcher.ensurePreGranted()).rejects.toThrow(/did not take/)
    })

    test('throws when the read-back is empty (op unset or unsupported)', async () => {
      const { deps } = fakeDeps({
        exec: async (cmd) => {
          if (cmd.startsWith('appops get')) return ''
          return ''
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.ensurePreGranted()).rejects.toThrow()
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
  })

  describe('forward', () => {
    test('forwards tcp:<port> to the localabstract socket', async () => {
      const { deps, hostAdbCalls } = fakeDeps()
      const launcher = createGuestAgentLauncher(deps)
      await launcher.forward(9200)
      expect(hostAdbCalls).toContainEqual([
        '-s',
        'serial-1',
        'forward',
        'tcp:9200',
        `localabstract:${GUEST_AGENT_SOCKET}`,
      ])
    })

    test('throws when `forward --list` names a different serial as owner (ownership check)', async () => {
      const { deps } = fakeDeps({
        hostAdb: async (args) => {
          if (args[0] === 'forward' && args[1] === '--list') {
            return `some-other-serial tcp:9200 localabstract:${GUEST_AGENT_SOCKET}\n`
          }
          return ''
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.forward(9200)).rejects.toThrow(/refusing to drive another device/)
    })

    test('throws when the port is not present in `forward --list` at all', async () => {
      const { deps } = fakeDeps({
        hostAdb: async (args) => {
          if (args[0] === 'forward' && args[1] === '--list') return ''
          return ''
        },
      })
      const launcher = createGuestAgentLauncher(deps)
      await expect(launcher.forward(9200)).rejects.toThrow(/bound to nothing/)
    })
  })

  describe('removeForward', () => {
    test('tolerates the forward already being gone', async () => {
      const { deps } = fakeDeps({
        hostAdb: async (args) => {
          if (args.includes('--remove')) throw new Error('adb: forward: not found')
          return ''
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
