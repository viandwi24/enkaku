import { describe, expect, test } from 'bun:test'
import { inferWorkflowParamType, promoteNodeParam } from './promote'

describe('inferWorkflowParamType', () => {
  test('maps the JSON-Schema shapes plan 95/99 both recognise', () => {
    expect(inferWorkflowParamType({ type: 'string' })).toBe('string')
    expect(inferWorkflowParamType({ type: 'integer' })).toBe('integer')
    expect(inferWorkflowParamType({ type: 'number' })).toBe('number')
    expect(inferWorkflowParamType({ type: 'boolean' })).toBe('boolean')
    expect(inferWorkflowParamType({ type: 'array', items: { type: 'string' } })).toBe('stringList')
    expect(inferWorkflowParamType({ prefixItems: [{ type: 'number' }, { type: 'number' }] })).toBe('numberPair')
  })

  test('unwraps a single-real-branch nullable anyOf, matching plan.ts row 14', () => {
    expect(inferWorkflowParamType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string')
  })

  test('returns null for a shape with no workflow-parameter equivalent (an object, an array of objects, several real anyOf branches)', () => {
    expect(inferWorkflowParamType({ type: 'object', properties: { a: { type: 'string' } } })).toBeNull()
    expect(inferWorkflowParamType({ type: 'array', items: { type: 'object', properties: {} } })).toBeNull()
    expect(inferWorkflowParamType({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBeNull()
  })
})

describe('promoteNodeParam (plan 99 §3.8 — "copies title, description, hints and default verbatim")', () => {
  test('copies title/description/hints/default off the node script\'s own declared property', () => {
    const field = {
      type: 'string',
      title: 'Search keyword',
      description: 'What to search for on the Discover tab.',
      'x-enkaku': { kind: 'text', group: 'Search' },
    }
    const promoted = promoteNodeParam(field, 'keyword', new Set(), true)
    expect(promoted).toEqual({
      name: 'keyword',
      type: 'string',
      required: true,
      title: 'Search keyword',
      description: 'What to search for on the Discover tab.',
      hints: { kind: 'text', group: 'Search' },
    })
  })

  test('falls back to a humanised key when the field has no title', () => {
    const promoted = promoteNodeParam({ type: 'integer' }, 'videoCount', new Set(), false)
    expect(promoted?.title).toBe('Video Count')
    expect(promoted?.required).toBe(false)
  })

  test('disambiguates a name collision with _2, _3, ... (identifier-shaped, unlike node ids)', () => {
    const promoted = promoteNodeParam({ type: 'string' }, 'keyword', new Set(['keyword']), true)
    expect(promoted?.name).toBe('keyword_2')
  })

  test('returns null for a shape Promote cannot place (an object)', () => {
    expect(promoteNodeParam({ type: 'object', properties: {} }, 'opts', new Set(), true)).toBeNull()
  })

  test('the ±MAX_SAFE_INTEGER "no bound" sentinel is dropped, matching schema-form/plan.ts\'s own numberBounds rule', () => {
    const promoted = promoteNodeParam({ type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: 2_000 }, 'videos', new Set(), false)
    expect(promoted?.min).toBeUndefined()
    expect(promoted?.max).toBe(2_000)
  })
})
