import { describe, expect, test } from 'bun:test'
import type { DeviceReadiness } from '@enkaku/protocol'
import { deriveReadinessAction } from './ReadinessControl'

/**
 * Label derivation (plan 49 §3.2, §4.2, §7): the button reads what pressing
 * it will actually do, derived from `actual` — never `desired`, which is
 * only the operator's standing intent. Pinned here as a pure function (see
 * `deriveReadinessAction`'s own doc comment for why this is not a rendered
 * component test).
 */

function readiness(desired: DeviceReadiness['desired'], actual: DeviceReadiness['actual']) {
  return { desired, actual }
}

describe('deriveReadinessAction', () => {
  test('asleep → Wake, target hot', () => {
    const r = deriveReadinessAction(readiness('asleep', 'asleep'))
    expect(r.label).toBe('Wake')
    expect(r.isAsleep).toBe(true)
    expect(r.target).toBe('hot')
    expect(r.transitioning).toBe(false)
  })

  test('awake → Sleep, target asleep', () => {
    const r = deriveReadinessAction(readiness('awake', 'awake'))
    expect(r.label).toBe('Sleep')
    expect(r.isAsleep).toBe(false)
    expect(r.target).toBe('asleep')
    expect(r.transitioning).toBe(false)
  })

  test('hot → Sleep, target asleep', () => {
    const r = deriveReadinessAction(readiness('hot', 'hot'))
    expect(r.label).toBe('Sleep')
    expect(r.target).toBe('asleep')
    expect(r.transitioning).toBe(false)
  })

  test('hold-woken (desired asleep, actual awake) → Sleep, not Wake — the reported bug this plan fixes', () => {
    const r = deriveReadinessAction(readiness('asleep', 'awake'))
    expect(r.label).toBe('Sleep')
    expect(r.isAsleep).toBe(false)
    // desired !== actual here too, but the label must still reflect actual —
    // a hold never changes `desired` (plan 45 §3.6), so this device is
    // plainly awake and its button must say so, not "Wake".
    expect(r.transitioning).toBe(true)
  })

  test('transitioning (desired hot, actual awake, mid wake-up) → pending, label still derived from actual', () => {
    const r = deriveReadinessAction(readiness('hot', 'awake'))
    expect(r.transitioning).toBe(true)
    expect(r.label).toBe('Sleep')
  })

  test('the label never claims asleep→hot has already happened: pressing Wake flips desired first, but the label waits for actual', () => {
    // The exact regression reported: press Wake, desired flips to hot
    // immediately, actual has not moved yet.
    const r = deriveReadinessAction(readiness('hot', 'asleep'))
    expect(r.label).toBe('Wake')
    expect(r.transitioning).toBe(true)
  })
})
