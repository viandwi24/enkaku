import { describe, expect, test } from 'bun:test'
import { deviceSearchTerms, formatDeviceName, matchesDeviceQuery } from './device-name'

/**
 * Plan 124 §7 — the two rules this module makes universal, pinned.
 *
 * The tests that matter most here are not the obvious ones. `#7 Galaxy A15`
 * working is not in doubt; what plan 124 exists to prevent is the two failures
 * that actually shipped: a device with no number rendering `#null`, and the
 * web side drifting away from the core's spelling of the same name.
 */

describe('formatDeviceName (§4.1)', () => {
  test('composes the number in front of the label', () => {
    expect(formatDeviceName(7, 'Galaxy A15')).toBe('#7 Galaxy A15')
  })

  /**
   * Criterion 7, and the reason `number` is typed optional AND nullable.
   * `null` is a device whose reservation was released; `undefined` is a
   * payload or fixture that predates the field. Neither may produce a stray
   * `#`, and neither may produce the literal `#null`/`#undefined` — which is
   * exactly what every hand-rolled `` `#${d.number} ${d.label}` `` at the ~70
   * uncorrected render sites would have produced the moment a number was
   * released.
   */
  test('a device with no number renders its bare label — no `#`, no `#null`', () => {
    expect(formatDeviceName(null, 'Galaxy A15')).toBe('Galaxy A15')
    expect(formatDeviceName(undefined, 'Galaxy A15')).toBe('Galaxy A15')
    expect(formatDeviceName(null, 'Galaxy A15')).not.toContain('#')
  })

  /**
   * A label may legitimately already contain a `#` — an operator is free to
   * name a phone `Rack 2 #left`. The formatter is pure composition and must
   * not notice, parse, strip or deduplicate it: nothing in the product reads
   * `#N` back out of a label, so nothing here may pretend it could.
   */
  test('a label that already contains `#` is passed through untouched', () => {
    expect(formatDeviceName(7, 'Rack 2 #left')).toBe('#7 Rack 2 #left')
    expect(formatDeviceName(null, 'Rack 2 #left')).toBe('Rack 2 #left')
  })

  /**
   * §3.2's promise: this mirrors `formatDeviceLabel` in
   * `packages/core/src/registry/device-number.ts` character for character.
   *
   * The obvious way to test that is to import the core's function and compare
   * — which this cannot do, because `@enkaku/ui` does not depend on
   * `@enkaku/core` and must not start (a plugin bundles this package's import
   * graph; the core is a Bun server with a SQLite driver in it). Nor may it
   * reach across with a relative path: CLAUDE.md forbids cross-package
   * relative imports outright.
   *
   * So the agreement is checked against the core's SOURCE TEXT, read as a
   * file. That is a weaker guarantee than calling the function and a stronger
   * one than a comment: if either side's expression is edited, this fails and
   * names the other side, which is the whole point. The two spellings below
   * are the same characters in the same order, deliberately.
   */
  test('agrees with the core `formatDeviceLabel`, checked against its source', async () => {
    const path = new URL('../../../core/src/registry/device-number.ts', import.meta.url)
    const source = await Bun.file(path).text()
    expect(source).toContain('return number === null ? label : `#${number} ${label}`')
    // And the cases the plan names explicitly, evaluated against that same
    // expression rather than merely asserted about it.
    const core = (number: number | null, label: string) => (number === null ? label : `#${number} ${label}`)
    for (const [n, label] of [
      [null, 'Galaxy A15'],
      [1, 'Galaxy A15'],
      [7, 'Rack 2 #left'],
      [128, ''],
    ] as const) {
      expect(formatDeviceName(n, label)).toBe(core(n, label))
    }
  })
})

const PHONE = {
  number: 7,
  label: 'Galaxy A15',
  stableId: 'R5CW10ABCDE',
  tags: ['pool:smoke', 'Rack:2'],
}

describe('matchesDeviceQuery (§4.1, the four-way match)', () => {
  test('a bare digit and a `#`-prefixed one both find the number', () => {
    expect(matchesDeviceQuery(PHONE, '7')).toBe(true)
    expect(matchesDeviceQuery(PHONE, '#7')).toBe(true)
  })

  /**
   * The number match is EXACT while everything else is a substring — the one
   * asymmetry in this predicate, and the one worth a test. An operator reading
   * `7` off the phone in front of them must get that phone, not `#17`, `#27`
   * and `#70` as well. (`#70`'s label here contains no `7`, so a false pass
   * could only come from the number branch.)
   */
  test('the number match is exact — `7` does not find `#17` or `#70`', () => {
    const seventeen = { number: 17, label: 'Pixel', stableId: 'AAA' }
    const seventy = { number: 70, label: 'Pixel', stableId: 'AAA' }
    expect(matchesDeviceQuery(seventeen, '7')).toBe(false)
    expect(matchesDeviceQuery(seventy, '7')).toBe(false)
    expect(matchesDeviceQuery(seventeen, '17')).toBe(true)
    expect(matchesDeviceQuery(seventeen, '#17')).toBe(true)
  })

  test('label, stableId and tag all match, case-insensitively', () => {
    expect(matchesDeviceQuery(PHONE, 'galaxy')).toBe(true)
    expect(matchesDeviceQuery(PHONE, 'GALAXY')).toBe(true)
    expect(matchesDeviceQuery(PHONE, 'r5cw10')).toBe(true)
    expect(matchesDeviceQuery(PHONE, 'pool:smoke')).toBe(true)
    // `DevicePicker` lowercased the query but not the tag, so a tag with any
    // capital in it was unfindable. Fixed in the shared definition; asserted
    // here so it cannot come back.
    expect(matchesDeviceQuery(PHONE, 'rack:2')).toBe(true)
  })

  test('a cleared search box shows the whole list, not an empty one', () => {
    expect(matchesDeviceQuery(PHONE, '')).toBe(true)
    expect(matchesDeviceQuery(PHONE, '   ')).toBe(true)
  })

  test('surrounding whitespace is trimmed — a pasted stableId still matches', () => {
    expect(matchesDeviceQuery(PHONE, '  R5CW10ABCDE  ')).toBe(true)
  })

  test('a device with no number is still findable by everything else', () => {
    const unnumbered = { number: null, label: 'Galaxy A15', stableId: 'R5CW10ABCDE' }
    expect(matchesDeviceQuery(unnumbered, '7')).toBe(false)
    expect(matchesDeviceQuery(unnumbered, '#7')).toBe(false)
    expect(matchesDeviceQuery(unnumbered, 'galaxy')).toBe(true)
  })

  test('a projection with no tags at all is not an error', () => {
    expect(matchesDeviceQuery({ label: 'Galaxy A15', stableId: 'R5CW10ABCDE' }, 'galaxy')).toBe(true)
    expect(matchesDeviceQuery({ label: 'Galaxy A15', stableId: 'R5CW10ABCDE' }, 'smoke')).toBe(false)
  })

  test('nothing matches a query that appears nowhere', () => {
    expect(matchesDeviceQuery(PHONE, 'pixel')).toBe(false)
  })
})

describe('deviceSearchTerms (§4.1)', () => {
  test('carries the number in both the forms an operator types', () => {
    const terms = deviceSearchTerms(PHONE)
    expect(terms).toContain('7')
    expect(terms).toContain('#7')
    expect(terms).toContain('Galaxy A15')
    expect(terms).toContain('R5CW10ABCDE')
    expect(terms).toContain('pool:smoke')
  })

  test('omits the number entirely when there is none', () => {
    const terms = deviceSearchTerms({ number: null, label: 'Galaxy A15', stableId: 'R5CW10ABCDE' })
    expect(terms).toEqual(['Galaxy A15', 'R5CW10ABCDE'])
  })

  /**
   * An empty keyword scores every row identically inside `cmdk`, which is the
   * same thing as turning the filter off for the whole list — a silent
   * failure, since the dropdown still looks like it is filtering.
   */
  test('drops empty strings so the filter cannot be silently disabled', () => {
    expect(deviceSearchTerms({ number: 7, label: '', stableId: 'R5CW10ABCDE', tags: [''] })).toEqual([
      '7',
      '#7',
      'R5CW10ABCDE',
    ])
  })
})
