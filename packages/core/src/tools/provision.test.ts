import { describe, expect, test } from 'bun:test'
import type { ToolchainManager } from '@enkaku/toolchain'
import { WsHub } from '../server/ws'
import { createLogger } from '../util/logger'
import { provisionRequiredTools } from './provision'

const log = createLogger('test.provision')

/**
 * Only `ensureRequiredTools` is exercised here; the manager is otherwise
 * irrelevant to the boot gate, so the fake implements exactly that one call
 * and records what it was asked for.
 */
function fakeManager(failFor: string[]): { manager: ToolchainManager; asked: string[] } {
  const asked: string[] = []
  const manager = {
    async ensureRequiredTools(ids: string[]): Promise<void> {
      asked.push(...ids)
      const bad = ids.find((id) => failFor.includes(id))
      if (bad) throw Object.assign(new Error(`EPERM: operation not permitted, rename ${bad}`), { code: 'E_INTERNAL' })
    },
  }
  return { manager: manager as unknown as ToolchainManager, asked }
}

describe('provisionRequiredTools (plan 02 §4.10)', () => {
  const required = ['adb', 'ui-server', 'ui-server-test', 'scrcpy-server']

  test('a device-side tool that fails to install does not fail the boot gate', async () => {
    const { manager, asked } = fakeManager(['ui-server'])
    const hub = new WsHub(log)

    // Resolving is the assertion: the caller starts the adb subsystem on it.
    await provisionRequiredTools({ manager, hub, log, required, critical: ['adb'] })

    // Every tool is still attempted — one failure must not skip the rest.
    expect(asked).toEqual(['adb', 'ui-server', 'ui-server-test', 'scrcpy-server'])
  })

  test('adb failing does fail the boot gate', async () => {
    const { manager } = fakeManager(['adb'])
    const hub = new WsHub(log)

    await expect(provisionRequiredTools({ manager, hub, log, required, critical: ['adb'] })).rejects.toThrow(/EPERM/)
  })

  test('the critical group is provisioned before the optional ones', async () => {
    const { manager, asked } = fakeManager([])
    const hub = new WsHub(log)

    await provisionRequiredTools({
      manager,
      hub,
      log,
      required: ['ui-server', 'adb', 'scrcpy-server'],
      critical: ['adb'],
    })

    expect(asked[0]).toBe('adb')
  })
})
