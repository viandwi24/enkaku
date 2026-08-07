import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { InputGroup, InputGroupAddon } from './input-group'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * `InputGroup` sets `items-center` for its default ROW layout, where it means
 * "centre vertically" and is right. Two variants flip it to `flex-col` when a
 * `data-align=block-start|block-end` child is present — and upstream did not
 * flip `items-center` with them, so on a column the same class means "centre
 * HORIZONTALLY" and pinches every child to its content width.
 *
 * That is what made the agent composer render its placeholder, its caret and
 * its whole footer row centred. Plan 83 tried to fix it on the textarea with
 * `items-start` and reported the criterion PASS from reading CSS rather than
 * looking at the screen; the centring was never the control's to fix.
 *
 * The failure is silent — nothing throws, no test notices, the box just looks
 * wrong — so it gets a test at the primitive, and one that would have caught
 * the original.
 */
describe('InputGroup — a column layout must not inherit horizontal centring', () => {
  // Note on what these assert: Tailwind's `has-[…]:` variants are ALWAYS
  // present in the class string and apply conditionally in CSS, so a test
  // cannot check "is the column variant active right now" without a real
  // layout engine, which happy-dom is not. What it CAN check — and what
  // actually regressed — is that the flip to `flex-col` never ships without
  // the matching `items-stretch` beside it.
  test('the row default is items-center: there it means vertical, and it is correct', () => {
    const { container } = renderWithApi(
      <InputGroup>
        <input aria-label="q" />
      </InputGroup>,
    )
    expect(container.querySelector('[data-slot="input-group"]')?.className).toContain('items-center')
  })

  test('every flex-col variant carries items-stretch — the pairing is the whole fix', () => {
    const { container } = renderWithApi(
      <InputGroup>
        <input aria-label="q" />
      </InputGroup>,
    )
    const cls = container.querySelector('[data-slot="input-group"]')?.className ?? ''
    const colVariants = cls.match(/has-\[>\[data-align=[a-z-]+\]\]:flex-col/g) ?? []
    expect(colVariants.length).toBeGreaterThan(0)
    for (const v of colVariants) {
      const align = v.match(/data-align=([a-z-]+)/)?.[1]
      expect(cls).toContain(`has-[>[data-align=${align}]]:items-stretch`)
    }
  })

  test('a block-end child flips to flex-col AND stretches, so children fill the width', () => {
    const { container } = renderWithApi(
      <InputGroup>
        <textarea aria-label="message" />
        <InputGroupAddon align="block-end">footer</InputGroupAddon>
      </InputGroup>,
    )
    const cls = container.querySelector('[data-slot="input-group"]')?.className ?? ''
    expect(cls).toContain('has-[>[data-align=block-end]]:flex-col')
    expect(cls).toContain('has-[>[data-align=block-end]]:items-stretch')
  })

  test('block-start gets the same treatment — the axis flip is what matters, not which end', () => {
    const { container } = renderWithApi(
      <InputGroup>
        <InputGroupAddon align="block-start">header</InputGroupAddon>
        <textarea aria-label="message" />
      </InputGroup>,
    )
    const cls = container.querySelector('[data-slot="input-group"]')?.className ?? ''
    expect(cls).toContain('has-[>[data-align=block-start]]:flex-col')
    expect(cls).toContain('has-[>[data-align=block-start]]:items-stretch')
  })
})
