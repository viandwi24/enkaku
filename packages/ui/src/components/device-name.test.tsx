import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { DeviceName } from './device-name'

afterEach(cleanup)

/**
 * Plan 124 criterion 7, rendered rather than merely formatted: "a device with
 * `number === null` renders its bare label everywhere, with no stray `#`, no
 * `#null`, and no layout shift."
 *
 * `formatDeviceName`'s own tests (../lib/device-name.test.ts) cover the string.
 * These cover the thing that string cannot: that the number is a SEPARATE
 * element — which is what lets it be dimmed, and what makes its absence cost
 * nothing — and that it is not hidden from assistive technology.
 *
 * `happy-dom` has no layout engine, so "no layout shift" is asserted as its
 * cause (no element and therefore no gap) rather than as a measured position,
 * the same honest limit `dialog.test.tsx` records.
 */
describe('DeviceName', () => {
  test('renders the number and the label as two elements, not one string', () => {
    const { container } = render(<DeviceName number={7} label="Galaxy A15" />)
    const spans = [...container.querySelectorAll('span')]
    expect(spans.map((s) => s.textContent)).toContain('#7')
    expect(spans.map((s) => s.textContent)).toContain('Galaxy A15')
  })

  test('the number is dimmed by default, and the caller can override that', () => {
    const { container } = render(<DeviceName number={7} label="Galaxy A15" numberClassName="text-accent" />)
    const number = [...container.querySelectorAll('span')].find((s) => s.textContent === '#7')
    expect(number?.className).toContain('readout')
    expect(number?.className).toContain('text-accent')
  })

  /**
   * The number is identity, not decoration — it is the ONLY thing separating
   * three rows a screen reader would otherwise announce as "SM-F721U1" three
   * times over. `DevicePicker`'s own copy marks it `aria-hidden` because that
   * row's label carries the identity; this component must not.
   */
  test('the number is exposed to assistive technology, not aria-hidden', () => {
    const { container } = render(<DeviceName number={7} label="Galaxy A15" />)
    const number = [...container.querySelectorAll('span')].find((s) => s.textContent === '#7')
    expect(number?.getAttribute('aria-hidden')).toBeNull()
  })

  test('no number renders no `#` at all — not `#null`, not an empty span', () => {
    for (const number of [null, undefined]) {
      cleanup()
      const { container } = render(<DeviceName number={number} label="Galaxy A15" />)
      expect(container.textContent).toBe('Galaxy A15')
      expect(container.textContent).not.toContain('#')
      // The gap lives on the wrapper (`gap-1.5`), so one child means no gap —
      // which is why an unnumbered device costs no leading whitespace.
      expect(container.querySelectorAll('span').length).toBe(2) // wrapper + label
    }
  })
})
