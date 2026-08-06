import { describe, expect, test } from 'bun:test'
import { compareSemver, isPrereleaseVersion, parseScriptRef, ScriptRefSchema } from './script-ref'

describe('ScriptRefSchema', () => {
  test.each([
    'checkout@1.0.1',
    'checkout@latest',
    'checkout@1.0.0-beta.1',
    'checkout@1.0.0+build.5',
    'checkout@1.0.0-beta.1+build.5',
    'a@1.0.0',
    'a.b_c-d@1.0.0',
  ])('accepts %s', (ref) => {
    expect(ScriptRefSchema.safeParse(ref).success).toBe(true)
  })

  test.each([
    '', // empty
    'checkout', // no @version
    '@1.0.0', // no name
    'checkout@', // no version
    'checkout@1.0', // not full semver
    'checkout@v1.0.0', // 'v' prefix not admitted
    'Checkout@1.0.0', // uppercase name
    'checkout@1.0.0.0', // too many components
    'checkout@1.0.0-', // dangling separator
    'checkout@stable', // only 'latest' is a valid alias
    ' checkout@1.0.0', // leading whitespace
    'checkout@1.0.0 ', // trailing whitespace
  ])('rejects %s', (ref) => {
    expect(ScriptRefSchema.safeParse(ref).success).toBe(false)
  })
})

describe('parseScriptRef', () => {
  test('splits name and a concrete version', () => {
    expect(parseScriptRef('checkout@1.0.1')).toEqual({ name: 'checkout', version: '1.0.1' })
  })

  test('splits name and latest', () => {
    expect(parseScriptRef('checkout@latest')).toEqual({ name: 'checkout', version: 'latest' })
  })

  test('a hyphenated name is not mistaken for extra structure', () => {
    expect(parseScriptRef('my-checkout-script@2.3.4')).toEqual({ name: 'my-checkout-script', version: '2.3.4' })
  })
})

describe('compareSemver', () => {
  test('1.0.10 beats 1.0.9 — numeric, not string, comparison', () => {
    // A string sort would rank '1.0.10' before '1.0.9' because '1' < '9'
    // lexically at the first differing character. This is the named trap.
    expect(compareSemver('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareSemver('1.0.9', '1.0.10')).toBeLessThan(0)
  })

  test('a plain release outranks its own prerelease', () => {
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBeLessThan(0)
  })

  test('build metadata is ignored in ordering', () => {
    expect(compareSemver('1.0.0+build1', '1.0.0+build2')).toBe(0)
    expect(compareSemver('1.0.0+build1', '1.0.0')).toBe(0)
  })

  test('major/minor/patch precedence', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.10', '1.0.2')).toBeGreaterThan(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  test('the canonical semver.org §11 prerelease ordering example', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 0; i < ascending.length - 1; i++) {
      const a = ascending[i] as string
      const b = ascending[i + 1] as string
      expect(compareSemver(a, b)).toBeLessThan(0)
      expect(compareSemver(b, a)).toBeGreaterThan(0)
    }
  })

  test('numeric prerelease identifiers always sort below alphanumeric ones', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  test('fewer prerelease fields sorts lower once the shared prefix ties', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
  })
})

describe('isPrereleaseVersion', () => {
  test('a plain release is not a prerelease', () => {
    expect(isPrereleaseVersion('1.0.0')).toBe(false)
  })

  test('a prerelease is detected regardless of build metadata', () => {
    expect(isPrereleaseVersion('1.0.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('1.0.0-beta.1+build.5')).toBe(true)
  })

  test('build metadata alone does not make a version a prerelease', () => {
    expect(isPrereleaseVersion('1.0.0+build.5')).toBe(false)
  })
})
