import { describe, expect, test } from 'bun:test'
import { defineService, isService } from './runtime'

/**
 * `defineService`'s **Reset data** contract, checked where it is meant to be
 * checked: on the author's machine, at import time, so a mistake is a stack
 * trace in the editor rather than a plugin that behaves surprisingly on a farm.
 *
 * The property that matters is that the DECLARATION and the HANDLER cannot come
 * apart. `resetData` non-null is what tells the farm a cleanup hook exists —
 * it is read off the persisted manifest, before any bundle is imported — so a
 * plugin whose two halves disagree would either have its cleanup silently
 * skipped (data deleted, phones still routed) or have an operator consent to a
 * borrowed capability nothing can spend.
 */

describe('defineService({ onResetData })', () => {
  test('a handler with no block declares an empty one, so the manifest still says a cleanup exists', () => {
    const s = defineService({ setup: () => {}, onResetData: () => {} })
    expect(s.resetData).toEqual({ permissions: [] })
    expect(typeof s.onResetData).toBe('function')
    expect(isService(s)).toBe(true)
  })

  test('a block and a handler are kept exactly as written', () => {
    const s = defineService({
      setup: () => {},
      resetData: { permissions: ['device.network.clear'], description: 'turns routes off' },
      onResetData: () => ({ items: [] }),
    })
    expect(s.resetData).toEqual({ permissions: ['device.network.clear'], description: 'turns routes off' })
  })

  test('a block with NO handler is refused — a borrowed capability nothing can spend is consent taken for nothing', () => {
    expect(() => defineService({ setup: () => {}, resetData: { permissions: ['device.network.clear'] } })).toThrow(/no `onResetData` handler/)
  })

  test('a plugin with neither declares `resetData: null`, which is "nothing to undo" and not an error', () => {
    expect(defineService({ setup: () => {} }).resetData).toBeNull()
    expect(defineService({ setup: () => {} }).onResetData).toBeUndefined()
  })

  test('`onResetData` must be a function', () => {
    // @ts-expect-error — the runtime check exists for a JS author and for a
    // bundle that was hand-assembled rather than authored through this helper.
    expect(() => defineService({ setup: () => {}, onResetData: 'yes' })).toThrow(/must be a function/)
  })

  test('the borrowed list is bounded, like every other operator-facing list here', () => {
    expect(() =>
      defineService({
        setup: () => {},
        resetData: { permissions: Array.from({ length: 9 }, (_, i) => `cap.${i}`) },
        onResetData: () => {},
      }),
    ).toThrow(/resetData.permissions/)
  })
})
