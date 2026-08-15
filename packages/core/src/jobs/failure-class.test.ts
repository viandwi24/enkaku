import { describe, expect, test } from 'bun:test'
import { classifyFailure } from './failure-class'

const err = (code: string, message = 'x') => ({ code, message })

describe('classifyFailure — the infra table (plan 36 §3.2, §4.1)', () => {
  const infraCodes = [
    'E_ADB_TIMEOUT',
    'E_ADB_CONNECT_TIMEOUT',
    'E_ADB_HANDSHAKE_TIMEOUT',
    'E_ADB_UNAVAILABLE',
    'E_DEVICE_NOT_READY',
    'node_offline',
    'device_not_found',
    'device_not_ready',
    'engine_not_found',
    'port_range_exhausted',
    'CHILD_CRASHED',
    'DEVICE_DISCONNECTED',
    'LEASE_FORCE_RELEASED',
    'SESSION_ACQUIRE_FAILED',
  ]

  for (const code of infraCodes) {
    test(`${code} classifies infra and blames the device`, () => {
      const result = classifyFailure(err(code), { timeoutIsInfra: false })
      expect(result.class).toBe('infra')
      expect(result.blameDevice).toBe(true)
      expect(result.code).toBe(code)
    })
  }
})

describe('classifyFailure — load is not infra (plan 22.1 §3.1, plan 23 §3.6, acceptance #5)', () => {
  test('E_ADB_BUSY classifies load, retries, but never blames the device', () => {
    const result = classifyFailure(err('E_ADB_BUSY'), { timeoutIsInfra: false })
    expect(result.class).toBe('load')
    expect(result.blameDevice).toBe(false)
  })
})

describe('classifyFailure — script-class codes (the result, not the farm\'s problem)', () => {
  const scriptCodes = [
    'SCRIPT_ERROR',
    'PARAMS_INVALID',
    'BAD_BUNDLE',
    'CANCELLED',
    'RESET_FAILED',
    'RUNNER_FAILED',
    'NOT_RUN',
    'DEVICE_CALL_FAILED',
    'ARTIFACT_FAILED',
    'BAD_CALL',
    'element_not_found',
    'waitfor_timeout',
    'artifact_too_large',
    'unknown_script',
    'ABORTED',
    // adb codes that are caller-side outcomes or proof the device DID
    // answer (plan 23 §3.6's own exclusion list) — not in the plan 36 §3.2
    // infra table either, so they fall to the honest default.
    'E_ADB_FAIL',
    'E_ADB_PROTOCOL',
    'E_ADB_OUTPUT_LIMIT',
    'E_ADB_ABORTED',
    'E_ADB_BAD_TIMEOUT',
    'E_ADB_STREAM_LIMIT',
    'E_ADB_STREAM_IDLE',
    'E_ADB_STREAM_DEADLINE',
    // plan 37 §4.4, acceptance #10 — a crash is a result, not a farm fault.
    'APP_CRASHED',
    // plan 98 §3.6 — a script that blew its own declared memory budget is
    // likewise a result, never the farm's fault.
    'MEMORY_LIMIT',
  ]

  for (const code of scriptCodes) {
    test(`${code} classifies script and never blames the device`, () => {
      const result = classifyFailure(err(code), { timeoutIsInfra: false })
      expect(result.class).toBe('script')
      expect(result.blameDevice).toBe(false)
      expect(result.code).toBe(code)
    })
  }
})

describe('classifyFailure — an unknown code defaults to script (acceptance #9)', () => {
  test('a code the table has never seen classifies script, not infra', () => {
    const result = classifyFailure(err('TOTALLY_MADE_UP_CODE'), { timeoutIsInfra: false })
    expect(result.class).toBe('script')
    expect(result.blameDevice).toBe(false)
  })

  test('a plain Error with no .code at all also classifies script', () => {
    const result = classifyFailure(new Error('boom'), { timeoutIsInfra: false })
    expect(result.class).toBe('script')
    expect(result.blameDevice).toBe(false)
    expect(result.code).toBe('UNKNOWN')
  })

  test('a non-object thrown value classifies script', () => {
    const result = classifyFailure('a bare string throw', { timeoutIsInfra: false })
    expect(result.class).toBe('script')
    expect(result.code).toBe('UNKNOWN')
  })
})

describe('classifyFailure — TIMEOUT is configurable (plan 36 §3.3)', () => {
  test('by default a job timeout classifies script (the common case: a real regression)', () => {
    const result = classifyFailure(err('TIMEOUT'), { timeoutIsInfra: false })
    expect(result.class).toBe('script')
    expect(result.blameDevice).toBe(false)
  })

  test('with timeoutIsInfra: true, a job timeout classifies infra and blames the device', () => {
    const result = classifyFailure(err('TIMEOUT'), { timeoutIsInfra: true })
    expect(result.class).toBe('infra')
    expect(result.blameDevice).toBe(true)
  })
})
