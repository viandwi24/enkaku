import { describe, expect, test } from 'bun:test'
import { JobSettingsSchema, type JobSettings, type RuntimeEnvelope } from '@enkaku/protocol'
import { computeRuntimeReadout } from './runtime-readout'

/**
 * Plan 98 §3.9 item 3, §5 step 98.8 — the Script-detail Runtime card's pure
 * logic, tested exactly like `video-quality.ts`'s own `profileRows` (no
 * React, no DOM): a resolver's output in, a labelled row list out.
 */

function farmWith(opts: {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number | null
  defaultMaxRssBytes?: number | null
  maxRssBytes?: number | null
}): JobSettings {
  const base = JobSettingsSchema.parse({})
  return {
    ...base,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? base.defaultTimeoutMs,
    maxTimeoutMs: opts.maxTimeoutMs !== undefined ? opts.maxTimeoutMs : base.maxTimeoutMs,
    memory: {
      ...base.memory,
      defaultMaxRssBytes: opts.defaultMaxRssBytes !== undefined ? opts.defaultMaxRssBytes : base.memory.defaultMaxRssBytes,
      maxRssBytes: opts.maxRssBytes !== undefined ? opts.maxRssBytes : base.memory.maxRssBytes,
    },
  }
}

const row = (rows: ReturnType<typeof computeRuntimeReadout>['rows'], label: string) => rows.find((r) => r.label === label)

describe('computeRuntimeReadout (plan 98 §3.9 item 3)', () => {
  test('a script that declares nothing: every field reads farm/default, never "script"', () => {
    const farm = farmWith({})
    const { rows } = computeRuntimeReadout(farm, null)
    expect(row(rows, 'Timeout')?.origin).toBe('farm')
    expect(row(rows, 'Memory limit')?.origin).toBe('default')
    expect(row(rows, 'Memory limit')?.value).toBe('No limit')
    expect(row(rows, 'Retries on a script failure')?.origin).toBe('default')
    expect(row(rows, 'Max concurrent (farm-wide)')?.origin).toBe('default')
    expect(row(rows, 'Max concurrent (farm-wide)')?.value).toBe('Unlimited')
    expect(row(rows, 'SDK contract major')?.origin).toBe('default')
    // No field is ever labelled "clamped" absent an actual clamp.
    expect(rows.every((r) => r.origin !== 'clamped')).toBe(true)
  })

  test('a script declaration under the farm ceiling: "script" origin, no clamp', () => {
    const farm = farmWith({ maxTimeoutMs: 600_000, maxRssBytes: 1024 * 1024 * 1024 })
    const script: RuntimeEnvelope = { timeoutMs: 120_000, maxRssBytes: 256 * 1024 * 1024 }
    const { rows, clamps } = computeRuntimeReadout(farm, script)
    expect(row(rows, 'Timeout')?.origin).toBe('script')
    expect(row(rows, 'Timeout')?.value).toBe('2 min')
    expect(row(rows, 'Memory limit')?.origin).toBe('script')
    expect(row(rows, 'Memory limit')?.enforcement).toBe('sampled')
    expect(clamps).toEqual([])
  })

  test('a script declaration OVER the farm ceiling: origin is "clamped", not "script" — the value shown is the CEILING, and the detail names both numbers', () => {
    const farm = farmWith({ maxTimeoutMs: 60_000 })
    const script: RuntimeEnvelope = { timeoutMs: 600_000 }
    const { resolved, rows } = computeRuntimeReadout(farm, script)
    expect(resolved.timeoutMs).toBe(60_000)
    const timeoutRow = row(rows, 'Timeout')
    expect(timeoutRow?.origin).toBe('clamped')
    expect(timeoutRow?.originLabel).toBe('clamped to the farm ceiling')
    expect(timeoutRow?.detail).toContain('10 min')
    expect(timeoutRow?.detail).toContain('1 min')
  })

  test('memory: a farm default with no script declaration reads "farm", not "default"', () => {
    const farm = farmWith({ defaultMaxRssBytes: 512 * 1024 * 1024 })
    const { rows } = computeRuntimeReadout(farm, null)
    const memRow = row(rows, 'Memory limit')
    expect(memRow?.origin).toBe('farm')
    expect(memRow?.value).toBe('512.0 MB')
    expect(memRow?.enforcement).toBe('sampled')
  })

  test('a clamp is never confused with an override refusal — this card only ever computes against a NULL override', () => {
    const farm = farmWith({ maxRssBytes: 100 * 1024 * 1024 })
    const script: RuntimeEnvelope = { maxRssBytes: 900 * 1024 * 1024 }
    const { resolved, clamps } = computeRuntimeReadout(farm, script)
    expect(resolved.maxRssBytes).toBe(100 * 1024 * 1024)
    expect(clamps.some((c) => c.field === 'maxRssBytes' && c.from === 'script')).toBe(true)
  })
})
