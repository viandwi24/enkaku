import { describe, expect, test } from 'bun:test'
import { checkWorkflow, type ResolvedNodeScript, type WorkflowFindingCode } from './workflow-check'
import { WorkflowDocSchema, type WorkflowDoc } from './workflow'

/** A minimal, otherwise-valid script node — callers override only what the test cares about. Matches `workflow.test.ts`'s own helper so the two files read the same document the same way. */
function scriptNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'script', id: 'n0', title: '', ui: { x: 0, y: 0 }, script: 'tiktok/auto-scroll@1.4.0', params: {}, ...overrides }
}

function startNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, ...overrides }
}

function finishNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'finish', id: 'finish', title: '', ui: { x: 0, y: 0 }, ...overrides }
}

function scriptEntry(overrides: Partial<ResolvedNodeScript> = {}): ResolvedNodeScript {
  return { name: 'demo', version: '1.0.0', paramsSchema: null, outputSchema: null, timeoutMs: null, ...overrides }
}

function codesOf(findings: { code: WorkflowFindingCode }[]): WorkflowFindingCode[] {
  return findings.map((f) => f.code)
}

/**
 * The owner's own example (plan 99 §0, adapted to doc v2 by plan 301):
 * start → Scroll FYP (warm-up) → Search Keywords & Scroll Posts → [gate:
 * enough matches?] → Scroll FYP again → Report → finish, with the gate's
 * `else` looping back to `scroll1`.
 */
const ownerExampleDoc: WorkflowDoc = WorkflowDocSchema.parse({
  schema: 2,
  name: 'tiktok-search-pipeline',
  title: 'TikTok search pipeline',
  description: 'Warm up the feed, search a keyword, and report what was found.',
  params: [{ name: 'keyword', type: 'string', required: true, title: 'Search keyword' }],
  entry: 'start',
  nodes: [
    startNode({ next: 'scroll1' }),
    scriptNode({ id: 'scroll1', title: 'Scroll FYP (warm-up)', next: 'search1' }),
    scriptNode({
      id: 'search1',
      title: 'Search Keywords & Scroll Posts',
      script: 'tiktok/searched-follow@1.4.0',
      params: { keyword: { param: 'keyword' } },
      next: 'enough',
    }),
    {
      kind: 'gate',
      id: 'enough',
      title: 'Enough matches?',
      ui: { x: 0, y: 0 },
      when: { left: { from: 'search1', path: 'matches' }, op: 'notEmpty' },
      then: 'scroll2',
      else: 'scroll1',
    },
    scriptNode({ id: 'scroll2', title: 'Scroll FYP again', next: 'report' }),
    scriptNode({
      id: 'report',
      title: 'Report',
      script: 'tiktok/report@1.0.0',
      params: { videos: { from: 'scroll1', path: 'videos' }, all: { run: 'summary' } },
      next: 'finish',
    }),
    finishNode(),
  ],
  onFail: { script: 'tiktok/switch-account@1.0.0', params: {} },
})

const ownerExampleResolved = new Map<string, ResolvedNodeScript>([
  ['tiktok/auto-scroll@1.4.0', scriptEntry({ name: 'tiktok/auto-scroll', version: '1.4.0' })],
  ['tiktok/searched-follow@1.4.0', scriptEntry({ name: 'tiktok/searched-follow', version: '1.4.0' })],
  ['tiktok/report@1.0.0', scriptEntry({ name: 'tiktok/report', version: '1.0.0' })],
  ['tiktok/switch-account@1.0.0', scriptEntry({ name: 'tiktok/switch-account', version: '1.0.0' })],
])

describe('checkWorkflow — the owner\'s example (step 99.6 verifiable result, doc v2)', () => {
  test('produces only warnings — never an error — against the real, unedited document', () => {
    const findings = checkWorkflow(ownerExampleDoc, ownerExampleResolved)
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
    // Two unchecked bindings (report's `videos`, the gate's `when` operand —
    // neither producing script declares an output schema, plan 97 has not
    // landed), one loop warning (the gate's `else` goes back to scroll1),
    // and one dangling `onFailure` per script node (4) — none of the four
    // script nodes wires an explicit failure edge, which is the doc v2
    // equivalent of v1's `onFailure: { go: 'fail' }` default (plan 301
    // §3.2): reaching the end of it ends the run failed, exactly as before.
    const expected: WorkflowFindingCode[] = [
      'W_WORKFLOW_LOOP',
      'W_WORKFLOW_UNCHECKED_BINDING',
      'W_WORKFLOW_UNCHECKED_BINDING',
      'W_WORKFLOW_EDGE_DANGLING',
      'W_WORKFLOW_EDGE_DANGLING',
      'W_WORKFLOW_EDGE_DANGLING',
      'W_WORKFLOW_EDGE_DANGLING',
    ]
    expect(codesOf(findings).sort()).toEqual(expected.sort())
  })

  test('every node is reachable and no forward-ref fires, even though the gate branches backward', () => {
    const findings = checkWorkflow(ownerExampleDoc, ownerExampleResolved)
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_NODE_UNREACHABLE')
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_FORWARD_REF')
  })
})

describe('checkWorkflow — every finding is returned, never the first (plan 95 §4.2\'s rule, applied here)', () => {
  test('three unrelated problems in one document all appear in one call', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'multi-problem',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'a' }),
        scriptNode({ id: 'a', params: { x: { param: 'nope' } }, next: 'b' }), // E_WORKFLOW_UNKNOWN_PARAM
        scriptNode({ id: 'b', next: 'ghost' }), // E_WORKFLOW_UNKNOWN_NODE
        // 'c' is never targeted by anything — W_WORKFLOW_NODE_UNREACHABLE
        scriptNode({ id: 'c' }),
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const codes = codesOf(findings)
    expect(codes).toContain('E_WORKFLOW_UNKNOWN_PARAM')
    expect(codes).toContain('E_WORKFLOW_UNKNOWN_NODE')
    expect(codes).toContain('W_WORKFLOW_NODE_UNREACHABLE')
    expect(findings.length).toBeGreaterThanOrEqual(3)
  })
})

describe('checkWorkflow — E_WORKFLOW_DUP_NODE_ID', () => {
  test('two nodes sharing one id are both named, even though WorkflowDocSchema itself already refuses this shape (belt and suspenders — checkWorkflow must not assume its input arrived through .parse())', () => {
    // Built by hand, past the Zod boundary — WorkflowDocSchema's own
    // superRefine would refuse this document; checkWorkflow's OWN
    // duplicate check is exercised directly here.
    const doc = {
      schema: 2,
      name: 'dup',
      title: '',
      description: '',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'same' }), scriptNode({ id: 'same' }), scriptNode({ id: 'same' })],
      maxSteps: 50,
    } as unknown as WorkflowDoc
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_DUP_NODE_ID')
    const dup = findings.find((f) => f.code === 'E_WORKFLOW_DUP_NODE_ID')
    expect(dup?.message).toContain('"same"')
  })
})

describe('checkWorkflow — E_WORKFLOW_ENTRY_UNKNOWN', () => {
  test('entry naming a node that does not exist', () => {
    const doc = {
      schema: 2,
      name: 'bad-entry',
      title: '',
      description: '',
      params: [],
      entry: 'ghost',
      nodes: [startNode()],
      maxSteps: 50,
    } as unknown as WorkflowDoc
    const findings = checkWorkflow(doc, new Map())
    expect(codesOf(findings)).toContain('E_WORKFLOW_ENTRY_UNKNOWN')
  })

  test('entry naming a real node that is not a start node', () => {
    const doc = {
      schema: 2,
      name: 'entry-not-start',
      title: '',
      description: '',
      params: [],
      entry: 'a',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' })],
      maxSteps: 50,
    } as unknown as WorkflowDoc
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_ENTRY_UNKNOWN')
  })
})

describe('checkWorkflow — E_WORKFLOW_UNKNOWN_NODE', () => {
  test('a gate branch naming a node that does not exist', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'bad-then',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'g1' }),
        { kind: 'gate', id: 'g1', ui: { x: 0, y: 0 }, when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: 'ghost' },
      ],
    })
    const findings = checkWorkflow(doc, new Map())
    expect(codesOf(findings)).toContain('E_WORKFLOW_UNKNOWN_NODE')
  })

  test('a { from } binding naming a node that does not exist', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'bad-from',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { x: { from: 'ghost' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_UNKNOWN_NODE')
  })
})

describe('checkWorkflow — E_WORKFLOW_FORWARD_REF (step 99.6 verifiable result)', () => {
  test('a node binding to a node that runs strictly LATER is refused, naming both nodes', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'forward-ref',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'first' }),
        scriptNode({ id: 'first', params: { x: { from: 'second' } }, next: 'second' }), // binds to a node that has not run yet
        scriptNode({ id: 'second' }),
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const forwardRef = findings.find((f) => f.code === 'E_WORKFLOW_FORWARD_REF')
    expect(forwardRef).toBeDefined()
    expect(forwardRef?.message).toContain('"first"')
    expect(forwardRef?.message).toContain('"second"')
  })

  test('a backward edge makes a later-declared node a legitimate EARLIER execution — no forward-ref fires', () => {
    // start -> a -> b -> c, with c's onFailure looping back to a. `c` binding
    // to `a`'s output is fine: on the SECOND pass through `a`, `c` has
    // already run once before.
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'loop-binding',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'a' }),
        scriptNode({ id: 'a', next: 'b' }),
        scriptNode({ id: 'b', next: 'c' }),
        scriptNode({ id: 'c', params: { x: { from: 'a' } }, onFailure: 'a' }),
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_FORWARD_REF')
  })
})

describe('checkWorkflow — E_WORKFLOW_UNKNOWN_PARAM and E_WORKFLOW_BINDING_TYPE', () => {
  test('{ param } naming an undeclared workflow parameter', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'unknown-param',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { x: { param: 'never_declared' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_UNKNOWN_PARAM')
  })

  test('a string workflow parameter bound into a number-typed node parameter is refused', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'type-mismatch',
      params: [{ name: 'count', type: 'string', required: true, title: 'Count' }],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { count: { param: 'count' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['tiktok/auto-scroll@1.4.0', scriptEntry({ paramsSchema: { type: 'object', properties: { count: { type: 'number' } } } })],
    ])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_BINDING_TYPE')
  })

  test('a compatible binding (matching types) is never flagged', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'type-match',
      params: [{ name: 'count', type: 'integer', required: true, title: 'Count' }],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { count: { param: 'count' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['tiktok/auto-scroll@1.4.0', scriptEntry({ paramsSchema: { type: 'object', properties: { count: { type: 'number' } } } })],
    ])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BINDING_TYPE')
  })

  test('an undetermined target shape (no paramsSchema at all) never blocks — conservative by design', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'type-undetermined',
      params: [{ name: 'count', type: 'string', required: true, title: 'Count' }],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { count: { param: 'count' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry({ paramsSchema: null })]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BINDING_TYPE')
  })
})

describe('checkWorkflow — E_WORKFLOW_BINDING_UNRESOLVABLE and W_WORKFLOW_UNCHECKED_BINDING', () => {
  test('a path that cannot exist on a DECLARED output schema is refused at publish time, naming the shape it was checked against', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'bad-path',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b', params: { x: { from: 'a', path: 'nope' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['tiktok/auto-scroll@1.4.0', scriptEntry({ outputSchema: { type: 'object', properties: { videos: { type: 'number' } }, additionalProperties: false } })],
    ])
    const findings = checkWorkflow(doc, resolved)
    const unresolvable = findings.find((f) => f.code === 'E_WORKFLOW_BINDING_UNRESOLVABLE')
    expect(unresolvable).toBeDefined()
    expect(unresolvable?.message).toContain('videos')
  })

  test('a path that DOES exist on a declared output schema is never flagged', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'good-path',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b', params: { x: { from: 'a', path: 'videos' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['tiktok/auto-scroll@1.4.0', scriptEntry({ outputSchema: { type: 'object', properties: { videos: { type: 'number' } }, additionalProperties: false } })],
    ])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BINDING_UNRESOLVABLE')
  })

  test('a node whose script declares NO output degrades to a warning, and still publishes', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'no-output',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b', params: { x: { from: 'a', path: 'anything' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry({ outputSchema: null })]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('W_WORKFLOW_UNCHECKED_BINDING')
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })

  test('an optional binding with a default is never flagged, even against a closed schema missing the path', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'optional-binding',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'a' }),
        scriptNode({ id: 'a', next: 'b' }),
        scriptNode({ id: 'b', params: { x: { from: 'a', path: 'nope', optional: true, default: 0 } } }),
      ],
    })
    // Note: `optional`/`default` change RUN-TIME resolution
    // (`workflow-resolve.ts`), not this PUBLISH-TIME structural check —
    // the path genuinely cannot exist on the declared shape either way, so
    // this still reports E_WORKFLOW_BINDING_UNRESOLVABLE. Recorded here so
    // the distinction between the two checks is explicit rather than
    // assumed.
    const resolved = new Map<string, ResolvedNodeScript>([
      ['tiktok/auto-scroll@1.4.0', scriptEntry({ outputSchema: { type: 'object', properties: {}, additionalProperties: false } })],
    ])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_BINDING_UNRESOLVABLE')
  })

  test('referencing a GATE node\'s "output" degrades to unchecked rather than crashing — a gate has no output', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'from-gate',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'g1' }),
        { kind: 'gate', id: 'g1', ui: { x: 0, y: 0 }, when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: 'b' },
        scriptNode({ id: 'b', params: { x: { from: 'g1' } } }),
      ],
    })
    const findings = checkWorkflow(doc, new Map())
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BINDING_UNRESOLVABLE')
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_UNCHECKED_BINDING')
  })
})

describe('checkWorkflow — reachability (plan 301 §4.2/§4.3: a warning, not an error)', () => {
  test('a node nothing ever transitions to is named, as a WARNING', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'dead-node',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'g1' }),
        { kind: 'gate', id: 'g1', ui: { x: 0, y: 0 }, when: { left: { const: 1 }, op: 'eq', right: { const: 1 } } },
        scriptNode({ id: 'orphan' }), // array-adjacent but g1 never targets it
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const unreachable = findings.find((f) => f.code === 'W_WORKFLOW_NODE_UNREACHABLE')
    expect(unreachable).toBeDefined()
    expect(unreachable?.severity).toBe('warning')
    expect(unreachable?.message).toContain('"orphan"')
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })

  test('a dangling edge (no next wired) is a warning, naming the edge, and still publishes', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'dangling-next',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' })], // no `next`, no `onFailure`
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const dangling = findings.filter((f) => f.code === 'W_WORKFLOW_EDGE_DANGLING')
    expect(dangling.length).toBeGreaterThanOrEqual(2) // node.next AND node.onFailure are both absent
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })
})

describe('checkWorkflow — E_WORKFLOW_BUDGET_IMPOSSIBLE (plan 98 step 98.4 unblocked this; plan 99 §4.3 check 7)', () => {
  test('omitting `budget` skips check 7 entirely — checkWorkflow stays pure, no default invented internally', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'no-budget-passed',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry({ timeoutMs: 999_999_999 })]])
    const findings = checkWorkflow(doc, resolved) // no third argument
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_BUDGET_UNKNOWN')
  })

  test('a deterministic (acyclic) two-node sum that exceeds the budget is refused, naming the arithmetic', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'over-budget',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'a@1.0.0', next: 'b' }), scriptNode({ id: 'b', script: 'b@1.0.0' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['a@1.0.0', scriptEntry({ timeoutMs: 400_000 })],
      ['b@1.0.0', scriptEntry({ timeoutMs: 400_000 })],
    ])
    const findings = checkWorkflow(doc, resolved, { maxTotalMs: 500_000 })
    const impossible = findings.find((f) => f.code === 'E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(impossible).toBeDefined()
    expect(impossible?.severity).toBe('error')
    expect(impossible?.message).toContain('800000ms')
    expect(impossible?.message).toContain('500000ms')
  })

  test('a deterministic sum within the budget produces neither an error nor a warning', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'within-budget',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'a@1.0.0', next: 'b' }), scriptNode({ id: 'b', script: 'b@1.0.0' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['a@1.0.0', scriptEntry({ timeoutMs: 100_000 })],
      ['b@1.0.0', scriptEntry({ timeoutMs: 100_000 })],
    ])
    const findings = checkWorkflow(doc, resolved, { maxTotalMs: 500_000 })
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_BUDGET_UNKNOWN')
  })

  test('an undeclared node timeout is UNKNOWN, not zero — degrades to a warning naming the node, never a silent pass and never a false refusal', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'unknown-timeout',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'a@1.0.0', next: 'b' }), scriptNode({ id: 'b', script: 'b@1.0.0' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['a@1.0.0', scriptEntry({ timeoutMs: 100_000 })],
      ['b@1.0.0', scriptEntry({ timeoutMs: null })], // declares nothing
    ])
    // A tiny budget that a KNOWN sum would obviously blow — proves this
    // takes the "unknown" branch rather than quietly treating null as 0 and
    // passing, or fabricating a refusal it cannot actually justify.
    const findings = checkWorkflow(doc, resolved, { maxTotalMs: 1_000 })
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BUDGET_IMPOSSIBLE')
    const unknown = findings.find((f) => f.code === 'W_WORKFLOW_BUDGET_UNKNOWN')
    expect(unknown).toBeDefined()
    expect(unknown?.severity).toBe('warning')
    expect(unknown?.message).toContain('"b"')
  })

  test('a gate node costs nothing — a gate-only branch never makes the sum unknown or adds to it', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'gate-is-free',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'a' }),
        scriptNode({ id: 'a', script: 'a@1.0.0', next: 'g' }),
        { kind: 'gate', id: 'g', ui: { x: 0, y: 0 }, when: { left: { const: 1 }, op: 'eq', right: { const: 1 } } },
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['a@1.0.0', scriptEntry({ timeoutMs: 100_000 })]])
    const findings = checkWorkflow(doc, resolved, { maxTotalMs: 150_000 })
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_BUDGET_UNKNOWN')
  })

  test('a cyclic document never gets the hard refusal, however large the worst case — only the existing W_WORKFLOW_LOOP warning (§3.11: "might not finish" is a warning, never a refusal)', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'loop-over-budget',
      params: [],
      entry: 'start',
      maxSteps: 500,
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'a@1.0.0', onFailure: 'a' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['a@1.0.0', scriptEntry({ timeoutMs: 3_600_000 })]])
    // 500 * 3_600_000ms would dwarf any sane budget — still not a refusal.
    const findings = checkWorkflow(doc, resolved, { maxTotalMs: 1_000 })
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_BUDGET_UNKNOWN')
    const loop = findings.find((f) => f.code === 'W_WORKFLOW_LOOP')
    expect(loop).toBeDefined()
    expect(loop?.severity).toBe('warning')
  })

  test('an onFail cleanup script contributes its own timeout to the worst case', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'onfail-counted',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'a@1.0.0' })],
      onFail: { script: 'cleanup@1.0.0', params: {} },
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['a@1.0.0', scriptEntry({ timeoutMs: 300_000 })],
      ['cleanup@1.0.0', scriptEntry({ timeoutMs: 300_000 })],
    ])
    // a alone (300_000) fits under 400_000; a + onFail (600_000) does not.
    const findings = checkWorkflow(doc, resolved, { maxTotalMs: 400_000 })
    const impossible = findings.find((f) => f.code === 'E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(impossible).toBeDefined()
    expect(impossible?.message).toContain('onFail')
  })

  test('the owner\'s own example never blows an intentionally huge budget, and its loop keeps producing only W_WORKFLOW_LOOP', () => {
    // Regression guard for the fixture at the top of this file — declaring
    // real timeouts on it must not turn its EXISTING warning-only result
    // into an error, since it is cyclic (the gate's `else` loops to scroll1).
    const resolved = new Map<string, ResolvedNodeScript>([...ownerExampleResolved].map(([ref, entry]) => [ref, { ...entry, timeoutMs: 60_000 }]))
    const findings = checkWorkflow(ownerExampleDoc, resolved, { maxTotalMs: 21_600_000 })
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_BUDGET_IMPOSSIBLE')
  })
})

describe('checkWorkflow — W_WORKFLOW_LOOP', () => {
  test('a self-goto is a loop, warned once, never blocking', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'self-loop',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', onFailure: 'a' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const loop = findings.find((f) => f.code === 'W_WORKFLOW_LOOP')
    expect(loop).toBeDefined()
    expect(loop?.severity).toBe('warning')
  })

  test('a purely linear document (no backward edge anywhere) reports no loop', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'linear',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', next: 'b' }), scriptNode({ id: 'b' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_LOOP')
  })
})

describe('checkWorkflow — W_WORKFLOW_LATEST_REF', () => {
  test('a node script pinned to @latest is warned, legibly, and still publishes', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'uses-latest',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'tiktok/auto-scroll@latest' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@latest', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const latest = findings.find((f) => f.code === 'W_WORKFLOW_LATEST_REF')
    expect(latest).toBeDefined()
    expect(latest?.severity).toBe('warning')
  })

  test('a pinned version is never warned', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'pinned',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', script: 'tiktok/auto-scroll@1.4.0' })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('W_WORKFLOW_LATEST_REF')
  })
})

describe('checkWorkflow — a missing entry in `resolved` degrades gracefully, never throws', () => {
  test('a node whose script ref is absent from the resolved map produces no crash', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'unresolved-in-map',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' })],
    })
    expect(() => checkWorkflow(doc, new Map())).not.toThrow()
  })
})

describe('expression findings (plan 302 §4.7, G9)', () => {
  test('a { expr } binding that parses cleanly and references only earlier nodes produces no expr finding', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-ok',
      params: [{ name: 'threshold', type: 'number', required: true, title: 'Threshold' }],
      entry: 'start',
      nodes: [
        startNode({ next: 'a' }),
        scriptNode({ id: 'a', next: 'b' }),
        scriptNode({ id: 'b', params: { x: { expr: '$nodes.a.count > $params.threshold' } } }),
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_EXPR_PARSE')
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_EXPR_UNKNOWN_NODE')
  })

  test('E_WORKFLOW_EXPR_PARSE — an unparsable expression is reported at publish time, with the offset', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-bad-syntax',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { x: { expr: '$nodes.a.constructor("x")' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const finding = findings.find((f) => f.code === 'E_WORKFLOW_EXPR_PARSE')
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('offset')
  })

  test('E_WORKFLOW_EXPR_UNKNOWN_NODE — a $nodes reference naming a node that does not exist', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-unknown-node',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a', params: { x: { expr: '$nodes.ghost.count' } } })],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const finding = findings.find((f) => f.code === 'E_WORKFLOW_EXPR_UNKNOWN_NODE')
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('ghost')
  })

  test('E_WORKFLOW_EXPR_UNKNOWN_NODE — a $nodes reference naming a node that can only run LATER (same forward-ref rule as { from })', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-forward-ref',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'first' }),
        scriptNode({ id: 'first', params: { x: { expr: '$nodes.second.count' } }, next: 'second' }),
        scriptNode({ id: 'second' }),
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    const finding = findings.find((f) => f.code === 'E_WORKFLOW_EXPR_UNKNOWN_NODE')
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('"first"')
    expect(finding?.message).toContain('"second"')
  })

  test('a $nodes reference inside a gate predicate operand is checked the same way', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-in-gate',
      params: [],
      entry: 'start',
      nodes: [
        startNode({ next: 'a' }),
        scriptNode({ id: 'a', next: 'g1' }),
        { kind: 'gate', id: 'g1', ui: { x: 0, y: 0 }, when: { left: { expr: '$nodes.ghost.count' }, op: 'exists' } },
      ],
    })
    const resolved = new Map<string, ResolvedNodeScript>([['tiktok/auto-scroll@1.4.0', scriptEntry()]])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).toContain('E_WORKFLOW_EXPR_UNKNOWN_NODE')
  })

  test('an { expr } bound to onFail skips the forward-ref half of the check, same as { from } does', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-on-fail',
      params: [],
      entry: 'start',
      nodes: [startNode({ next: 'a' }), scriptNode({ id: 'a' })],
      onFail: { script: 'tiktok/switch-account@1.0.0', params: { x: { expr: '$nodes.a.count' } } },
    })
    const resolved = new Map<string, ResolvedNodeScript>([
      ['tiktok/auto-scroll@1.4.0', scriptEntry()],
      ['tiktok/switch-account@1.0.0', scriptEntry({ name: 'tiktok/switch-account', version: '1.0.0' })],
    ])
    const findings = checkWorkflow(doc, resolved)
    expect(codesOf(findings)).not.toContain('E_WORKFLOW_EXPR_UNKNOWN_NODE')
  })
})
