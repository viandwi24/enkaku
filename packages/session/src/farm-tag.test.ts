import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { FARM_TAG_PROPERTY, applyFarmTag } from './farm-tag'
import type { Logger } from './logger'

function silentLog(): { log: Logger; warnings: string[]; debugs: string[] } {
  const warnings: string[] = []
  const debugs: string[] = []
  const log: Logger = {
    debug: (msg) => debugs.push(msg),
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    child: () => log,
  }
  return { log, warnings, debugs }
}

/** Records every command issued — same shape `orientation.test.ts` uses. */
function recordingTransport(): { transport: Transport; calls: string[] } {
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
  return { transport, calls }
}

/** Every `exec` call rejects — simulates a `setprop` denied by SELinux (an unrooted OEM ROM, e.g.) or a dead adb link. */
function failingTransport(): { transport: Transport; calls: string[] } {
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      throw new Error('Permission denied')
    },
  } as unknown as Transport
  return { transport, calls }
}

describe('applyFarmTag — device-scoped farm marker (spec §9.4/§17, plan 87 §4.12, §5 step 87.13)', () => {
  test('tagTraffic: true sets the marker property to 1', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    await applyFarmTag(transport, { tagTraffic: true, log })
    expect(calls).toEqual([`setprop ${FARM_TAG_PROPERTY} 1`])
  })

  test('tagTraffic: false issues no commands at all, and its revert is a no-op', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const revert = await applyFarmTag(transport, { tagTraffic: false, log })
    expect(calls).toEqual([])
    await revert()
    expect(calls).toEqual([])
  })

  test('revert clears the property back to empty, not to some captured prior value — there is no legitimate prior value for a property Enkaku invented', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const revert = await applyFarmTag(transport, { tagTraffic: true, log })
    calls.length = 0
    await revert()
    expect(calls).toEqual([`setprop ${FARM_TAG_PROPERTY} ''`])
  })

  test('revert is idempotent: calling it twice issues the identical clear twice, safely', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const revert = await applyFarmTag(transport, { tagTraffic: true, log })
    calls.length = 0
    await revert()
    await revert()
    expect(calls).toEqual([`setprop ${FARM_TAG_PROPERTY} ''`, `setprop ${FARM_TAG_PROPERTY} ''`])
  })

  test('a setprop failure while applying is logged at warn (an operator-visible level), never throws, and the device is recorded as unmarked (the revert it hands back does nothing)', async () => {
    const { transport, calls } = failingTransport()
    const { log, warnings } = silentLog()
    const revert = await applyFarmTag(transport, { tagTraffic: true, log })
    expect(calls).toEqual([`setprop ${FARM_TAG_PROPERTY} 1`])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('UNMARKED')
    expect(warnings[0]).toContain(FARM_TAG_PROPERTY)

    // A session must not break because the marker could not be set — and
    // since nothing was ever written, revert has nothing to undo.
    calls.length = 0
    await revert()
    expect(calls).toEqual([])
  })

  test("a setprop failure on REVERT is tolerated (logged at debug, like this file's siblings orientation.ts/wake.ts) and does not throw — the apply itself succeeded, only the device going unreachable before close fails the clear", async () => {
    const calls: string[] = []
    let applyCallDone = false
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (!applyCallDone) {
          applyCallDone = true
          return { stdout: '', stderr: '', exitCode: 0 } // the initial "set to 1" succeeds
        }
        throw new Error('device offline') // the later "clear" fails
      },
    } as unknown as Transport
    const { log, debugs } = silentLog()

    const revert = await applyFarmTag(transport, { tagTraffic: true, log })
    expect(calls).toEqual([`setprop ${FARM_TAG_PROPERTY} 1`])

    await expect(revert()).resolves.toBeUndefined()
    expect(calls).toEqual([`setprop ${FARM_TAG_PROPERTY} 1`, `setprop ${FARM_TAG_PROPERTY} ''`])
    expect(debugs.some((m) => m.includes('farm tag clear failed'))).toBe(true)
  })
})
