import { describe, expect, test } from 'bun:test'
import { shellQuote } from './shell-quote'

/**
 * Canonical location for these tests (plan 34 §4.3 / plan 35 §4.2 — moved
 * down from `packages/core/src/device/monitors.test.ts`, which keeps its own
 * copy unchanged since it re-imports `shellQuote` from `./monitors`, itself
 * re-exported from here).
 */
describe('shellQuote — injection attempts must not escape the quotes', () => {
  test('wraps in single quotes and neutralises a bare shell metacharacter set', () => {
    expect(shellQuote('hello')).toBe(`'hello'`)
    expect(shellQuote('')).toBe(`''`)
  })

  test('a semicolon cannot terminate the command', () => {
    const quoted = shellQuote('a;rm -rf /')
    expect(quoted).toBe(`'a;rm -rf /'`)
    // The dangerous byte is inside the quotes, never outside them.
    expect(quoted.indexOf(';')).toBeGreaterThan(quoted.indexOf(`'`))
  })

  test('backticks do not open command substitution', () => {
    const quoted = shellQuote('a`id`b')
    expect(quoted).toBe("'a`id`b'")
  })

  test('$(...) command substitution stays literal', () => {
    const quoted = shellQuote('a$(id)b')
    expect(quoted).toBe("'a$(id)b'")
  })

  test('a double quote inside a single-quoted string is inert', () => {
    const quoted = shellQuote('a"b')
    expect(quoted).toBe(`'a"b'`)
  })

  test('an embedded single quote is escaped by closing, escaping, and reopening the quote', () => {
    // sh evaluates 'a'\''b' as the three literal characters a ' b.
    const quoted = shellQuote(`a'b`)
    expect(quoted).toBe(`'a'\\''b'`)
  })

  test("a worked example — a\"b;c$(id)` — appears literally, nothing executes", () => {
    const input = 'a"b;c$(id)`'
    const quoted = shellQuote(input)
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    expect(quoted).toContain(input)
  })

  test('a package name with a shell metacharacter cannot execute a second command (plan 35 §6.9)', () => {
    const quoted = shellQuote('com.example.app; rm -rf /sdcard')
    expect(quoted).toBe(`'com.example.app; rm -rf /sdcard'`)
    expect(quoted.indexOf(';')).toBeGreaterThan(0)
  })
})
