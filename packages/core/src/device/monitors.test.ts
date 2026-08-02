import { describe, expect, test } from 'bun:test'
import { EnkakuError } from '../util/errors'
import { buildMonitorCommand, shellQuote } from './monitors'

describe('shellQuote (plan 24 §4.3, §7) — injection attempts must not escape the quotes', () => {
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

  test("the plan's own worked example — a\"b;c$(id)` — appears literally, nothing executes", () => {
    const input = 'a"b;c$(id)`'
    const quoted = shellQuote(input)
    // Every character of the payload survives, and it is entirely enclosed
    // in a leading and trailing single quote (the only two ' characters that
    // are not themselves part of an escape sequence, since the payload has
    // no ' of its own here).
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    expect(quoted).toContain(input)
  })
})

describe('buildMonitorCommand (plan 24 §4.3) — the only place a monitor command string is produced', () => {
  test('logcat: defaults produce the documented base command', () => {
    expect(buildMonitorCommand('logcat', {})).toBe('logcat -v time -b main *:V')
  })

  test('logcat: priority and buffer are enum-constrained, interpolated directly', () => {
    expect(buildMonitorCommand('logcat', { priority: 'E', buffer: 'crash' })).toBe('logcat -v time -b crash *:E')
  })

  test('logcat: a tag restricts to that tag and silences everything else', () => {
    expect(buildMonitorCommand('logcat', { tag: 'ActivityManager', priority: 'W' })).toBe(
      'logcat -v time -b main ActivityManager:W *:S',
    )
  })

  test('logcat: a filter is appended as a shell-quoted grep -F, never interpolated raw', () => {
    const cmd = buildMonitorCommand('logcat', { filter: 'a"b;c$(id)`' })
    expect(cmd).toBe(`logcat -v time -b main *:V | grep -F 'a"b;c$(id)\`'`)
  })

  test('logcat: an invalid tag is rejected before any command is built', () => {
    expect(() => buildMonitorCommand('logcat', { tag: 'bad tag!' })).toThrow(EnkakuError)
  })

  test('logcat: an invalid priority is rejected', () => {
    expect(() => buildMonitorCommand('logcat', { priority: 'DROP TABLE' })).toThrow(EnkakuError)
  })

  test('top: fixed command, no options accepted', () => {
    expect(buildMonitorCommand('top', {})).toBe('top -b -d 2')
    expect(() => buildMonitorCommand('top', { anything: true })).toThrow(EnkakuError)
  })

  test('thermal: a 5s loop over thermalservice and battery', () => {
    const cmd = buildMonitorCommand('thermal', {})
    expect(cmd).toContain('dumpsys thermalservice')
    expect(cmd).toContain('dumpsys battery')
    expect(cmd).toContain('sleep 5')
  })

  test('one-shot kinds: fixed commands', () => {
    expect(buildMonitorCommand('ps', {})).toBe('ps -A')
    expect(buildMonitorCommand('meminfo', {})).toBe('dumpsys meminfo')
    expect(buildMonitorCommand('df', {})).toBe('df -h')
  })

  test('an unknown kind never reaches this function — the type system enforces MonitorKindSchema at the boundary', () => {
    // @ts-expect-error — exercising the runtime guard for defence in depth,
    // in case a caller ever bypasses the Zod parse upstream.
    expect(() => buildMonitorCommand('shell', {})).toThrow()
  })
})
