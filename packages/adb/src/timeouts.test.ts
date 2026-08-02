import { describe, expect, test } from 'bun:test'
import { AdbError } from './errors'
import { ADB_TIMEOUTS, MAX_EXEC_TIMEOUT_MS, resolveExecTimeout } from './timeouts'

describe('resolveExecTimeout', () => {
  test('defaults to the "default" profile when nothing is given', () => {
    expect(resolveExecTimeout()).toBe(ADB_TIMEOUTS.default)
  })

  test('looks up a named profile', () => {
    expect(resolveExecTimeout({ profile: 'probe' })).toBe(ADB_TIMEOUTS.probe)
    expect(resolveExecTimeout({ profile: 'inspectorDump' })).toBe(ADB_TIMEOUTS.inspectorDump)
  })

  test('an explicit timeoutMs wins over a profile', () => {
    expect(resolveExecTimeout({ profile: 'probe', timeoutMs: 9_999 })).toBe(9_999)
  })

  test('clamps anything above the ceiling', () => {
    expect(resolveExecTimeout({ timeoutMs: MAX_EXEC_TIMEOUT_MS + 1 })).toBe(MAX_EXEC_TIMEOUT_MS)
    expect(resolveExecTimeout({ timeoutMs: 10_000_000 })).toBe(MAX_EXEC_TIMEOUT_MS)
  })

  test('never clamps a value already at or under the ceiling', () => {
    expect(resolveExecTimeout({ timeoutMs: MAX_EXEC_TIMEOUT_MS })).toBe(MAX_EXEC_TIMEOUT_MS)
    expect(resolveExecTimeout({ timeoutMs: 1 })).toBe(1)
  })

  test('rejects 0', () => {
    expect(() => resolveExecTimeout({ timeoutMs: 0 })).toThrow(AdbError)
  })

  test('rejects a negative timeout', () => {
    expect(() => resolveExecTimeout({ timeoutMs: -1 })).toThrow(AdbError)
  })

  test('rejects NaN', () => {
    expect(() => resolveExecTimeout({ timeoutMs: Number.NaN })).toThrow(AdbError)
  })

  test('rejects Infinity', () => {
    expect(() => resolveExecTimeout({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow(AdbError)
  })

  test('the thrown error carries E_ADB_BAD_TIMEOUT', () => {
    try {
      resolveExecTimeout({ timeoutMs: 0 })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AdbError)
      expect((err as AdbError).code).toBe('E_ADB_BAD_TIMEOUT')
    }
  })
})
