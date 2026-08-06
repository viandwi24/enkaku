import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { toJsonSchema } from './to-json-schema'

describe('toJsonSchema (plan 63 §4.1, §7)', () => {
  test('converts a plain object schema', () => {
    const schema = z.object({ deviceId: z.string(), count: z.number().int() })
    const json = toJsonSchema(schema)
    expect(json.type).toBe('object')
    expect(json.$schema).toBeUndefined()
  })

  test('converts a discriminated union (device.tap-shaped output)', () => {
    const schema = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), reason: z.literal('not-found') }),
    ])
    const json = toJsonSchema(schema)
    expect(json).toBeTruthy()
  })

  test('converts .optional() and .default()', () => {
    const schema = z.object({ curvature: z.number().min(0).max(0.5).optional(), ms: z.number().int().positive().default(300) })
    expect(() => toJsonSchema(schema)).not.toThrow()
  })

  test('converts .describe()', () => {
    const schema = z.object({ text: z.string().describe('the text to type') })
    const json = toJsonSchema(schema) as { properties?: Record<string, { description?: string }> }
    expect(json.properties?.text?.description).toBe('the text to type')
  })

  test('converts a union of literal and number (device.key-shaped code)', () => {
    const schema = z.object({ code: z.union([z.number().int(), z.string()]) })
    expect(() => toJsonSchema(schema)).not.toThrow()
  })

  test('converts nested objects and arrays (device.list-shaped output)', () => {
    const schema = z.object({ items: z.array(z.object({ id: z.string(), tags: z.array(z.string()) })) })
    expect(() => toJsonSchema(schema)).not.toThrow()
  })

  test('a genuinely unrepresentable construct throws rather than becoming {}', () => {
    // A bare `z.custom()` with no schema hint is the standard "cannot be
    // represented in JSON Schema" case — Zod 4 throws under `unrepresentable: 'throw'`.
    const schema = z.object({ fn: z.custom<() => void>((v) => typeof v === 'function') })
    expect(() => toJsonSchema(schema)).toThrow()
  })
})
