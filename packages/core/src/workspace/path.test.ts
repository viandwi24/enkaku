import { describe, expect, test } from 'bun:test'
import { EnkakuError } from '../util/errors'
import { normaliseScopePrefix, normaliseWorkspacePath, pathWithinAnyPrefix, pathWithinPrefix, scopeOfPath } from './path'

/**
 * Path validation is the pure function everything else in this plan trusts
 * (plan 64 step 64.1, section 7: "this table is the plan's most important
 * test and should be over-long rather than representative"). ".." is
 * REJECTED, never resolved -- a traversal bug here is a traversal bug
 * everywhere.
 */

describe('normaliseWorkspacePath - the traversal table (plan 64 section 7)', () => {
  const REJECTED: [string, string][] = [
    ['', 'empty string'],
    ['relative/path.ts', 'not absolute'],
    ['scripts/hello.ts', 'not absolute'],
    ['/../etc/passwd', 'leading ..'],
    ['/a/../../etc/passwd', 'climbs above an ancestor'],
    ['/a/..', 'trailing .. segment'],
    ['/..', 'bare .. segment'],
    ['/a/./b', 'a "." segment'],
    ['/.', 'bare "." segment'],
    ['/a/.', 'trailing "." segment'],
    ['//a', 'leading double slash (empty first segment)'],
    ['/a//b', 'doubled slash mid-path (empty segment)'],
    ['/a//', 'doubled trailing slash'],
    ['/a/b/', 'trailing slash'],
    ['/', 'the bare root'],
    ['/a/', 'a single-segment path with a trailing slash'],
  ]

  for (const [input, reason] of REJECTED) {
    test(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      expect(() => normaliseWorkspacePath(input)).toThrow(EnkakuError)
      try {
        normaliseWorkspacePath(input)
        throw new Error('unreachable')
      } catch (err) {
        expect((err as EnkakuError).code).toBe('E_BAD_PATH')
      }
    })
  }

  test('rejects a non-string', () => {
    expect(() => normaliseWorkspacePath(undefined)).toThrow(EnkakuError)
    expect(() => normaliseWorkspacePath(123)).toThrow(EnkakuError)
    expect(() => normaliseWorkspacePath(null)).toThrow(EnkakuError)
    expect(() => normaliseWorkspacePath({})).toThrow(EnkakuError)
  })

  test('rejects a path over 512 UTF-8 bytes', () => {
    const long = '/' + 'a'.repeat(600)
    expect(() => normaliseWorkspacePath(long)).toThrow(EnkakuError)
  })

  test('accepts a path at exactly the 512-byte boundary', () => {
    // '/' (1 byte) + 511 'a's = 512 bytes exactly.
    const atLimit = '/' + 'a'.repeat(511)
    expect(new TextEncoder().encode(atLimit).length).toBe(512)
    expect(normaliseWorkspacePath(atLimit)).toBe(atLimit)
  })

  test('rejects a multi-byte path that exceeds 512 bytes even with few characters', () => {
    // Each precomposed accented codepoint is 2 UTF-8 bytes.
    const accented = String.fromCharCode(233) // 'e' with acute accent, NFC form
    const long = '/' + accented.repeat(300)
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(512)
    expect(() => normaliseWorkspacePath(long)).toThrow(EnkakuError)
  })

  test('rejects a path over 32 segments', () => {
    const tooDeep = '/' + Array.from({ length: 33 }, (_, i) => `s${i}`).join('/')
    expect(() => normaliseWorkspacePath(tooDeep)).toThrow(EnkakuError)
  })

  test('accepts a path at exactly 32 segments', () => {
    const atLimit = '/' + Array.from({ length: 32 }, (_, i) => `s${i}`).join('/')
    expect(normaliseWorkspacePath(atLimit)).toBe(atLimit)
  })

  const ACCEPTED = ['/scripts/hello.ts', '/shared/notes.md', '/agents/checkout-bot/main.ts', '/notes/a.txt', '/a']

  for (const path of ACCEPTED) {
    test(`accepts ${JSON.stringify(path)} unchanged`, () => {
      expect(normaliseWorkspacePath(path)).toBe(path)
    })
  }

  test('Unicode normalisation: NFD and NFC forms of the same visible path collapse to the SAME string', () => {
    // A precomposed accented codepoint (NFC) vs the base letter plus a
    // combining accent (NFD) -- visually identical, byte-different. Both
    // must normalise to the exact same canonical path.
    const nfc = '/agents/' + String.fromCharCode(233) + '/notes.md' // e-acute, NFC
    const nfd = '/agents/' + 'e' + String.fromCharCode(0x0301) + '/notes.md' // e + combining acute, NFD
    expect(nfc).not.toBe(nfd) // sanity: they really are different byte sequences
    expect(normaliseWorkspacePath(nfc)).toBe(normaliseWorkspacePath(nfd))
    expect(normaliseWorkspacePath(nfc)).toBe(nfc)
  })

  test('a unicode lookalike of "." is left alone -- this function does not attempt homoglyph detection', () => {
    // A fullwidth dot (a distinct codepoint from the ASCII period) is NOT
    // unicode-equivalent to "." under NFC -- a segment must be the LITERAL
    // string "." or ".." to be rejected.
    const fullwidthDot = String.fromCharCode(0xff0e)
    const path = `/a/${fullwidthDot}/b`
    expect(() => normaliseWorkspacePath(path)).not.toThrow()
  })
})

describe('scopeOfPath (plan 64 section 3.2, 3.3)', () => {
  test('an agent home scopes to /agents/<slug>/', () => {
    expect(scopeOfPath('/agents/checkout-bot/main.ts')).toBe('/agents/checkout-bot/')
    expect(scopeOfPath('/agents/checkout-bot/lib/util.ts')).toBe('/agents/checkout-bot/')
  })

  test('every other top-level directory scopes to itself', () => {
    expect(scopeOfPath('/scripts/hello.ts')).toBe('/scripts/')
    expect(scopeOfPath('/shared/notes.md')).toBe('/shared/')
    expect(scopeOfPath('/notes/a.txt')).toBe('/notes/')
  })

  test('a bare top-level file still scopes to its directory', () => {
    expect(scopeOfPath('/a')).toBe('/a/')
  })
})

describe('normaliseScopePrefix / pathWithinPrefix (plan 64 section 4.2, acceptance #6)', () => {
  test('the root prefix "/" matches everything', () => {
    expect(normaliseScopePrefix('/')).toBe('/')
    expect(pathWithinPrefix('/agents/x/a.ts', '/')).toBe(true)
    expect(pathWithinPrefix('/shared/a.ts', '/')).toBe(true)
  })

  test('a directory prefix matches its own subtree only', () => {
    const prefix = normaliseScopePrefix('/agents/checkout-bot')
    expect(prefix).toBe('/agents/checkout-bot/')
    expect(pathWithinPrefix('/agents/checkout-bot/main.ts', prefix)).toBe(true)
    expect(pathWithinPrefix('/agents/checkout-bot/lib/x.ts', prefix)).toBe(true)
    expect(pathWithinPrefix('/agents/checkout-bot-2/main.ts', prefix)).toBe(false)
    expect(pathWithinPrefix('/agents/other/main.ts', prefix)).toBe(false)
  })

  test('pathWithinAnyPrefix checks a list of grants', () => {
    const prefixes = [normaliseScopePrefix('/agents/checkout-bot'), normaliseScopePrefix('/shared')]
    expect(pathWithinAnyPrefix('/agents/checkout-bot/a.ts', prefixes)).toBe(true)
    expect(pathWithinAnyPrefix('/shared/a.ts', prefixes)).toBe(true)
    expect(pathWithinAnyPrefix('/agents/someone-else/a.ts', prefixes)).toBe(false)
  })
})
