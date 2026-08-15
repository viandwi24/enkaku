import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import type { Logger } from './logger'
import { clearLockScreenLabelToDefault, readLockScreenLabel, restoreLockScreenLabel, writeLockScreenLabel } from './screen-label'

/**
 * Tier 0 physical labelling (plan 89 §3.5, §4.5's H2, §5 step 89.7).
 *
 * H2 itself is unproven on hardware (this module's own doc comment says so);
 * these tests prove the HOST-SIDE contract these functions promise their
 * caller (`packages/core/src/device/labelling.ts`) regardless of what a real
 * device turns out to do: a write always reads back what it wrote before
 * claiming success, and a restore always re-issues the exact captured values,
 * however many times it is called.
 */

function silentLog(): Logger {
  const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log }
  return log
}

/** In-memory `settings get/put secure` — mirrors `orientation.test.ts`'s `recordingTransport`, but stateful (a real device's `settings` store is). */
function fakeSecureSettings(initial: { text?: string; enabled?: boolean } = {}) {
  const store = { text: initial.text ?? '', enabled: initial.enabled ?? false }
  const calls: string[] = []
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'settings get secure lock_screen_owner_info') return { stdout: store.text === '' ? 'null' : store.text, stderr: '', exitCode: 0 }
      if (cmd === 'settings get secure lock_screen_owner_info_enabled') return { stdout: store.enabled ? '1' : '0', stderr: '', exitCode: 0 }
      const putText = /^settings put secure lock_screen_owner_info '((?:[^']|'\\''+)*)'$/.exec(cmd)
      if (putText) {
        store.text = putText[1]!.replace(/'\\''/g, "'")
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      const putEnabled = /^settings put secure lock_screen_owner_info_enabled (\d)$/.exec(cmd)
      if (putEnabled) {
        store.enabled = putEnabled[1] === '1'
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      throw new Error(`fakeSecureSettings: unexpected command ${cmd}`)
    },
  } as unknown as Transport
  return { transport, calls, store }
}

describe('readLockScreenLabel', () => {
  test('an unset key (Android’s literal "null") reads as an empty string', async () => {
    const { transport } = fakeSecureSettings()
    const label = await readLockScreenLabel(transport)
    expect(label).toEqual({ text: '', enabled: false })
  })

  test('never writes anything', async () => {
    const { transport, calls } = fakeSecureSettings({ text: 'hi', enabled: true })
    await readLockScreenLabel(transport)
    expect(calls.every((c) => c.startsWith('settings get'))).toBe(true)
  })
})

describe('writeLockScreenLabel — verified by read-back, never claims success it did not observe', () => {
  test('a normal write verifies true', async () => {
    const { transport, store } = fakeSecureSettings()
    const { verified } = await writeLockScreenLabel(transport, '#7 Pixel 5')
    expect(verified).toBe(true)
    expect(store).toEqual({ text: '#7 Pixel 5', enabled: true })
  })

  test('a device that silently ignores the write reports verified: false', async () => {
    const { transport } = fakeSecureSettings()
    // Sabotage: writes are accepted but never actually change the store.
    const broken: Transport = {
      ...transport,
      exec: async (cmd: string) => (cmd.startsWith('settings put') ? { stdout: '', stderr: '', exitCode: 0 } : { stdout: 'null', stderr: '', exitCode: 0 }),
    }
    const { verified } = await writeLockScreenLabel(broken, '#7 Pixel 5')
    expect(verified).toBe(false)
  })

  test('a name containing a single quote is written and read back correctly (shellQuote round-trip)', async () => {
    const { transport, store } = fakeSecureSettings()
    const text = "#3 O'Brien's phone"
    const { verified } = await writeLockScreenLabel(transport, text)
    expect(verified).toBe(true)
    expect(store.text).toBe(text)
  })
})

describe('restoreLockScreenLabel — idempotent (F18’s rule)', () => {
  test('re-issues the exact captured values on every call, and consults no "already restored" flag', async () => {
    const { transport, store } = fakeSecureSettings({ text: 'currently something else', enabled: true })
    const captured = { text: 'the original owner text', enabled: false }
    await restoreLockScreenLabel(transport, captured, silentLog())
    expect(store).toEqual(captured)

    // Mutate the live state again, then restore a second time — the SAME captured values must land again.
    store.text = 'drifted again'
    store.enabled = true
    await restoreLockScreenLabel(transport, captured, silentLog())
    expect(store).toEqual(captured)
  })

  test('a write failure while restoring is tolerated (logged, not thrown) — mirrors orientation.ts’s own revert', async () => {
    const failing: Transport = {
      id: 't',
      serial: 's',
      stableId: 'stable',
      connect: async () => {},
      disconnect: async () => {},
      exec: async () => {
        throw new Error('adb link down')
      },
      execOut: async () => new Uint8Array(),
    }
    await expect(restoreLockScreenLabel(failing, { text: 'x', enabled: true }, silentLog())).resolves.toBeUndefined()
  })
})

describe('clearLockScreenLabelToDefault — the fallback when nothing was ever captured', () => {
  test('disables owner-info and clears the text — Android’s own default state', async () => {
    const { transport, store } = fakeSecureSettings({ text: 'something', enabled: true })
    await clearLockScreenLabelToDefault(transport, silentLog())
    expect(store).toEqual({ text: '', enabled: false })
  })

  test('idempotent — a second call is a no-op on an already-default store', async () => {
    const { transport, store } = fakeSecureSettings()
    await clearLockScreenLabelToDefault(transport, silentLog())
    await clearLockScreenLabelToDefault(transport, silentLog())
    expect(store).toEqual({ text: '', enabled: false })
  })
})
