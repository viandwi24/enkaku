import { describe, expect, test } from 'bun:test'
import { parseExitMarker, withExitMarker } from './exit-marker'

describe('withExitMarker (plan 26 §3.5)', () => {
  test('appends a `;`-separated printf that always runs, regardless of the command\'s own success', () => {
    expect(withExitMarker('echo hi')).toBe("echo hi ; printf '\\n__ENKAKU_EXIT__%d' $?")
  })
})

describe('parseExitMarker (plan 26 §3.5, §7 "present, absent, and split across chunk boundaries")', () => {
  test('present: strips the trailing marker line and reports the exit code', () => {
    const raw = 'hi\n__ENKAKU_EXIT__0'
    expect(parseExitMarker(raw)).toEqual({ stdout: 'hi', exitCode: 0 })
  })

  test('present with a non-zero code (e.g. `false`)', () => {
    expect(parseExitMarker('__ENKAKU_EXIT__1')).toEqual({ stdout: '', exitCode: 1 })
  })

  test('present with multi-line output preserves every line except the marker', () => {
    const raw = 'line one\nline two\nline three\n__ENKAKU_EXIT__0'
    expect(parseExitMarker(raw)).toEqual({ stdout: 'line one\nline two\nline three', exitCode: 0 })
  })

  test('empty output before the marker yields an empty stdout, not a stray newline', () => {
    expect(parseExitMarker('\n__ENKAKU_EXIT__0')).toEqual({ stdout: '', exitCode: 0 })
  })

  test('absent: reports exitCode null and returns the raw text unchanged (a killed shell)', () => {
    expect(parseExitMarker('some partial output, no marker')).toEqual({
      stdout: 'some partial output, no marker',
      exitCode: null,
    })
  })

  test('absent: output truncated mid-marker is not mistaken for a match', () => {
    expect(parseExitMarker('hi\n__ENKAKU_EX')).toEqual({ stdout: 'hi\n__ENKAKU_EX', exitCode: null })
  })

  test('the marker string appearing mid-output (not as the final line) is not treated as the exit marker', () => {
    const raw = '__ENKAKU_EXIT__0 was printed by the app itself\nmore output'
    expect(parseExitMarker(raw)).toEqual({ stdout: raw, exitCode: null })
  })

  test('split across chunk boundaries: correct regardless of how the string was assembled before parsing', () => {
    // `AdbClient.exec` hands back one fully-assembled string — parseExitMarker
    // never sees partial chunks itself — but the result must not depend on
    // how that string was built up beforehand.
    const assembled = ['out', 'put\n', '__ENKAKU_EXIT', '__42'].join('')
    expect(parseExitMarker(assembled)).toEqual({ stdout: 'output', exitCode: 42 })
  })
})
