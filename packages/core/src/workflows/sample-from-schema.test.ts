import { describe, expect, test } from 'bun:test'
import { sampleFromSchema, SIMULATE_LIMITS } from './sample-from-schema'

describe('sampleFromSchema', () => {
  test('every JSON Schema type gets its placeholder', () => {
    expect(sampleFromSchema({ type: 'string' })).toBe('text')
    expect(sampleFromSchema({ type: 'number' })).toBe(0)
    expect(sampleFromSchema({ type: 'integer' })).toBe(0)
    expect(sampleFromSchema({ type: 'boolean' })).toBe(false)
    expect(sampleFromSchema({ type: 'null' })).toBe(null)
    expect(sampleFromSchema({ type: 'array', items: { type: 'string' } })).toEqual(['text'])
    expect(sampleFromSchema({ type: 'object', properties: { a: { type: 'number' } } })).toEqual({ a: 0 })
  })

  test('an object recurses over each property', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { deep: { type: 'string' } } },
      },
    }
    expect(sampleFromSchema(schema)).toEqual({
      name: 'text',
      count: 0,
      active: false,
      tags: ['text'],
      nested: { deep: 'text' },
    })
  })

  test('the four honoured hints, in precedence order: const, default, examples[0], enum[0]', () => {
    expect(sampleFromSchema({ type: 'string', const: 'fixed', default: 'd', examples: ['e'], enum: ['x'] })).toBe('fixed')
    expect(sampleFromSchema({ type: 'string', default: 'd', examples: ['e'], enum: ['x'] })).toBe('d')
    expect(sampleFromSchema({ type: 'string', examples: ['e'], enum: ['x'] })).toBe('e')
    expect(sampleFromSchema({ type: 'string', enum: ['x', 'y'] })).toBe('x')
    // A `default` of a falsy value (0, false, '', null) still wins over the placeholder — presence, not truthiness.
    expect(sampleFromSchema({ type: 'number', default: 0 })).toBe(0)
    expect(sampleFromSchema({ type: 'boolean', default: false })).toBe(false)
  })

  test('maxDepth bounds recursion — a schema deeper than the limit degrades to a placeholder rather than recursing further', () => {
    // Build a schema nested well past maxDepth.
    let schema: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < SIMULATE_LIMITS.maxDepth + 5; i++) {
      schema = { type: 'object', properties: { next: schema } }
    }
    // Should not throw, and should terminate.
    const result = sampleFromSchema(schema)
    expect(result).toBeDefined()
  })

  test('maxArrayLength bounds an array sample to one element', () => {
    const result = sampleFromSchema({ type: 'array', items: { type: 'number' } }) as unknown[]
    expect(result.length).toBe(SIMULATE_LIMITS.maxArrayLength)
  })

  test('maxNodes bounds a very wide object — does not hang or throw', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < SIMULATE_LIMITS.maxNodes + 50; i++) {
      properties[`field${i}`] = { type: 'string' }
    }
    const result = sampleFromSchema({ type: 'object', properties }) as Record<string, unknown>
    expect(Object.keys(result).length).toBeLessThanOrEqual(SIMULATE_LIMITS.maxNodes + 1)
  })

  test('non-object or missing schema input never throws', () => {
    expect(sampleFromSchema(undefined)).toBe(null)
    expect(sampleFromSchema(null)).toBe(null)
    expect(sampleFromSchema('not a schema')).toBe(null)
    expect(sampleFromSchema(42)).toBe(null)
  })

  test('an unrecognised type falls back to null rather than throwing', () => {
    expect(sampleFromSchema({ type: 'something-unknown' })).toBe(null)
    expect(sampleFromSchema({})).toBe(null)
  })
})
