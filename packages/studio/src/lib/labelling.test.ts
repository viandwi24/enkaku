import { describe, expect, test } from 'bun:test'
import type { DeviceLabelsApplyResult } from '@enkaku/protocol'
import { summariseLabelApply } from './labelling'

/**
 * Plan 124 §4.6, step 124.6, acceptance criterion 12 — `summariseLabelApply`
 * is the one place a `POST /api/devices/labels/apply` report becomes ok /
 * failed / skipped counts, for BOTH toolbar actions and the device popup's
 * bulk row. It is pure, so it is tested directly rather than only through the
 * three screens that render it.
 *
 * The load-bearing case is `off`: it used to count as ok, which meant that on
 * a farm where every device is at the default mode — `off` — pressing "Apply
 * labels" on forty-five phones wrote nothing and reported forty-five
 * successes (§0.4).
 */
function result(deviceId: string, state: string | null, reason: string | null = null, error: string | null = null): DeviceLabelsApplyResult {
  return {
    deviceId,
    state:
      state === null
        ? null
        : {
            mode: 'wallpaper',
            state: state as 'applied',
            reason,
            fingerprint: null,
            appliedAt: null,
            originalCaptured: false,
            capturedLockScreen: null,
          },
    error,
  }
}

const nameOf = (id: string) => ({ label: id === 'a' ? 'moto g06' : 'pixel 8', number: id === 'a' ? 7 : null })

describe('summariseLabelApply', () => {
  test('`applied` is the only ok', () => {
    const { counts } = summariseLabelApply([result('a', 'applied'), result('b', 'applied')], 2, nameOf)
    expect(counts).toEqual({ ok: 2, failed: 0, skipped: 0, total: 2 })
  })

  test('`off` is SKIPPED with a stated reason, never ok — the "Apply labels stops lying" fix', () => {
    const { counts, skipped } = summariseLabelApply([result('a', 'off'), result('b', 'off')], 2, nameOf)
    expect(counts).toEqual({ ok: 0, failed: 0, skipped: 2, total: 2 })
    expect(skipped.map((s) => s.reason)).toEqual(['labelling is off for this device', 'labelling is off for this device'])
  })

  test('`partial` and `unavailable` skip with the service’s own reason, verbatim', () => {
    const { counts, skipped } = summariseLabelApply(
      [result('a', 'partial', 'only the home screen accepted the label'), result('b', 'unavailable', 'this device has no number assigned')],
      2,
      nameOf,
    )
    expect(counts.ok).toBe(0)
    expect(counts.skipped).toBe(2)
    expect(skipped.map((s) => s.reason)).toEqual(['only the home screen accepted the label', 'this device has no number assigned'])
  })

  test('a reason-less non-off state degrades to the state name rather than an invented sentence', () => {
    const { skipped } = summariseLabelApply([result('a', 'unknown')], 1, nameOf)
    expect(skipped[0]?.reason).toBe('unknown')
  })

  test('`state: null` is the only failure — the call threw before producing a state at all', () => {
    const { counts, failed } = summariseLabelApply([result('a', null, null, 'device_not_found')], 1, nameOf)
    expect(counts).toEqual({ ok: 0, failed: 1, skipped: 0, total: 1 })
    expect(failed[0]?.reason).toBe('device_not_found')
  })

  test('each row carries the BARE label plus the number as its own field — SkippedGroups composes them', () => {
    const { skipped } = summariseLabelApply([result('a', 'off'), result('b', 'off')], 2, nameOf)
    expect(skipped[0]).toMatchObject({ deviceId: 'a', label: 'moto g06', number: 7 })
    // A device with no number is a real state, not an error — and must never
    // render as `#null` (plan 124 criterion 7).
    expect(skipped[1]).toMatchObject({ deviceId: 'b', label: 'pixel 8', number: null })
  })
})
