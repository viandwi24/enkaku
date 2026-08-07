import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { JobStatusBadge } from './StatusBadge'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * A failed job's error belongs on the badge, not as a line in the row. Inline
 * it dominated every list for the one row in a hundred that failed, and an
 * error quoting a URL with no spaces pushed every column off the right edge.
 */
describe('JobStatusBadge — a failure explains itself without taking over the row', () => {
  test('a failed job with an error exposes it, without rendering it inline', () => {
    const { container } = renderWithApi(<JobStatusBadge status="failed" error="typed the wrong selector" />)
    // Reachable (title, for hover and for anything that does not hover)…
    expect(container.querySelector('[title="typed the wrong selector"]')).not.toBeNull()
    // …but the row itself still reads as one short line.
    expect(container.textContent).toBe('failed')
  })

  test('a failed job with no error is a plain badge — no empty tooltip to open', () => {
    const { container } = renderWithApi(<JobStatusBadge status="failed" />)
    expect(container.querySelector('[title]')).toBeNull()
  })

  test('a successful job never carries one', () => {
    const { container } = renderWithApi(<JobStatusBadge status="success" error="ignored" />)
    expect(container.querySelector('[title]')).toBeNull()
  })
})
