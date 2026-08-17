import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { OutcomeSummary } from './OutcomeSummary'

afterEach(cleanup)

/**
 * `docs/plans/96-m61-hotfixes.md` §96.30 — the owner's own screenshot showed
 * a full-width progress bar for "(0/0)", a batch stuck reporting zero jobs.
 * `counts.total === 0` already produced `percent: 0` (an empty INDICATOR),
 * but the track underneath it (`bg-primary/20`, itself a full-width, always-
 * visible pill) still reads as a bar with something to show — this proves
 * the fix (no `<Progress>` at all for zero total) rather than trusting a
 * value of 0 to look empty enough.
 */
describe('OutcomeSummary — zero total renders no progress bar at all (§96.30)', () => {
  test('counts.total === 0 renders the text line but no [role="progressbar"]', () => {
    const { container } = renderWithApi(<OutcomeSummary counts={{ ok: 0, failed: 0, skipped: 0, total: 0 }} />)
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.textContent).toContain('0 ok · 0 failed · 0 skipped (0/0)')
  })

  test('a real total still renders the bar', () => {
    const { container } = renderWithApi(<OutcomeSummary counts={{ ok: 1, failed: 0, skipped: 0, total: 2 }} />)
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(container.textContent).toContain('1 ok · 0 failed · 0 skipped (1/2)')
  })
})
