import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ui } from './vocabulary'
import { validateAgainstSchema } from './validate'

describe('validateAgainstSchema — the flagship case (plan 95 §5 step 95.6 verifiable result)', () => {
  test('{ videos: 9999 } against max(2000) is rejected with the exact path and message the plan names', () => {
    const schema = z.toJSONSchema(z.object({ videos: z.number().int().min(1).max(2000) }))
    const result = validateAgainstSchema(schema, { videos: 9999 })
    expect(result).toEqual({ ok: false, issues: [{ path: 'videos', message: 'must be at most 2000' }] })
  })

  test('a value inside the bound is accepted', () => {
    const schema = z.toJSONSchema(z.object({ videos: z.number().int().min(1).max(2000) }))
    expect(validateAgainstSchema(schema, { videos: 30 })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — no schema at all', () => {
  test('null and undefined always pass — a script with no declared params has nothing to violate', () => {
    expect(validateAgainstSchema(null, { anything: 'goes' })).toEqual({ ok: true })
    expect(validateAgainstSchema(undefined, {})).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — required', () => {
  const schema = z.toJSONSchema(z.object({ name: z.string() }))

  test('a missing required field is reported at its own path', () => {
    expect(validateAgainstSchema(schema, {})).toEqual({ ok: false, issues: [{ path: 'name', message: 'required' }] })
  })

  test('an omitted OPTIONAL field is not an error', () => {
    const optional = z.toJSONSchema(z.object({ name: z.string(), nickname: z.string().optional() }))
    expect(validateAgainstSchema(optional, { name: 'a' })).toEqual({ ok: true })
  })

  test('a null or undefined value passed in for the whole params object is treated as {}', () => {
    expect(validateAgainstSchema(schema, undefined)).toEqual({ ok: false, issues: [{ path: 'name', message: 'required' }] })
    expect(validateAgainstSchema(schema, null)).toEqual({ ok: false, issues: [{ path: 'name', message: 'required' }] })
  })

  test('nested object required fields report a dotted path', () => {
    const nested = z.toJSONSchema(z.object({ retry: z.object({ backoffBaseMs: z.number() }) }))
    expect(validateAgainstSchema(nested, { retry: {} })).toEqual({
      ok: false,
      issues: [{ path: 'retry.backoffBaseMs', message: 'required' }],
    })
  })
})

describe('validateAgainstSchema — type checks', () => {
  test('a string given where a number is declared is rejected', () => {
    const schema = z.toJSONSchema(z.object({ n: z.number() }))
    const result = validateAgainstSchema(schema, { n: 'nope' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.issues[0]?.path).toBe('n')
  })

  test('a boolean field accepts true/false and rejects anything else', () => {
    const schema = z.toJSONSchema(z.object({ b: z.boolean() }))
    expect(validateAgainstSchema(schema, { b: true })).toEqual({ ok: true })
    expect(validateAgainstSchema(schema, { b: 'true' }).ok).toBe(false)
  })
})

describe('validateAgainstSchema — F5: ±MAX_SAFE_INTEGER sentinels are unbounded, not real limits', () => {
  test('a bare z.number().int() with no explicit bounds accepts a very large or very negative integer', () => {
    const schema = z.toJSONSchema(z.object({ n: z.number().int() }))
    expect(validateAgainstSchema(schema, { n: 5_000_000_000 })).toEqual({ ok: true })
    expect(validateAgainstSchema(schema, { n: -5_000_000_000 })).toEqual({ ok: true })
  })

  test('an explicit, non-sentinel bound is still enforced', () => {
    const schema = z.toJSONSchema(z.object({ n: z.number().int().max(10) }))
    expect(validateAgainstSchema(schema, { n: 11 }).ok).toBe(false)
  })
})

describe('validateAgainstSchema — multipleOf', () => {
  test('a value not on the step is rejected', () => {
    const schema = z.toJSONSchema(z.object({ n: z.number().multipleOf(5) }))
    expect(validateAgainstSchema(schema, { n: 7 }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { n: 15 })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — enum', () => {
  test('a value outside the enum is rejected and the message lists the choices', () => {
    const schema = z.toJSONSchema(z.object({ order: z.enum(['as-listed', 'random']) }))
    const result = validateAgainstSchema(schema, { order: 'shuffled' })
    expect(result).toEqual({ ok: false, issues: [{ path: 'order', message: 'choose one of: as-listed, random' }] })
  })

  test('a value inside the enum passes', () => {
    const schema = z.toJSONSchema(z.object({ order: z.enum(['as-listed', 'random']) }))
    expect(validateAgainstSchema(schema, { order: 'random' })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — ordered pairs (a 2-number tuple is an interval, plan 95 §3.2)', () => {
  test('a reversed pair is rejected by default (ordered defaults true)', () => {
    const schema = z.toJSONSchema(z.object({ intervalMs: z.tuple([z.number(), z.number()]) }))
    const result = validateAgainstSchema(schema, { intervalMs: [20, 5] })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.issues[0]?.path).toBe('intervalMs')
  })

  test('a correctly ordered pair passes', () => {
    const schema = z.toJSONSchema(z.object({ intervalMs: z.tuple([z.number(), z.number()]) }))
    expect(validateAgainstSchema(schema, { intervalMs: [5, 20] })).toEqual({ ok: true })
  })

  test('ordered: false opts out — a reversed pair is accepted', () => {
    const schema = z.toJSONSchema(
      z.object({ intervalMs: z.tuple([z.number(), z.number()]).meta(ui({ title: 'Interval', ordered: false })) }),
    )
    expect(validateAgainstSchema(schema, { intervalMs: [20, 5] })).toEqual({ ok: true })
  })

  test('wrong arity on a tuple is rejected', () => {
    const schema = z.toJSONSchema(z.object({ intervalMs: z.tuple([z.number(), z.number()]) }))
    expect(validateAgainstSchema(schema, { intervalMs: [1, 2, 3] }).ok).toBe(false)
  })
})

describe('validateAgainstSchema — arrays', () => {
  test('minItems/maxItems are enforced', () => {
    const schema = z.toJSONSchema(z.object({ tags: z.array(z.string()).min(1).max(2) }))
    expect(validateAgainstSchema(schema, { tags: [] }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { tags: ['a', 'b', 'c'] }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { tags: ['a'] })).toEqual({ ok: true })
  })

  test('each element is checked against the item schema, at an indexed path', () => {
    const schema = z.toJSONSchema(z.object({ tags: z.array(z.string().min(3)) }))
    const result = validateAgainstSchema(schema, { tags: ['ok', 'x'] })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.issues.map((i) => i.path)).toEqual(['tags[0]', 'tags[1]'])
  })
})

describe('validateAgainstSchema — format (Enkaku-owned parsers, not an author regex)', () => {
  test('email', () => {
    const schema = z.toJSONSchema(z.object({ e: z.email() }))
    expect(validateAgainstSchema(schema, { e: 'not-an-email' }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { e: 'a@b.com' })).toEqual({ ok: true })
  })

  test('uri', () => {
    const schema = z.toJSONSchema(z.object({ u: z.url() }))
    expect(validateAgainstSchema(schema, { u: 'not a url' }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { u: 'https://example.com' })).toEqual({ ok: true })
  })

  test('date-time', () => {
    const schema = z.toJSONSchema(z.object({ t: z.iso.datetime() }))
    expect(validateAgainstSchema(schema, { t: 'not-a-date' }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { t: '2026-01-01T00:00:00Z' })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — kind: packageName (§3.8: replaces what `pattern` used to express)', () => {
  const schema = z.toJSONSchema(z.object({ pkg: z.string().meta(ui({ title: 'Package', kind: 'packageName' })) }))

  test('a bare word with no dot is rejected', () => {
    expect(validateAgainstSchema(schema, { pkg: 'tiktok' }).ok).toBe(false)
  })

  test('a reverse-domain id passes', () => {
    expect(validateAgainstSchema(schema, { pkg: 'com.zhiliaoapp.musically' })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — kind: chance (§3.2, §4.3): the [0,1] domain is enforced independent of minimum/maximum', () => {
  test('a chance outside [0,1] is rejected even on a schema with no explicit bounds', () => {
    const schema = z.toJSONSchema(z.object({ saveChance: z.number().meta(ui({ title: 'Save chance', kind: 'chance' })) }))
    expect(validateAgainstSchema(schema, { saveChance: 1.5 }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { saveChance: -0.1 }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { saveChance: 0.5 })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — pattern is NEVER evaluated (§3.8, R2, acceptance criterion 8)', () => {
  test('a value that violates `pattern` is accepted — only Enkaku-owned checks (format, kind) run', () => {
    const schema = { type: 'object', properties: { code: { type: 'string', pattern: '^[0-9]+$' } }, required: ['code'] }
    expect(validateAgainstSchema(schema, { code: 'not-numeric-at-all' })).toEqual({ ok: true })
  })

  test('no `new RegExp` runs over a schema-derived string — a repo grep proves it (acceptance criterion 8)', () => {
    // A catastrophic-backtracking pattern must not even be attempted.
    const evil = { type: 'object', properties: { x: { type: 'string', pattern: '^(a+)+$' } } }
    const start = performance.now()
    validateAgainstSchema(evil, { x: 'a'.repeat(40) + '!' })
    expect(performance.now() - start).toBeLessThan(50)
  })
})

describe('validateAgainstSchema — $ref safety (F21, R1)', () => {
  test('a self-referential $ref does not hang and does not falsely reject', () => {
    const cyclical = {
      type: 'object',
      properties: { next: { $ref: '#/$defs/__schema0' } },
      $defs: { __schema0: { type: 'object', properties: { next: { $ref: '#/$defs/__schema0' } } } },
    }
    const start = performance.now()
    const result = validateAgainstSchema(cyclical, { next: { next: {} } })
    expect(performance.now() - start).toBeLessThan(50)
    expect(result.ok).toBe(true)
  })

  test('a real (non-cyclical) $ref resolves and validates normally', () => {
    const Shared = z.object({ n: z.number().max(5) })
    const schema = z.toJSONSchema(z.object({ a: Shared, b: Shared }))
    expect(validateAgainstSchema(schema, { a: { n: 1 }, b: { n: 1 } })).toEqual({ ok: true })
    const result = validateAgainstSchema(schema, { a: { n: 1 }, b: { n: 99 } })
    expect(result.ok).toBe(false)
  })
})

describe('validateAgainstSchema — nullable unwrapping', () => {
  test('a nullable field accepts null and validates the non-null branch otherwise', () => {
    const schema = z.toJSONSchema(z.object({ n: z.number().max(5).nullable() }))
    expect(validateAgainstSchema(schema, { n: null })).toEqual({ ok: true })
    expect(validateAgainstSchema(schema, { n: 99 }).ok).toBe(false)
    expect(validateAgainstSchema(schema, { n: 3 })).toEqual({ ok: true })
  })
})

describe('validateAgainstSchema — what it deliberately does not check (§3.6, §4.3)', () => {
  test('a .refine() constraint is invisible to the validator — the JSON Schema it reads never carried it', () => {
    // z.toJSONSchema silently drops .refine() (F3) — so a value that would
    // fail the refinement is NOT rejected here. This is the documented gap
    // closed by the publish-time warning, not by this function.
    const withRefine = z.object({ a: z.number(), b: z.number() }).refine((v) => v.a <= v.b, { message: 'a<=b' })
    const schema = z.toJSONSchema(withRefine)
    expect(validateAgainstSchema(schema, { a: 10, b: 1 })).toEqual({ ok: true })
  })
})
