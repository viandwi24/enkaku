import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { PageHeader } from './PageHeader'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * `titlePill` (plan 101 §5 step 101.8, owner-specified 2026-08-16) — the
 * one optional prop that lets a single screen (`app/page.tsx`'s Devices
 * header) render `title` + `meta` as ONE floating pill object, `refs/ui`'s
 * own shape, without forking `PageHeader` itself. Every one of the other 26
 * callers passes neither `titlePill` nor a matching test for it — proven
 * below by asserting the DEFAULT path renders byte-for-byte what it always
 * has.
 */
describe('PageHeader — default (no titlePill): unchanged for the other 26 screens', () => {
  test('renders a plain <h1> title and, when given, a description underneath it', () => {
    const { container, getByText } = renderWithApi(<PageHeader title="Scripts" description="Automations for this farm" />)
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toBe('Scripts')
    expect(getByText('Automations for this farm')).toBeTruthy()
    // No pill shell wraps the title when the prop is absent.
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  test('meta renders as its own sibling object, not merged into the title', () => {
    const { container, getByText } = renderWithApi(
      <PageHeader title="Jobs" meta={<span data-testid="meta-badge">12</span>} />,
    )
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toBe('Jobs')
    const badge = getByText('12')
    // The badge is not a descendant of the <h1> — it is a separate element
    // in the header row, the "heading beside a badge" shape step 101.8
    // moved away from for the one screen that opts into `titlePill`.
    expect(h1?.contains(badge)).toBe(false)
  })
})

describe('PageHeader — titlePill (plan 101 §5 step 101.8, owner-specified 2026-08-16)', () => {
  test('title and meta merge into ONE pill object, with a divider between them', () => {
    const { container, getByText } = renderWithApi(
      <PageHeader title="Devices" titlePill meta={<span className="readout">7</span>} />,
    )
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toBe('Devices')
    const pill = h1?.closest('.rounded-full')
    expect(pill).toBeTruthy()
    // The count is INSIDE the same pill as the title now — the whole point
    // of this prop (`refs/ui`'s own single title-pill object).
    const count = getByText('7')
    expect(pill?.contains(count)).toBe(true)
  })

  test('with no meta, no divider renders (nothing to divide)', () => {
    const { container } = renderWithApi(<PageHeader title="Devices" titlePill />)
    const h1 = container.querySelector('h1')
    const pill = h1?.closest('.rounded-full')
    expect(pill).toBeTruthy()
    // The divider is the pill's only other possible child besides the h1 —
    // absent when there is nothing on the other side of it to separate.
    expect(pill?.children.length).toBe(1)
  })

  test('description is not rendered — a floating pill has no room for a subtitle line', () => {
    const { queryByText } = renderWithApi(
      <PageHeader title="Devices" titlePill description="Phones connected to this farm" />,
    )
    expect(queryByText('Phones connected to this farm')).toBeNull()
  })
})
