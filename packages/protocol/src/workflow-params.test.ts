import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { checkDeclaredSchema } from './schema/limits'
import { ui } from './schema/vocabulary'
import { compileWorkflowParams, WORKFLOW_PARAM_TYPES, WorkflowParamSchema, type WorkflowParam } from './workflow-params'

/**
 * The contract test (plan 99 §5 step 99.2). For every `WorkflowParamType`, a
 * hand-built Zod object using the EXACT chain a script author already writes
 * — base type, then `.default()`/`.optional()`, then `.describe()`, then
 * `.meta()` (plain, or `ui(...)` when there are hints) — the same order
 * `TimingSettingsSchema` uses (`settings.ts:53-58`) — must produce BYTE
 * IDENTICAL `z.toJSONSchema(..., { io: 'input' })` output to what
 * `compileWorkflowParams` emits for the equivalent declared param. This is
 * what stops the workflow form drifting from the script form; a failure here
 * means compileWorkflowParams and a human author now disagree about what one
 * of plan 95's six shapes means.
 */
describe('compileWorkflowParams — equivalence with a hand-written Zod object (99.2 contract test)', () => {
  test('string: required (with hints+description), optional (bare), and defaulted (bare)', () => {
    const hand = z.object({
      keyword: z.string().describe('What to search for on the Discover tab.').meta(ui({ title: 'Search keyword', kind: 'text' })),
      nickname: z.string().optional().meta({ title: 'Nickname' }),
      greeting: z.string().default('hello').meta({ title: 'Greeting' }),
    })
    const params: WorkflowParam[] = [
      { name: 'keyword', type: 'string', required: true, title: 'Search keyword', description: 'What to search for on the Discover tab.', hints: { kind: 'text' } },
      { name: 'nickname', type: 'string', required: false, title: 'Nickname', description: '' },
      { name: 'greeting', type: 'string', required: false, default: 'hello', title: 'Greeting', description: '' },
    ]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('number: with hints, min/max, and a chance-style bound', () => {
    const hand = z.object({
      chance: z.number().min(0).max(1).meta(ui({ title: 'Save chance', kind: 'chance' })),
    })
    const params: WorkflowParam[] = [{ name: 'chance', type: 'number', required: true, title: 'Save chance', description: '', hints: { kind: 'chance' }, min: 0, max: 1 }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('integer: defaulted, with min/max', () => {
    const hand = z.object({
      count: z.number().int().min(1).max(50).default(10).meta({ title: 'Scroll count' }),
    })
    const params: WorkflowParam[] = [{ name: 'count', type: 'integer', required: false, default: 10, title: 'Scroll count', description: '', min: 1, max: 50 }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('boolean: defaulted', () => {
    const hand = z.object({ dryRun: z.boolean().default(false).meta({ title: 'Dry run' }) })
    const params: WorkflowParam[] = [{ name: 'dryRun', type: 'boolean', required: false, default: false, title: 'Dry run', description: '' }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('stringList: required, with min/max item count (plan 95 §4.2 row 11 — a `list`)', () => {
    const hand = z.object({ keywords: z.array(z.string()).min(1).max(5).meta({ title: 'Keywords' }) })
    const params: WorkflowParam[] = [{ name: 'keywords', type: 'stringList', required: true, title: 'Keywords', description: '', min: 1, max: 5 }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('numberPair: defaulted tuple, ordered hint (plan 95 §4.2 row 6 — a `pair`)', () => {
    const hand = z.object({
      range: z.tuple([z.number(), z.number()]).default([0, 10]).meta(ui({ title: 'Range', ordered: true })),
    })
    const params: WorkflowParam[] = [{ name: 'range', type: 'numberPair', required: false, default: [0, 10], title: 'Range', description: '', hints: { ordered: true } }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('every WORKFLOW_PARAM_TYPES member is covered by the tests above', () => {
    expect(WORKFLOW_PARAM_TYPES).toEqual(['string', 'number', 'integer', 'boolean', 'stringList', 'numberPair'])
  })

  test('a string enum compiles the same as a hand-written z.enum()', () => {
    const hand = z.object({ mode: z.enum(['fast', 'slow']).meta({ title: 'Mode' }) })
    const params: WorkflowParam[] = [{ name: 'mode', type: 'string', required: true, title: 'Mode', description: '', enum: ['fast', 'slow'] }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })

  test('a single-member enum still compiles (z.enum needs 2+, so this exercises the z.literal fallback)', () => {
    const hand = z.object({ mode: z.literal('only').meta({ title: 'Mode' }) })
    const params: WorkflowParam[] = [{ name: 'mode', type: 'string', required: true, title: 'Mode', description: '', enum: ['only'] }]
    expect(compileWorkflowParams(params)).toEqual(z.toJSONSchema(hand, { io: 'input' }))
  })
})

describe('compileWorkflowParams — the "no params" convention (matches scripts.paramsSchema)', () => {
  test('an empty declaration list compiles to null, not an empty object schema', () => {
    expect(compileWorkflowParams([])).toBeNull()
  })
})

describe('compileWorkflowParams — declaration order is preserved (plan 95 §3.5: order is a guarantee)', () => {
  test('field order in the output matches the input array, not alphabetical', () => {
    const params: WorkflowParam[] = [
      { name: 'zebra', type: 'string', required: true, title: 'Zebra', description: '' },
      { name: 'alpha', type: 'string', required: true, title: 'Alpha', description: '' },
    ]
    const compiled = compileWorkflowParams(params) as { properties: Record<string, unknown> }
    expect(Object.keys(compiled.properties)).toEqual(['zebra', 'alpha'])
  })
})

describe('compileWorkflowParams — checkDeclaredSchema finds nothing on a realistic compiled schema', () => {
  test('a normal, well-formed set of workflow params publishes clean', () => {
    const params: WorkflowParam[] = [
      { name: 'keyword', type: 'string', required: true, title: 'Search keyword', description: 'What to search for.', hints: { kind: 'text' } },
      { name: 'maxVideos', type: 'integer', required: false, default: 10, title: 'Max videos', description: '', min: 1, max: 100 },
      { name: 'dryRun', type: 'boolean', required: false, default: false, title: 'Dry run', description: '' },
    ]
    const compiled = compileWorkflowParams(params)
    expect(checkDeclaredSchema(compiled)).toEqual([])
  })
})

describe('WorkflowParamSchema — the declaration itself', () => {
  test('a well-formed declaration parses', () => {
    const result = WorkflowParamSchema.safeParse({
      name: 'keyword',
      type: 'string',
      required: true,
      title: 'Search keyword',
    })
    expect(result.success).toBe(true)
  })

  test('an unknown field is refused (.strict())', () => {
    const result = WorkflowParamSchema.safeParse({ name: 'keyword', type: 'string', title: 'Search keyword', pattern: '.*' })
    expect(result.success).toBe(false)
  })

  test('an invalid name (not identifier-shaped) is refused — reuses SCHEMA_LIMITS.fieldNamePattern, not a second grammar', () => {
    const result = WorkflowParamSchema.safeParse({ name: '0bad', type: 'string', title: 'x' })
    expect(result.success).toBe(false)
  })

  test('an unknown type is refused', () => {
    const result = WorkflowParamSchema.safeParse({ name: 'x', type: 'json', title: 'x' })
    expect(result.success).toBe(false)
  })
})
