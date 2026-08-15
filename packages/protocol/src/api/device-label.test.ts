import { describe, expect, test } from 'bun:test'
import { DEFAULT_DEVICE_LABEL_STATE, DeviceLabelStateSchema } from './device-label'

/**
 * Plan 89 §4.3, §4.6, step 89.6. A new file rather than an addition to
 * `./devices.ts` — see that file's own doc comment for why (a concurrent
 * worker owned `./devices.ts`'s device-shape changes for step 89.2 at the
 * time this was written).
 */
describe('DeviceLabelStateSchema / DEFAULT_DEVICE_LABEL_STATE', () => {
  test('the default state is off, nothing captured, nothing applied', () => {
    expect(DEFAULT_DEVICE_LABEL_STATE).toEqual({
      mode: 'off',
      state: 'off',
      reason: null,
      fingerprint: null,
      appliedAt: null,
      originalCaptured: false,
      capturedLockScreen: null,
    })
    expect(DeviceLabelStateSchema.parse({ mode: 'off', state: 'off' })).toEqual(DEFAULT_DEVICE_LABEL_STATE)
  })

  test('state is restricted to the six named outcomes — partial/unavailable can never be confused with applied', () => {
    const states = ['off', 'applied', 'partial', 'stale', 'unavailable', 'unknown'] as const
    for (const state of states) {
      expect(DeviceLabelStateSchema.parse({ mode: 'wallpaper', state }).state).toBe(state)
    }
    expect(() => DeviceLabelStateSchema.parse({ mode: 'wallpaper', state: 'success' })).toThrow()
  })

  test('capturedLockScreen carries the exact prior text/enabled pair, or null', () => {
    const parsed = DeviceLabelStateSchema.parse({
      mode: 'lock-screen',
      state: 'applied',
      capturedLockScreen: { text: 'prior owner info', enabled: true },
    })
    expect(parsed.capturedLockScreen).toEqual({ text: 'prior owner info', enabled: true })
  })
})
