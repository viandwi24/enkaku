import { describe, expect, test } from 'bun:test'
import { JobSettingsSchema, type JobSettings } from './settings'
import {
  RuntimeEnvelopeSchema,
  SCRIPT_RUNTIME_MAJOR,
  SCRIPT_RUNTIME_MIN_MAJOR,
  checkRuntimeMajor,
  resolveRuntime,
  unknownRuntimeKeys,
  type RuntimeClamp,
  type RuntimeEnvelope,
} from './runtime-envelope'

/** A real, schema-defaulted `JobSettings`, with just the four fields `resolveRuntime` reads overridden. */
function farmWith(opts: { defaultTimeoutMs?: number | null; maxTimeoutMs?: number | null; defaultMaxRssBytes?: number | null; maxRssBytes?: number | null }): JobSettings {
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

describe('RuntimeEnvelopeSchema — bounds (plan 98 §4.1)', () => {
  test('every field is optional — an empty object is valid, matching "no row at all"', () => {
    expect(RuntimeEnvelopeSchema.safeParse({}).success).toBe(true)
  })

  test('sdk is bounded to [1, 999]', () => {
    expect(RuntimeEnvelopeSchema.safeParse({ sdk: 1 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ sdk: 999 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ sdk: 0 }).success).toBe(false)
    expect(RuntimeEnvelopeSchema.safeParse({ sdk: 1000 }).success).toBe(false)
  })

  test('timeoutMs is bounded to [1_000, 86_400_000]', () => {
    expect(RuntimeEnvelopeSchema.safeParse({ timeoutMs: 1_000 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ timeoutMs: 86_400_000 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ timeoutMs: 999 }).success).toBe(false)
    expect(RuntimeEnvelopeSchema.safeParse({ timeoutMs: 86_400_001 }).success).toBe(false)
  })

  test('retries is bounded to [0, 10]', () => {
    expect(RuntimeEnvelopeSchema.safeParse({ retries: 0 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ retries: 10 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ retries: -1 }).success).toBe(false)
    expect(RuntimeEnvelopeSchema.safeParse({ retries: 11 }).success).toBe(false)
  })

  test('maxRssBytes is bounded to [64 MiB, 16 GiB]', () => {
    expect(RuntimeEnvelopeSchema.safeParse({ maxRssBytes: 64 * 1024 * 1024 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ maxRssBytes: 16 * 1024 * 1024 * 1024 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ maxRssBytes: 64 * 1024 * 1024 - 1 }).success).toBe(false)
    expect(RuntimeEnvelopeSchema.safeParse({ maxRssBytes: 16 * 1024 * 1024 * 1024 + 1 }).success).toBe(false)
  })

  test('maxConcurrent is bounded to [0, 1_000], 0 meaning unlimited', () => {
    expect(RuntimeEnvelopeSchema.safeParse({ maxConcurrent: 0 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ maxConcurrent: 1_000 }).success).toBe(true)
    expect(RuntimeEnvelopeSchema.safeParse({ maxConcurrent: -1 }).success).toBe(false)
    expect(RuntimeEnvelopeSchema.safeParse({ maxConcurrent: 1_001 }).success).toBe(false)
  })
})

describe('unknownRuntimeKeys / RuntimeEnvelopeSchema — S3: append-only, never fatal (plan 98 §3.3)', () => {
  test('an unknown key is stripped by the schema, not rejected — parsing never throws', () => {
    const raw = { timeoutMs: 60_000, futureField: 'from a newer SDK' }
    const parsed = RuntimeEnvelopeSchema.parse(raw)
    expect(parsed).toEqual({ timeoutMs: 60_000 })
    expect('futureField' in parsed).toBe(false)
  })

  test('unknownRuntimeKeys reports exactly the extra field(s), separately from the strip', () => {
    expect(unknownRuntimeKeys({ timeoutMs: 60_000, futureField: 'x' })).toEqual(['futureField'])
    expect(unknownRuntimeKeys({ maxRssBytes: 1, oneMore: 1, andAnother: 1 }).sort()).toEqual(['andAnother', 'oneMore'])
  })

  test('a fully known envelope reports no unknown keys', () => {
    expect(unknownRuntimeKeys({ sdk: 1, timeoutMs: 1_000, retries: 0, maxRssBytes: 67_108_864, maxConcurrent: 0 })).toEqual([])
  })

  test('a script declaring only an unknown field still parses to an empty (fully defaulted) envelope — it runs, it does not refuse', () => {
    const parsed = RuntimeEnvelopeSchema.safeParse({ someBrandNewField: true })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({})
  })

  test('total: never throws on non-object input', () => {
    expect(unknownRuntimeKeys(null)).toEqual([])
    expect(unknownRuntimeKeys(undefined)).toEqual([])
    expect(unknownRuntimeKeys('not an object')).toEqual([])
    expect(unknownRuntimeKeys(42)).toEqual([])
    expect(unknownRuntimeKeys([1, 2, 3])).toEqual([])
    expect(unknownRuntimeKeys({})).toEqual([])
  })
})

describe('checkRuntimeMajor — S1 (plan 98 §3.3)', () => {
  test('absent (a script published before this plan) is treated as major 1 — always in range today', () => {
    expect(checkRuntimeMajor(undefined)).toBeNull()
  })

  test('exactly SCRIPT_RUNTIME_MAJOR is in range', () => {
    expect(checkRuntimeMajor(SCRIPT_RUNTIME_MAJOR)).toBeNull()
  })

  test('exactly SCRIPT_RUNTIME_MIN_MAJOR is in range', () => {
    expect(checkRuntimeMajor(SCRIPT_RUNTIME_MIN_MAJOR)).toBeNull()
  })

  test('below the floor is refused, naming the declared major and the supported range', () => {
    const result = checkRuntimeMajor(SCRIPT_RUNTIME_MIN_MAJOR - 1)
    expect(result).not.toBeNull()
    expect(result?.code).toBe('E_RUNTIME_UNSUPPORTED')
    expect(result?.message).toContain(String(SCRIPT_RUNTIME_MIN_MAJOR - 1))
  })

  test('above the current major is refused', () => {
    const result = checkRuntimeMajor(SCRIPT_RUNTIME_MAJOR + 1)
    expect(result).not.toBeNull()
    expect(result?.code).toBe('E_RUNTIME_UNSUPPORTED')
    expect(result?.message).toContain(String(SCRIPT_RUNTIME_MAJOR + 1))
  })
})

/** One row of the timeoutMs precedence-and-clamp table — `timeoutMs` never resolves to null (§7's "every combination"). */
interface TimeoutRow {
  label: string
  farmDefault: number
  script?: number
  override?: number
  ceiling: number | null
  expected: number
  clampFrom: RuntimeClamp['from'] | null
}

/** The same shape, but for `maxRssBytes`, whose farm default and resolved value are both nullable. */
interface RssRow {
  label: string
  farmDefault: number | null
  script?: number
  override?: number
  ceiling: number | null
  expected: number | null
  clampFrom: RuntimeClamp['from'] | null
}

describe('resolveRuntime — timeoutMs precedence and clamp table (plan 98 §3.8)', () => {
  const D = 3_600_000 // farm default
  const S = 5_000_000 // script declaration — above the ceiling below
  const O = 2_000_000 // job override — under the ceiling below
  const O_OVER = 6_000_000 // a second override value, above the ceiling
  const C = 4_000_000 // farm ceiling

  const rows: TimeoutRow[] = [
    { label: 'farm default only, no ceiling', farmDefault: D, ceiling: null, expected: D, clampFrom: null },
    { label: 'farm default only, ceiling above it — unaffected', farmDefault: D, ceiling: C, expected: D, clampFrom: null },
    { label: 'farm default only, ceiling BELOW it — clamped silently (operator misconfigured their own two settings)', farmDefault: S, ceiling: C, expected: C, clampFrom: null },
    { label: 'script only, under ceiling', farmDefault: D, script: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'script only, over ceiling — clamped and named', farmDefault: D, script: S, ceiling: C, expected: C, clampFrom: 'script' },
    { label: 'script only, no ceiling at all — honoured however large', farmDefault: D, script: S, ceiling: null, expected: S, clampFrom: null },
    { label: 'override only, under ceiling', farmDefault: D, override: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'override only, over ceiling — clamped and named', farmDefault: D, override: O_OVER, ceiling: C, expected: C, clampFrom: 'override' },
    { label: 'override only, no ceiling at all', farmDefault: D, override: O_OVER, ceiling: null, expected: O_OVER, clampFrom: null },
    { label: 'script AND override present, override (under ceiling) wins over script (which would have been clamped)', farmDefault: D, script: S, override: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'script AND override present, override itself over ceiling — override still wins precedence, then gets clamped', farmDefault: D, script: O, override: O_OVER, ceiling: C, expected: C, clampFrom: 'override' },
    { label: 'script AND override present, no ceiling — override always wins regardless of script', farmDefault: D, script: S, override: O, ceiling: null, expected: O, clampFrom: null },
  ]

  for (const row of rows) {
    test(row.label, () => {
      const farm = farmWith({ defaultTimeoutMs: row.farmDefault, maxTimeoutMs: row.ceiling })
      const script: RuntimeEnvelope | null = row.script === undefined ? null : { timeoutMs: row.script }
      const override: RuntimeEnvelope | null = row.override === undefined ? null : { timeoutMs: row.override }
      const { resolved, clamps } = resolveRuntime({ farm, script, override })

      expect(resolved.timeoutMs).toBe(row.expected)
      if (row.clampFrom === null) {
        expect(clamps).toEqual([])
      } else {
        expect(clamps).toHaveLength(1)
        expect(clamps[0]).toMatchObject({ field: 'timeoutMs', ceiling: row.ceiling, from: row.clampFrom })
      }
    })
  }
})

describe('resolveRuntime — maxRssBytes precedence and clamp table (plan 98 §3.8) — nullable farm default', () => {
  const S = 1_073_741_824 // 1 GiB — above the ceiling below
  const O = 268_435_456 // 256 MiB — under the ceiling below
  const O_OVER = 2_147_483_648 // 2 GiB — above the ceiling below
  const C = 536_870_912 // 512 MiB farm ceiling

  const rows: RssRow[] = [
    { label: 'nothing declared anywhere, no ceiling — no limit at all', farmDefault: null, ceiling: null, expected: null, clampFrom: null },
    { label: 'nothing declared anywhere, ceiling set — the ceiling never manufactures a value', farmDefault: null, ceiling: C, expected: null, clampFrom: null },
    { label: 'farm default only, no ceiling', farmDefault: C, ceiling: null, expected: C, clampFrom: null },
    { label: 'farm default only, ceiling ABOVE it — unaffected', farmDefault: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'farm default only, ceiling BELOW it — clamped silently', farmDefault: S, ceiling: C, expected: C, clampFrom: null },
    { label: 'script only, under ceiling', farmDefault: null, script: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'script only, over ceiling — clamped and named', farmDefault: null, script: S, ceiling: C, expected: C, clampFrom: 'script' },
    { label: 'script only, no ceiling — honoured however large', farmDefault: null, script: S, ceiling: null, expected: S, clampFrom: null },
    { label: 'override only, under ceiling', farmDefault: null, override: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'override only, over ceiling — clamped and named', farmDefault: null, override: O_OVER, ceiling: C, expected: C, clampFrom: 'override' },
    { label: 'script AND override present, override (under ceiling) wins over script (which would have been clamped)', farmDefault: null, script: S, override: O, ceiling: C, expected: O, clampFrom: null },
    { label: 'script AND override present, override itself over ceiling — override wins precedence, then gets clamped', farmDefault: null, script: O, override: O_OVER, ceiling: C, expected: C, clampFrom: 'override' },
  ]

  for (const row of rows) {
    test(row.label, () => {
      const farm = farmWith({ defaultMaxRssBytes: row.farmDefault, maxRssBytes: row.ceiling })
      const script: RuntimeEnvelope | null = row.script === undefined ? null : { maxRssBytes: row.script }
      const override: RuntimeEnvelope | null = row.override === undefined ? null : { maxRssBytes: row.override }
      const { resolved, clamps } = resolveRuntime({ farm, script, override })

      expect(resolved.maxRssBytes).toBe(row.expected)
      if (row.clampFrom === null) {
        expect(clamps).toEqual([])
      } else {
        expect(clamps).toHaveLength(1)
        expect(clamps[0]).toMatchObject({ field: 'maxRssBytes', ceiling: row.ceiling, from: row.clampFrom })
      }
    })
  }
})

describe('resolveRuntime — retries / maxConcurrent / sdk: no farm default or ceiling layer (plan 98 §3.7, §4.1)', () => {
  test('retries: override ?? script ?? 0', () => {
    const farm = JobSettingsSchema.parse({})
    expect(resolveRuntime({ farm, script: null, override: null }).resolved.retries).toBe(0)
    expect(resolveRuntime({ farm, script: { retries: 3 }, override: null }).resolved.retries).toBe(3)
    expect(resolveRuntime({ farm, script: { retries: 3 }, override: { retries: 5 } }).resolved.retries).toBe(5)
    expect(resolveRuntime({ farm, script: null, override: { retries: 2 } }).resolved.retries).toBe(2)
  })

  test('maxConcurrent: override ?? script ?? 0 (unlimited)', () => {
    const farm = JobSettingsSchema.parse({})
    expect(resolveRuntime({ farm, script: null, override: null }).resolved.maxConcurrent).toBe(0)
    expect(resolveRuntime({ farm, script: { maxConcurrent: 1 }, override: null }).resolved.maxConcurrent).toBe(1)
    expect(resolveRuntime({ farm, script: { maxConcurrent: 1 }, override: { maxConcurrent: 4 } }).resolved.maxConcurrent).toBe(4)
  })

  test('sdk: override ?? script ?? SCRIPT_RUNTIME_MAJOR', () => {
    const farm = JobSettingsSchema.parse({})
    expect(resolveRuntime({ farm, script: null, override: null }).resolved.sdk).toBe(SCRIPT_RUNTIME_MAJOR)
    expect(resolveRuntime({ farm, script: { sdk: 1 }, override: null }).resolved.sdk).toBe(1)
  })

  test('neither field ever produces a clamp — RuntimeClamp.field only ever names timeoutMs/maxRssBytes', () => {
    const farm = JobSettingsSchema.parse({})
    const { clamps } = resolveRuntime({ farm, script: { retries: 10, maxConcurrent: 1_000 }, override: null })
    expect(clamps).toEqual([])
  })
})

describe('resolveRuntime — backward compatibility is total (plan 98 §3.1, acceptance criterion 2)', () => {
  test('script: null, override: null resolves to exactly today\'s farm defaults, with zero clamps', () => {
    const farm = JobSettingsSchema.parse({})
    const { resolved, clamps } = resolveRuntime({ farm, script: null, override: null })
    expect(resolved).toEqual({
      timeoutMs: farm.defaultTimeoutMs,
      retries: 0,
      maxRssBytes: null,
      maxConcurrent: 0,
      sdk: SCRIPT_RUNTIME_MAJOR,
    })
    expect(clamps).toEqual([])
  })

  test('an empty declared envelope ({}) behaves identically to no row at all (null)', () => {
    const farm = JobSettingsSchema.parse({})
    const withNull = resolveRuntime({ farm, script: null, override: null })
    const withEmpty = resolveRuntime({ farm, script: {}, override: {} })
    expect(withEmpty.resolved).toEqual(withNull.resolved)
    expect(withEmpty.clamps).toEqual(withNull.clamps)
  })
})
