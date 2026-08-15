import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { reconcileParams, summarizeApply } from './reconcile'

describe('reconcileParams — the flagship scenario (plan 95 §5 step 95.7 verifiable result)', () => {
  test('publish 1.0.0 with { videos }, then 1.1.0 adds a required region with no default: missing, blocking, names the field', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number' }, region: { type: 'string' } }, required: ['videos', 'region'] }
    const result = reconcileParams(schema, { videos: 30 })
    expect(result.blocking).toBe(true)
    expect(result.findings).toEqual([{ path: 'region', kind: 'missing', detail: 'is required by the current schema, is not set, and has no default to fall back to' }])
  })
})

describe('reconcileParams — no schema at all', () => {
  test('null/undefined pass the stored value through untouched, no findings, never blocking', () => {
    expect(reconcileParams(null, { anything: 'goes' })).toEqual({ value: { anything: 'goes' }, findings: [], blocking: false })
    expect(reconcileParams(undefined, { a: 1 })).toEqual({ value: { a: 1 }, findings: [], blocking: false })
  })
})

describe('reconcileParams — the six-row table, one test per row', () => {
  test('row 1 — present and valid: kept, no finding', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number', minimum: 1, maximum: 2000 } } }
    const result = reconcileParams(schema, { videos: 30 })
    expect(result).toEqual({ value: { videos: 30 }, findings: [], blocking: false })
  })

  test('row 2 — absent, schema declares it with a default: filled, no finding', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number', default: 30 } } }
    const result = reconcileParams(schema, {})
    expect(result).toEqual({ value: { videos: 30 }, findings: [], blocking: false })
  })

  test('row 3 — absent, schema declares it as REQUIRED with no default: missing, blocking', () => {
    const schema = { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
    const result = reconcileParams(schema, {})
    expect(result.blocking).toBe(true)
    expect(result.findings).toEqual([{ path: 'region', kind: 'missing', detail: 'is required by the current schema, is not set, and has no default to fall back to' }])
    expect((result.value as Record<string, unknown>).region).toBeUndefined()
  })

  test('row 3, refined — an OPTIONAL field absent with no default is NOT missing: no finding, never blocking', () => {
    const schema = { type: 'object', properties: { nickname: { type: 'string' } } } // not in `required`
    const result = reconcileParams(schema, {})
    expect(result).toEqual({ value: {}, findings: [], blocking: false })
  })

  test('row 4 — present but now invalid, schema has a default: reset, non-blocking', () => {
    const schema = { type: 'object', properties: { chance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 } } }
    const result = reconcileParams(schema, { chance: 5 }) // was valid under an older, wider bound
    expect(result.blocking).toBe(false)
    expect(result.findings).toEqual([{ path: 'chance', kind: 'reset', detail: 'no longer satisfies the current schema — reset to its default' }])
    expect(result.value).toEqual({ chance: 0.5 })
  })

  test('row 5 — present but now invalid, no default: invalid, blocking, the stale value is kept visible', () => {
    const schema = { type: 'object', properties: { region: { type: 'string', enum: ['us', 'eu'] } } }
    const result = reconcileParams(schema, { region: 'apac' }) // 'apac' used to be a valid member
    expect(result.blocking).toBe(true)
    expect(result.findings).toEqual([{ path: 'region', kind: 'invalid', detail: 'no longer satisfies the current schema, and there is no default to fall back to' }])
    expect(result.value).toEqual({ region: 'apac' })
  })

  test('row 6 — present, schema no longer declares it: removed, non-blocking, dropped from value', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number' } } }
    const result = reconcileParams(schema, { videos: 30, legacyPackage: 'com.example.app' })
    expect(result.blocking).toBe(false)
    expect(result.findings).toEqual([{ path: 'legacyPackage', kind: 'removed', detail: 'the current schema no longer declares this parameter' }])
    expect(result.value).toEqual({ videos: 30 })
  })
})

describe('reconcileParams — several findings at once', () => {
  test('missing + removed + reset all reported together, and any invalid/missing makes the whole result blocking', () => {
    const schema = {
      type: 'object',
      properties: {
        videos: { type: 'number', minimum: 1, maximum: 2000, default: 30 },
        region: { type: 'string' },
      },
      required: ['region'],
    }
    const result = reconcileParams(schema, { videos: 9999, oldField: 'x' })
    const kinds = result.findings.map((f) => f.kind).sort()
    expect(kinds).toEqual(['missing', 'removed', 'reset'])
    expect(result.blocking).toBe(true)
    expect(result.value).toEqual({ videos: 30 })
  })
})

describe('reconcileParams — reuses validateAgainstSchema rather than re-checking constraints itself', () => {
  test('an ordered-pair (tuple) constraint violation is one finding on the tuple path, not per element', () => {
    const schema = {
      type: 'object',
      properties: {
        window: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], default: [5, 20] },
      },
    }
    const result = reconcileParams(schema, { window: [20, 5] }) // lower bound greater than upper bound
    expect(result.findings).toEqual([{ path: 'window', kind: 'reset', detail: 'no longer satisfies the current schema — reset to its default' }])
    expect(result.value).toEqual({ window: [5, 20] })
  })

  test('a Zod-produced schema (z.toJSONSchema) reconciles the same way as a hand-built one', () => {
    const zodSchema = z.toJSONSchema(z.object({ videos: z.number().int().min(1).max(2000).default(30) }), { io: 'input' })
    const result = reconcileParams(zodSchema, { videos: 9999 })
    expect(result.findings).toEqual([{ path: 'videos', kind: 'reset', detail: 'no longer satisfies the current schema — reset to its default' }])
    expect(result.blocking).toBe(false)
  })
})

describe('reconcileParams — nested groups (K7 nesting)', () => {
  test('a nested z.object() is recursed into, not treated as one atomic field', () => {
    const schema = {
      type: 'object',
      properties: {
        retry: {
          type: 'object',
          properties: {
            backoffBaseMs: { type: 'number' },
            maxAttempts: { type: 'number' },
          },
          required: ['backoffBaseMs', 'maxAttempts'],
        },
      },
    }
    const result = reconcileParams(schema, { retry: { backoffBaseMs: 100 } }) // maxAttempts newly required, missing
    expect(result.blocking).toBe(true)
    expect(result.findings).toEqual([{ path: 'retry.maxAttempts', kind: 'missing', detail: 'is required by the current schema, is not set, and has no default to fall back to' }])
    expect(result.value).toEqual({ retry: { backoffBaseMs: 100 } })
  })

  test('a removed key inside a nested group is reported at its dotted path', () => {
    const schema = { type: 'object', properties: { retry: { type: 'object', properties: { maxAttempts: { type: 'number' } } } } }
    const result = reconcileParams(schema, { retry: { maxAttempts: 3, oldKnob: true } })
    expect(result.findings).toEqual([{ path: 'retry.oldKnob', kind: 'removed', detail: 'the current schema no longer declares this parameter' }])
  })
})

describe('reconcileParams — hostile input never hangs or throws', () => {
  test('a self-referential $ref cycle degrades to leaving the field as stored, no throw', () => {
    const schema = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } },
    }
    expect(() => reconcileParams(schema, { node: { next: { next: {} } } })).not.toThrow()
  })

  test('__proto__ as a stored key is ignored, not assigned, and the result has a plain, unpolluted prototype', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number' } } }
    const stored = JSON.parse('{"videos": 1, "__proto__": {"polluted": true}}')
    const result = reconcileParams(schema, stored)
    expect(result.findings.some((f) => f.path === '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('a non-object schema (edge case: an atomic top-level type) passes the stored value through, no throw', () => {
    expect(() => reconcileParams({ type: 'string' }, 'hello')).not.toThrow()
    expect(reconcileParams({ type: 'string' }, 'hello').blocking).toBe(false)
  })

  test('stored is null: treated as {} for reconciliation purposes, same as validateAgainstSchema', () => {
    const schema = { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
    const result = reconcileParams(schema, null)
    expect(result.blocking).toBe(true)
    expect(result.findings[0]?.kind).toBe('missing')
  })
})

describe('summarizeApply — the one-line preset report (plan 95 §4.4, §4.7, §5 step 95.8)', () => {
  test('nothing changed: says so explicitly rather than an empty panel', () => {
    expect(summarizeApply('Aggressive', [])).toBe("Applied 'Aggressive' — every setting still matches this version.")
  })

  test("the plan's own worked example, verbatim: one reset, one removed", () => {
    const findings = [
      { path: 'chance', kind: 'reset' as const, detail: 'x' },
      { path: 'legacyFlag', kind: 'removed' as const, detail: 'x' },
    ]
    expect(summarizeApply('Aggressive', findings)).toBe("Applied 'Aggressive' — 1 setting reset to its new default, 1 no longer exists.")
  })

  test('plurals: two reset, two removed', () => {
    const findings = [
      { path: 'a', kind: 'reset' as const, detail: 'x' },
      { path: 'b', kind: 'reset' as const, detail: 'x' },
      { path: 'c', kind: 'removed' as const, detail: 'x' },
      { path: 'd', kind: 'removed' as const, detail: 'x' },
    ]
    expect(summarizeApply('Aggressive', findings)).toBe("Applied 'Aggressive' — 2 settings reset to their new default, 2 no longer exist.")
  })

  test('blocking findings (missing/invalid) are collapsed into one "needs a value" clause — not surfaced as two different codes', () => {
    const findings = [
      { path: 'region', kind: 'missing' as const, detail: 'x' },
      { path: 'videos', kind: 'invalid' as const, detail: 'x' },
    ]
    expect(summarizeApply('Aggressive', findings)).toBe("Applied 'Aggressive' — 2 need a value before you can run.")
  })

  test('a single blocking finding uses the singular verb', () => {
    const findings = [{ path: 'region', kind: 'missing' as const, detail: 'x' }]
    expect(summarizeApply('Aggressive', findings)).toBe("Applied 'Aggressive' — 1 needs a value before you can run.")
  })

  test('every clause combines when every kind is present, in a stable order', () => {
    const findings = [
      { path: 'a', kind: 'reset' as const, detail: 'x' },
      { path: 'b', kind: 'removed' as const, detail: 'x' },
      { path: 'c', kind: 'missing' as const, detail: 'x' },
    ]
    expect(summarizeApply('Aggressive', findings)).toBe(
      "Applied 'Aggressive' — 1 setting reset to its new default, 1 no longer exists, 1 needs a value before you can run.",
    )
  })
})
