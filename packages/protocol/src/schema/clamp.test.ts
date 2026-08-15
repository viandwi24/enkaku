import { describe, expect, test } from 'bun:test'
import { HOSTILE_BLOCKING, HOSTILE_PARAMS_FIXTURES } from './hostile-fixtures'
import { SCHEMA_LIMITS } from './limits'
import { clampSchema, summarizeClamp } from './clamp'

function countFields(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0
  const properties = (node as { properties?: Record<string, unknown> }).properties
  if (!properties) return 0
  let total = Object.keys(properties).length
  for (const child of Object.values(properties)) total += countFields(child)
  return total
}

function maxDepth(node: unknown, depth = 0): number {
  if (node === null || typeof node !== 'object') return depth
  const properties = (node as { properties?: Record<string, unknown> }).properties
  if (!properties || Object.keys(properties).length === 0) return depth
  return Math.max(...Object.values(properties).map((child) => maxDepth(child, depth + 1)))
}

describe('clampSchema — totality', () => {
  test('null/undefined/a non-object degrade to an empty schema, never throw', () => {
    for (const bad of [null, undefined, 'not a schema', 42, []]) {
      expect(() => clampSchema(bad)).not.toThrow()
      const { schema, clamped } = clampSchema(bad)
      expect(schema).toEqual({})
      expect(clamped).toEqual([])
    }
  })

  test('a clean, small schema passes through with nothing clamped', () => {
    const schema = { type: 'object', properties: { videos: { type: 'number', title: 'Videos' } } }
    const result = clampSchema(schema)
    expect(result.clamped).toEqual([])
    expect(result.schema).toEqual(schema)
  })
})

describe('clampSchema — string truncation (R4)', () => {
  test('an over-long title is shortened and reported', () => {
    const schema = { type: 'object', properties: { x: { type: 'string', title: 'a'.repeat(SCHEMA_LIMITS.maxTitleChars + 50) } } }
    const { schema: clampedSchema, clamped } = clampSchema(schema)
    const title = (clampedSchema.properties as Record<string, { title: string }>).x!.title
    expect(title.length).toBeLessThanOrEqual(SCHEMA_LIMITS.maxTitleChars + 1) // +1 for the ellipsis
    expect(clamped.some((f) => f.limit === 'maxTitleChars')).toBe(true)
  })

  test('a 50 000-character description is shortened to the limit and reported', () => {
    const { schema: clampedSchema, clamped } = clampSchema(HOSTILE_PARAMS_FIXTURES['giant-description'])
    const description = (clampedSchema.properties as Record<string, { description: string }>).note!.description
    expect(description.length).toBeLessThanOrEqual(SCHEMA_LIMITS.maxDescriptionChars + 1)
    expect(clamped.some((f) => f.limit === 'maxDescriptionChars')).toBe(true)
  })

  test('a ~200 KiB schema clamps down to something small and usable', () => {
    const { schema: clampedSchema } = clampSchema(HOSTILE_PARAMS_FIXTURES['oversized-200kb'])
    expect(JSON.stringify(clampedSchema).length).toBeLessThan(2_000)
  })
})

describe('clampSchema — enum truncation', () => {
  test('a 10 000-member enum is cut down to the limit', () => {
    const { schema: clampedSchema, clamped } = clampSchema(HOSTILE_PARAMS_FIXTURES['enum-10000'])
    const options = (clampedSchema.properties as Record<string, { enum: unknown[] }>).mode!.enum
    expect(options.length).toBe(SCHEMA_LIMITS.maxEnumMembers)
    expect(clamped.some((f) => f.limit === 'maxEnumMembers')).toBe(true)
  })
})

describe('clampSchema — field count (R5)', () => {
  test('5 000 sibling fields are cut down to the field limit, and the drop is reported once', () => {
    const { schema: clampedSchema, clamped } = clampSchema(HOSTILE_PARAMS_FIXTURES['wide-5000'])
    expect(countFields(clampedSchema)).toBeLessThanOrEqual(SCHEMA_LIMITS.maxFields)
    const finding = clamped.find((f) => f.limit === 'maxFields')
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('removed')
  })

  test('a dropped field is also removed from `required` — a clamped form must still be submittable', () => {
    const schema = {
      type: 'object',
      required: ['a', 'zzz'],
      properties: { a: { type: 'string' }, zzz: { type: 'string' } },
    }
    // Artificially tiny budget by wrapping in a schema whose field count
    // already exceeds the limit before `zzz` — reuse wide-5000 plus one
    // more required key to prove the general rule cheaply.
    const wide = HOSTILE_PARAMS_FIXTURES['wide-5000'] as { properties: Record<string, unknown> }
    const bigSchema = { type: 'object', required: ['field0', 'field4999'], properties: wide.properties }
    const { schema: clampedSchema } = clampSchema(bigSchema)
    const required = (clampedSchema.required ?? []) as string[]
    const properties = (clampedSchema.properties ?? {}) as Record<string, unknown>
    for (const key of required) expect(key in properties).toBe(true)
  })
})

describe('clampSchema — depth (R1, belt-and-braces alongside the resolver\'s own cap)', () => {
  test('a 40-deep schema is stopped at the depth cap and reports it', () => {
    const { schema: clampedSchema, clamped } = clampSchema(HOSTILE_PARAMS_FIXTURES['deep-40'])
    expect(maxDepth(clampedSchema)).toBeLessThanOrEqual(SCHEMA_LIMITS.maxDepth + 1)
    expect(clamped.some((f) => f.limit === 'maxDepth')).toBe(true)
  })

  test('a schema within the depth cap is untouched', () => {
    const schema = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } }
    const { clamped } = clampSchema(schema)
    expect(clamped.filter((f) => f.limit === 'maxDepth')).toEqual([])
  })
})

describe('clampSchema — $ref cycles (verifying, not re-implementing, the resolver\'s own defence)', () => {
  test('a self-referential $ref is passed through untouched and does not hang THIS function', () => {
    const start = performance.now()
    const { schema: clampedSchema } = clampSchema(HOSTILE_PARAMS_FIXTURES['self-ref-cycle'])
    expect(performance.now() - start).toBeLessThan(200)
    // Passed through, not rewritten — the $ref/$defs structure survives
    // intact for the resolver's own (already-tested) visited-set defence.
    expect(clampedSchema.$defs).toBeDefined()
  })

  test('a mutual A→B→A cycle does not hang either', () => {
    const start = performance.now()
    clampSchema(HOSTILE_PARAMS_FIXTURES['mutual-ref-cycle'])
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('clampSchema — every HOSTILE_BLOCKING fixture renders clamped, under 200ms, with no hang', () => {
  test('each fixture: clampSchema terminates fast and produces a bounded, JSON-serialisable schema', () => {
    for (const name of HOSTILE_BLOCKING) {
      const start = performance.now()
      const { schema: clampedSchema, clamped } = clampSchema(HOSTILE_PARAMS_FIXTURES[name])
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(200)
      expect(() => JSON.stringify(clampedSchema)).not.toThrow()
      expect(countFields(clampedSchema)).toBeLessThanOrEqual(SCHEMA_LIMITS.maxFields)
      // Every SIZE/DEPTH/COUNT-hostile fixture must show up as a clamp
      // finding. The other three block PUBLISH but need no runtime
      // truncation to render safely: `$ref` cycles are already defused by
      // the resolver's own visited set (this function passes `$ref`
      // through untouched, see the module doc); `redos-pattern` is simply
      // never evaluated (§3.8) so there is nothing to cut; a bad field
      // NAME is a publish-time identifier rule, not a size/shape problem a
      // truncation pass can fix.
      const needsNoRuntimeClamp = new Set(['self-ref-cycle', 'mutual-ref-cycle', 'redos-pattern', 'non-identifier-keys'])
      if (!needsNoRuntimeClamp.has(name)) {
        expect(clamped.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('summarizeClamp', () => {
  test('null when nothing was clamped', () => {
    expect(summarizeClamp([])).toBeNull()
  })

  test('one line naming what was clamped, with counts', () => {
    const line = summarizeClamp([
      { path: 'a', limit: 'maxTitleChars', message: 'x' },
      { path: 'b', limit: 'maxTitleChars', message: 'x' },
      { path: '', limit: 'maxFields', message: 'x' },
    ])
    expect(line).toContain('2')
    expect(line).toContain('title')
    expect(line).toContain('field')
  })
})
