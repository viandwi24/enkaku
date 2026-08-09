import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { applyRotation } from './orientation'
import type { Logger } from './logger'

function silentLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    child: () => log,
  }
  return { log, warnings }
}

/** Records every command issued, and answers from a prefix→output map — same shape `wake.test.ts` uses. */
function recordingTransport(responses: Record<string, string> = {}) {
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      for (const [prefix, out] of Object.entries(responses)) {
        if (cmd.startsWith(prefix)) return { stdout: out, stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  } as unknown as Transport
  return { transport, calls }
}

describe('applyRotation — plan 85 §3.7, §4.1, step 85.8, acceptance #16', () => {
  test('"device" issues no commands, and its revert is a no-op', async () => {
    const { transport, calls } = recordingTransport()
    const { log } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'device', log })
    expect(calls).toEqual([])
    await revert()
    expect(calls).toEqual([])
  })

  test('"lock-portrait": reads both settings, then locks accelerometer_rotation and sets user_rotation to 0', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '1',
      'settings get system user_rotation': '0',
    })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(calls).toEqual([
      'settings get system accelerometer_rotation',
      'settings get system user_rotation',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 0',
    ])
  })

  test('"lock-landscape": sets user_rotation to 1', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '1',
      'settings get system user_rotation': '0',
    })
    const { log } = silentLog()
    await applyRotation(transport, { rotation: 'lock-landscape', log })
    expect(calls).toContain('settings put system user_rotation 1')
  })

  test('"lock-current": reads the live SurfaceOrientation and locks to it', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '1',
      'settings get system user_rotation': '0',
      'dumpsys input': '  SurfaceOrientation: 3\n',
    })
    const { log, warnings } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 3')
    expect(warnings).toEqual([])
  })

  test('"lock-current" on a device with no readable orientation (asleep) substitutes lock-portrait and warns', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '1',
      'settings get system user_rotation': '0',
      'dumpsys input': '',
    })
    const { log, warnings } = silentLog()
    await applyRotation(transport, { rotation: 'lock-current', log })
    expect(calls).toContain('settings put system user_rotation 0')
    expect(warnings).toEqual([
      'rotation "lock-current" requested but the device reports no current orientation (likely asleep) — locking to portrait instead',
    ])
  })

  test('revert restores BOTH accelerometer_rotation and user_rotation to exactly what was read, not the values this session applied', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '0',
      'settings get system user_rotation': '1',
    })
    const { log } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'lock-portrait', log })
    calls.length = 0
    await revert()
    expect(calls).toEqual([
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 1',
    ])
  })

  // The regression this exists to catch: a device already manually locked to
  // landscape (accelerometer_rotation=0, user_rotation=1) before the session
  // starts. §3.7's prose only mentions restoring accelerometer_rotation;
  // doing ONLY that would leave the device locked to portrait — this
  // session's lock — forever, since nothing else ever writes user_rotation
  // again. Acceptance #16 requires the device's PRIOR setting back, not just
  // its auto-rotate flag.
  test("a device already locked to landscape (user_rotation=1) before the session is back at user_rotation=1 after close, not stuck on this session's portrait lock", async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '0',
      'settings get system user_rotation': '1',
    })
    const { log } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'lock-portrait', log })
    // Sanity: THIS session did lock to portrait (0), not landscape.
    expect(calls).toContain('settings put system user_rotation 0')
    calls.length = 0
    await revert()
    expect(calls).toContain('settings put system user_rotation 1')
  })

  test('an unreadable prior accelerometer_rotation restores to auto-rotate ON (1) rather than getting stuck locked', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '',
      'settings get system user_rotation': '',
    })
    const { log } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'lock-portrait', log })
    calls.length = 0
    await revert()
    expect(calls).toEqual(['settings put system accelerometer_rotation 1'])
  })

  test('an unreadable prior user_rotation is left untouched on revert (no guessed orientation is ever written) and is logged', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '1',
      'settings get system user_rotation': '',
    })
    const { log, warnings } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(warnings).toEqual([
      'rotation: the prior user_rotation could not be read — accelerometer_rotation will be restored on close, but a fixed orientation the device was locked to before this session will not be written back',
    ])
    calls.length = 0
    await revert()
    // accelerometer_rotation IS restored (it was readable); user_rotation is not touched.
    expect(calls).toEqual(['settings put system accelerometer_rotation 1'])
  })

  test('revert is idempotent: calling it twice issues the same writes twice, and is safe', async () => {
    const { transport, calls } = recordingTransport({
      'settings get system accelerometer_rotation': '1',
      'settings get system user_rotation': '0',
    })
    const { log } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'lock-landscape', log })
    calls.length = 0
    await revert()
    await revert()
    expect(calls).toEqual([
      'settings put system accelerometer_rotation 1',
      'settings put system user_rotation 0',
      'settings put system accelerometer_rotation 1',
      'settings put system user_rotation 0',
    ])
  })

  test('a failing command is swallowed (best-effort) and apply completes', async () => {
    const calls: string[] = []
    const transport = {
      exec: async (cmd: string) => {
        calls.push(cmd)
        if (cmd.startsWith('settings get')) throw new Error('boom')
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    } as unknown as Transport
    const { log } = silentLog()
    const revert = await applyRotation(transport, { rotation: 'lock-portrait', log })
    expect(calls).toEqual([
      'settings get system accelerometer_rotation',
      'settings get system user_rotation',
      'settings put system accelerometer_rotation 0',
      'settings put system user_rotation 0',
    ])
    // Both reads failed, so revert falls back to auto-rotate ON for
    // accelerometer_rotation (still swallowed) and leaves user_rotation
    // alone entirely (no guessed value was ever captured to write back).
    calls.length = 0
    await revert()
    expect(calls).toEqual(['settings put system accelerometer_rotation 1'])
  })
})
