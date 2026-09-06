import { describe, expect, test } from 'bun:test'
import type { DeviceRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'
import { createLogger } from '../../util/logger'
import { ADB_INSTALL_VERIFIER_SETTING, createAdbVerifierComponent, type AdbVerifierComponentDeps } from './adb-verifier-component'

function makeRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return { id: 'dev-1', stableId: 'stable-1', serial: 'serial-1', apiLevel: 34, ...overrides } as DeviceRow
}

/** A device whose `settings get global` answers from a mutable store the `put` writes into. */
function fakeDeps(opts: { initial?: string; putRefuses?: boolean; policy?: 'keep' | 'disable' } = {}): {
  deps: AdbVerifierComponentDeps
  calls: string[]
} {
  const calls: string[] = []
  let value = opts.initial ?? '1'
  return {
    calls,
    deps: {
      exec: async (_serial, cmd) => {
        calls.push(cmd)
        if (cmd.startsWith('settings put global')) {
          if (opts.putRefuses) return { stdout: '', stderr: 'java.lang.SecurityException: Permission denial', exitCode: 255 }
          value = cmd.trim().split(/\s+/).pop() ?? value
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        if (cmd.startsWith('settings get global')) return { stdout: `${value}\n`, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      policy: () => opts.policy ?? 'disable',
      log: createLogger('test'),
    },
  }
}

describe('applicability', () => {
  test('a farm that turned the setting off makes the component inert — it never touches a device', () => {
    const { deps } = fakeDeps({ policy: 'keep' })
    const component = createAdbVerifierComponent(deps)
    expect(component.applicable(makeRow())).toBe(false)
    expect(component.unsupportedReason(makeRow())).toContain('Settings → Advanced')
  })

  test('the farm default applies to every device — this is a farm policy, not a device capability', () => {
    const { deps } = fakeDeps({ policy: 'disable' })
    expect(createAdbVerifierComponent(deps).applicable(makeRow())).toBe(true)
  })

  test('the policy is re-read on every call, so flipping the setting takes effect without a restart', () => {
    let policy: 'keep' | 'disable' = 'disable'
    const { deps } = fakeDeps()
    const component = createAdbVerifierComponent({ ...deps, policy: () => policy })
    expect(component.applicable(makeRow())).toBe(true)
    policy = 'keep'
    expect(component.applicable(makeRow())).toBe(false)
  })
})

describe('run', () => {
  test('writes 0 and confirms with a readback', async () => {
    const { deps, calls } = fakeDeps({ initial: '1' })
    const result = await createAdbVerifierComponent(deps).run(makeRow())
    expect(result).toEqual({ state: 'ready', version: 'off', reason: null })
    expect(calls).toEqual([
      `settings get global ${ADB_INSTALL_VERIFIER_SETTING}`,
      `settings put global ${ADB_INSTALL_VERIFIER_SETTING} 0`,
      `settings get global ${ADB_INSTALL_VERIFIER_SETTING}`,
    ])
  })

  test('a device already set to 0 is left alone — no write at all', async () => {
    const { deps, calls } = fakeDeps({ initial: '0' })
    const result = await createAdbVerifierComponent(deps).run(makeRow())
    expect(result.state).toBe('ready')
    expect(calls.some((c) => c.startsWith('settings put'))).toBe(false)
  })

  test('an unset key is NOT treated as disabled — the platform default is 1', async () => {
    const { deps, calls } = fakeDeps({ initial: 'null' })
    const result = await createAdbVerifierComponent(deps).run(makeRow())
    expect(result.state).toBe('ready')
    expect(calls.some((c) => c.startsWith('settings put'))).toBe(true)
  })

  test('a put that exits 0 and changes nothing is caught by the readback, and quotes the device', async () => {
    const calls: string[] = []
    const deps: AdbVerifierComponentDeps = {
      exec: async (_serial, cmd) => {
        calls.push(cmd)
        // `settings put` succeeds and the value never moves.
        return cmd.startsWith('settings get global') ? { stdout: '1\n', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 }
      },
      policy: () => 'disable',
      log: createLogger('test'),
    }
    const result = await createAdbVerifierComponent(deps).run(makeRow())
    expect(result.state).toBe('failed')
    expect(result.reason).toContain('still reads "1"')
  })

  test('a refused put reports the device’s own words', async () => {
    const { deps } = fakeDeps({ initial: '1', putRefuses: true })
    const result = await createAdbVerifierComponent(deps).run(makeRow())
    expect(result.state).toBe('failed')
    expect(result.reason).toContain('SecurityException')
  })

  test('E_ADB_UNAVAILABLE is rethrown unchanged so the runner defers instead of counting a device failure', async () => {
    const deps: AdbVerifierComponentDeps = {
      exec: async () => {
        throw new EnkakuError('E_ADB_UNAVAILABLE', 'adb subsystem is not ready')
      },
      policy: () => 'disable',
      log: createLogger('test'),
    }
    await expect(createAdbVerifierComponent(deps).run(makeRow())).rejects.toThrow('adb subsystem is not ready')
  })

  test('any other error is a device-side failure, never a throw', async () => {
    const deps: AdbVerifierComponentDeps = {
      exec: async () => {
        throw new Error('device offline')
      },
      policy: () => 'disable',
      log: createLogger('test'),
    }
    expect(await createAdbVerifierComponent(deps).run(makeRow())).toEqual({ state: 'failed', version: null, reason: 'device offline' })
  })
})
