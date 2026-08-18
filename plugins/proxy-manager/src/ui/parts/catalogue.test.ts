import { describe, expect, test } from 'bun:test'
import { stepLastOctet } from './catalogue'

/**
 * Plan 117 step 117.11 — the range generator's octet-boundary refusal
 * (§3.9, criterion 11), proved directly against the real function rather than
 * by reading `catalogue.tsx` as text.
 *
 * `stepLastOctet` is the whole of the refusal: `GenerateDialog`'s `range`
 * `useMemo` calls it once, against the LAST row the count would need, and
 * refuses the whole range rather than generating fewer rows than asked for
 * when it returns `null`. That "refuse the whole range, never truncate it"
 * behaviour lives in the component and is not re-tested here — it is a
 * property of a hook this pack has no DOM harness to render, and is noted as
 * such in this plan's own report rather than silently skipped. What IS
 * testable without one, and is exactly what criterion 11 is about, is the
 * boundary math itself: whether a given `(base, delta)` pair crosses .255 (or
 * dips below .0), which this file proves directly.
 */

describe('stepLastOctet — ordinary IPv4 increment of the LAST octet only', () => {
  test('steps the last octet up, leaving the first three untouched', () => {
    expect(stepLastOctet('192.168.100.11', 0)).toBe('192.168.100.11')
    expect(stepLastOctet('192.168.100.11', 1)).toBe('192.168.100.12')
    expect(stepLastOctet('192.168.100.11', 9)).toBe('192.168.100.20')
  })

  test('the boundary — the last octet may reach 255 but not cross it', () => {
    // The control that makes the refusal below mean something: one octet
    // short of the boundary still steps normally.
    expect(stepLastOctet('192.168.100.254', 1)).toBe('192.168.100.255')
    // And crossing it — the exact refusal criterion 11 asks for — is `null`,
    // not a wraparound and not a guess at the next /24.
    expect(stepLastOctet('192.168.100.254', 2)).toBeNull()
    expect(stepLastOctet('192.168.100.255', 1)).toBeNull()
    expect(stepLastOctet('192.168.100.0', 256)).toBeNull()
  })

  test('a negative delta cannot dip below 0 either', () => {
    expect(stepLastOctet('192.168.100.0', -1)).toBeNull()
    expect(stepLastOctet('192.168.100.1', -1)).toBe('192.168.100.0')
  })

  test('anything that is not a plain IPv4 literal is refused rather than guessed at', () => {
    expect(stepLastOctet('not-an-ip', 1)).toBeNull()
    expect(stepLastOctet('2001:db8::1', 1)).toBeNull()
    expect(stepLastOctet('192.168.100', 1)).toBeNull()
    expect(stepLastOctet('192.168.100.11.5', 1)).toBeNull()
    expect(stepLastOctet('192.168.100.256', 1)).toBeNull()
  })
})
