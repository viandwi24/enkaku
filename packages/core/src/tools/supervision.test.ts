import { describe, expect, test } from 'bun:test'
import { detectSupervisionMode } from './supervision'

describe('detectSupervisionMode', () => {
  test('docker — /.dockerenv present wins regardless of INVOCATION_ID', () => {
    expect(detectSupervisionMode({ dockerEnvExists: () => true, env: {} })).toBe('docker')
    // Docker takes precedence even if INVOCATION_ID is somehow also set
    // (e.g. an operator's own image copies a host env file wholesale) —
    // the file check is the more structural signal.
    expect(detectSupervisionMode({ dockerEnvExists: () => true, env: { INVOCATION_ID: 'abc' } })).toBe('docker')
  })

  test('systemd — INVOCATION_ID set, no /.dockerenv', () => {
    expect(detectSupervisionMode({ dockerEnvExists: () => false, env: { INVOCATION_ID: '3f9b…' } })).toBe('systemd')
  })

  test('systemd is not mistaken for bare on an empty-string INVOCATION_ID', () => {
    // systemd always sets a real invocation id; an empty string is not a
    // real-world value, but the check is a plain truthiness test, and this
    // pins that an empty string is treated as "unset" — the safer default.
    expect(detectSupervisionMode({ dockerEnvExists: () => false, env: { INVOCATION_ID: '' } })).toBe('bare')
  })

  test('bare — neither signal present, the explicit default', () => {
    expect(detectSupervisionMode({ dockerEnvExists: () => false, env: {} })).toBe('bare')
  })

  test('defaults read the real fs/env when no deps are injected', () => {
    // Not asserting a specific mode here (that would depend on where the
    // test actually runs) — just proving the function does not throw and
    // returns one of the three real values when called with no overrides.
    const mode = detectSupervisionMode()
    expect(['docker', 'systemd', 'bare']).toContain(mode)
  })
})
