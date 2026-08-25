import { describe, expect, test } from 'bun:test'
import { ScanPageSchema } from './api'

/**
 * Plan 124 step 124.8 — **the device number reaching this pack's Assignments
 * tab is a parsing change and nothing else**, so this is where it is proved.
 *
 * §0.5 of that plan is the whole finding: `GET /api/plugins/:name/data/scan`
 * has LEFT JOINed `device_numbers` since plan 89 and answers `number` on every
 * row (`packages/core/src/api/plugins.ts`). No server change was needed, no
 * payload was widened, and no second request was added — the field was simply
 * absent from `ScanRowSchema`, which is why the tab named three physically
 * identical phones `SM-F721U1, SM-F721U1, SM-F721U1`.
 *
 * The rendering half (the `<DeviceName>` cell, the filter box, the per-row
 * `<Combobox>`) is not asserted here: this pack has no DOM harness — the root
 * `bunfig.toml` preloads happy-dom for `packages/studio` and `packages/ui`
 * only — and `catalogue.test.ts` beside this file records the same limit for
 * the same reason. It is a stated gap, not a silent one.
 */

/** One row as the core actually answers it, with the two fields this test moves between. */
function row(overrides: Record<string, unknown> = {}) {
  return { stableId: 'R5CW1234', label: 'SM-F721U1', status: 'idle', number: 7, entry: null, ...overrides }
}

describe('ScanPageSchema — the device number the scan route already sends', () => {
  test('an allocated number is parsed through, as an integer', () => {
    const page = ScanPageSchema.parse({ items: [row()], nextCursor: null })
    expect(page.items[0]?.number).toBe(7)
  })

  test('null is a real state — a device whose reservation was released, not an error', () => {
    const page = ScanPageSchema.parse({ items: [row({ number: null })], nextCursor: null })
    expect(page.items[0]?.number).toBeNull()
  })

  /**
   * The reason the field is `.default(null)` rather than merely `.nullable()`.
   * A tier-C pack can be published against a core older than the join, and
   * this file's own header states the trade: a field the core has not sent
   * must never be an error in an operator's face. Without the default, one
   * missing key would fail the parse and take the whole Assignments tab down —
   * where the honest degradation is a bare label.
   */
  test('a core that does not send the field at all degrades to no number, never to a failed page', () => {
    const legacy = { stableId: 'R5CW1234', label: 'SM-F721U1', status: 'idle', entry: null }
    const page = ScanPageSchema.parse({ items: [legacy], nextCursor: null })
    expect(page.items[0]?.number).toBeNull()
  })

  test('a non-integer number is refused rather than rendered as `#7.5`', () => {
    expect(() => ScanPageSchema.parse({ items: [row({ number: 7.5 })], nextCursor: null })).toThrow()
  })
})
