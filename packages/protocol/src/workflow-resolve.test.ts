import { describe, expect, test } from 'bun:test'
import { evaluatePredicate, resolveValue, type PredicateTrace, type ResolveScope } from './workflow-resolve'
import { GATE_OPS, WORKFLOW_LIMITS, type GateOp, type Predicate, type ValueExpr } from './workflow'

describe('resolveValue — the four forms', () => {
  const scope: ResolveScope = {
    params: { keyword: 'shoes' },
    outputs: new Map<string, unknown>([['scroll1', { videos: 12 }]]),
    summary: [{ nodeId: 'scroll1', script: 'tiktok/auto-scroll@1.4.0', status: 'success', startedAt: 1, finishedAt: 2, durationMs: 1000, output: { videos: 12 } }],
  }

  test('const — any JSON value, unchanged', () => {
    expect(resolveValue({ const: 42 }, scope)).toEqual({ ok: true, value: 42 })
    expect(resolveValue({ const: { nested: ['ok'] } }, scope)).toEqual({ ok: true, value: { nested: ['ok'] } })
  })

  test('param — present', () => {
    expect(resolveValue({ param: 'keyword' }, scope)).toEqual({ ok: true, value: 'shoes' })
  })

  test('param — not supplied is unresolved, and the detail names it', () => {
    const outcome = resolveValue({ param: 'nope' }, scope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('unresolved')
    expect(outcome.detail).toContain('nope')
  })

  test('from — the whole output, no path', () => {
    expect(resolveValue({ from: 'scroll1', optional: false }, scope)).toEqual({ ok: true, value: { videos: 12 } })
  })

  test('from — a resolvable path', () => {
    expect(resolveValue({ from: 'scroll1', path: 'videos', optional: false }, scope)).toEqual({ ok: true, value: 12 })
  })

  test('from — a node that never ran is "no_such_node", and the detail names it', () => {
    const outcome = resolveValue({ from: 'never-ran', optional: false }, scope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no_such_node')
    expect(outcome.detail).toContain('never-ran')
  })

  test('from — optional substitutes the default when the node never ran', () => {
    expect(resolveValue({ from: 'never-ran', optional: true, default: 'fallback' }, scope)).toEqual({ ok: true, value: 'fallback' })
  })

  test('from — optional substitutes the default when the path does not resolve', () => {
    expect(resolveValue({ from: 'scroll1', path: 'notThere', optional: true, default: 0 }, scope)).toEqual({ ok: true, value: 0 })
  })

  test('from — optional with NO default resolves to undefined rather than failing', () => {
    expect(resolveValue({ from: 'never-ran', optional: true }, scope)).toEqual({ ok: true, value: undefined })
  })

  test('run: summary — always resolves, to the summary array as-is', () => {
    expect(resolveValue({ run: 'summary' }, scope)).toEqual({ ok: true, value: scope.summary })
  })
})

describe('resolveValue — path resolution against pathological roots never throws', () => {
  const scope: ResolveScope = {
    params: {},
    outputs: new Map<string, unknown>([
      ['nullNode', null],
      ['undefinedField', { a: undefined }],
      ['nanNode', Number.NaN],
      ['emptyArray', []],
      ['nested', { a: { b: { c: 1 } } }],
      ['numberNode', 5],
    ]),
    summary: [],
  }

  test.each([
    ['nullNode', 'anything'],
    ['undefinedField', 'a.b'],
    ['nanNode', 'anything'],
    ['emptyArray', '0'],
    ['emptyArray', 'notAnIndex'],
    ['nested', 'a.b.c'],
    ['nested', 'a.b.c.d'], // walking PAST a leaf number
    ['numberNode', 'anything'],
  ])('from: %s, path: %s does not throw', (from, path) => {
    expect(() => resolveValue({ from, path, optional: false }, scope)).not.toThrow()
  })

  test('walking into `null` fails cleanly, not with a TypeError', () => {
    const outcome = resolveValue({ from: 'undefinedField', path: 'a.b', optional: false }, scope)
    expect(outcome.ok).toBe(false)
  })

  test('a deep, resolvable path still works', () => {
    expect(resolveValue({ from: 'nested', path: 'a.b.c', optional: false }, scope)).toEqual({ ok: true, value: 1 })
  })
})

describe('sawKeys — populated and truncated on an unresolved path (plan 99 §3.6, §4.4)', () => {
  test('an object output names its top-level keys', () => {
    const scope: ResolveScope = { params: {}, outputs: new Map([['scroll1', { videos: 12, watchSeconds: 40, byLabel: {} }]]), summary: [] }
    const outcome = resolveValue({ from: 'scroll1', path: 'notAField', optional: false }, scope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.sawKeys).toEqual(['videos', 'watchSeconds', 'byLabel'])
  })

  test(`truncated to WORKFLOW_LIMITS.maxSawKeys (${WORKFLOW_LIMITS.maxSawKeys})`, () => {
    const bigOutput: Record<string, number> = {}
    for (let i = 0; i < WORKFLOW_LIMITS.maxSawKeys + 10; i++) bigOutput[`field${i}`] = i
    const scope: ResolveScope = { params: {}, outputs: new Map([['big', bigOutput]]), summary: [] }
    const outcome = resolveValue({ from: 'big', path: 'notAField', optional: false }, scope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.sawKeys).toHaveLength(WORKFLOW_LIMITS.maxSawKeys)
  })

  test('an array output names its indices', () => {
    const scope: ResolveScope = { params: {}, outputs: new Map([['list', [1, 2, 3]]]), summary: [] }
    const outcome = resolveValue({ from: 'list', path: 'notAField', optional: false }, scope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.sawKeys).toEqual(['0', '1', '2'])
  })

  test('a primitive output has no keys to name', () => {
    const scope: ResolveScope = { params: {}, outputs: new Map([['n', 5]]), summary: [] }
    const outcome = resolveValue({ from: 'n', path: 'notAField', optional: false }, scope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.sawKeys).toBeUndefined()
  })
})

describe('evaluatePredicate — a node that never ran is false, with a named reason, not an exception (99.3 verifiable result)', () => {
  test('a gate over a node that never ran', () => {
    const pred: Extract<Predicate, { left: ValueExpr }> = {
      left: { from: 'scroll1', path: 'videos', optional: false },
      op: 'gte',
      right: { const: 10 },
    }
    const emptyScope: ResolveScope = { params: {}, outputs: new Map(), summary: [] }
    expect(() => evaluatePredicate(pred, emptyScope)).not.toThrow()
    const { value, trace } = evaluatePredicate(pred, emptyScope)
    expect(value).toBe(false)
    expect(trace.leftUnresolved).toBeDefined()
    expect(trace.leftUnresolved).toContain('scroll1')
    expect(trace.leftUnresolved).toContain('has not run')
  })

  test('notExists / isEmpty read "never ran" as satisfied; exists / notEmpty read it as not satisfied', () => {
    const never: ValueExpr = { from: 'missing', optional: false }
    const emptyScope: ResolveScope = { params: {}, outputs: new Map(), summary: [] }
    expect(evaluatePredicate({ left: never, op: 'notExists' }, emptyScope).value).toBe(true)
    expect(evaluatePredicate({ left: never, op: 'isEmpty' }, emptyScope).value).toBe(true)
    expect(evaluatePredicate({ left: never, op: 'exists' }, emptyScope).value).toBe(false)
    expect(evaluatePredicate({ left: never, op: 'notEmpty' }, emptyScope).value).toBe(false)
  })
})

describe('evaluatePredicate — the trace renders the product-facing sentence (99.3 verifiable result)', () => {
  test('scroll1.videos (12) >= 10 → continue', () => {
    const pred: Extract<Predicate, { left: ValueExpr }> = {
      left: { from: 'scroll1', path: 'videos', optional: false },
      op: 'gte',
      right: { const: 10 },
    }
    const scope: ResolveScope = { params: {}, outputs: new Map<string, unknown>([['scroll1', { videos: 12 }]]), summary: [] }
    const { value, trace } = evaluatePredicate(pred, scope)
    expect(value).toBe(true)

    // A minimal stand-in for Studio's future job-detail renderer (plan 99
    // §4.11) — not a public export of this module. Proves that `trace`,
    // combined with the STATIC predicate the caller already has, carries
    // everything the sentence needs: the resolved operands (12, 10), the
    // verdict (true → the gate's `then` branch, "continue"), and enough of
    // the predicate's own shape to name what was compared ("scroll1.videos").
    const opLabels: Partial<Record<GateOp, string>> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '==', ne: '!=' }
    const left = pred.left
    const leftLabel = 'from' in left ? (left.path ? `${left.from}.${left.path}` : left.from) : ''
    const outcomeLabel = value ? 'continue' : 'stop' // this predicate's own `then`; chosen by the CALLER, not by evaluatePredicate
    const sentence = `${leftLabel} (${trace.left}) ${opLabels[pred.op] ?? pred.op} ${trace.right} → ${outcomeLabel}`
    expect(sentence).toBe('scroll1.videos (12) >= 10 → continue')
  })
})

describe('evaluatePredicate — all / any / not, and nested traces', () => {
  const scope: ResolveScope = { params: {}, outputs: new Map(), summary: [] }
  const t: Predicate = { left: { const: 1 }, op: 'eq', right: { const: 1 } }
  const f: Predicate = { left: { const: 1 }, op: 'eq', right: { const: 2 } }

  test('all — every child must be true', () => {
    expect(evaluatePredicate({ all: [t, t] }, scope).value).toBe(true)
    expect(evaluatePredicate({ all: [t, f] }, scope).value).toBe(false)
  })

  test('any — one true child is enough', () => {
    expect(evaluatePredicate({ any: [f, f] }, scope).value).toBe(false)
    expect(evaluatePredicate({ any: [f, t] }, scope).value).toBe(true)
  })

  test('not — negates', () => {
    expect(evaluatePredicate({ not: t }, scope).value).toBe(false)
    expect(evaluatePredicate({ not: f }, scope).value).toBe(true)
  })

  test('the trace nests one child per predicate, matching the document structure', () => {
    const { trace } = evaluatePredicate({ all: [t, { any: [f, t] }] }, scope)
    expect(trace.op).toBe('all')
    expect(trace.children).toHaveLength(2)
    expect(trace.children?.[1]?.op).toBe('any')
    expect(trace.children?.[1]?.children).toHaveLength(2)
  })
})

describe('operator semantics — spot checks', () => {
  const scope: ResolveScope = { params: {}, outputs: new Map(), summary: [] }
  function leaf(left: unknown, op: GateOp, right?: unknown): Predicate {
    return right === undefined ? { left: { const: left }, op } : { left: { const: left }, op, right: { const: right } }
  }

  test('contains — substring on a string, membership on an array', () => {
    expect(evaluatePredicate(leaf('hello world', 'contains', 'world'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf('hello world', 'contains', 'xyz'), scope).value).toBe(false)
    expect(evaluatePredicate(leaf([1, 2, 3], 'contains', 2), scope).value).toBe(true)
    expect(evaluatePredicate(leaf([1, 2, 3], 'contains', 9), scope).value).toBe(false)
  })

  test('contains — a number on the left is never a match (false, not a throw)', () => {
    expect(evaluatePredicate(leaf(5, 'contains', 5), scope).value).toBe(false)
  })

  test('notContains', () => {
    expect(evaluatePredicate(leaf('hello', 'notContains', 'xyz'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf('hello', 'notContains', 'ell'), scope).value).toBe(false)
  })

  test('startsWith / endsWith', () => {
    expect(evaluatePredicate(leaf('hello world', 'startsWith', 'hello'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf('hello world', 'endsWith', 'world'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf('hello world', 'startsWith', 'world'), scope).value).toBe(false)
  })

  test('length — string or array length compared for equality against a number', () => {
    expect(evaluatePredicate(leaf('hello', 'length', 5), scope).value).toBe(true)
    expect(evaluatePredicate(leaf([1, 2, 3], 'length', 3), scope).value).toBe(true)
    expect(evaluatePredicate(leaf([1, 2, 3], 'length', 2), scope).value).toBe(false)
  })

  test('eq / ne use deep, structural equality on objects and arrays', () => {
    expect(evaluatePredicate(leaf({ a: 1, b: [1, 2] }, 'eq', { a: 1, b: [1, 2] }), scope).value).toBe(true)
    expect(evaluatePredicate(leaf({ a: 1 }, 'ne', { a: 2 }), scope).value).toBe(true)
    expect(evaluatePredicate(leaf({ a: 1 }, 'eq', { a: 1, b: 2 }), scope).value).toBe(false)
  })

  test('gte / lt — strictly numeric; a string or NaN never compares (false, not a throw or a coercion)', () => {
    expect(evaluatePredicate(leaf(12, 'gte', 10), scope).value).toBe(true)
    expect(evaluatePredicate(leaf('12', 'gte', 10), scope).value).toBe(false)
    expect(evaluatePredicate(leaf(Number.NaN, 'lt', 10), scope).value).toBe(false)
    expect(evaluatePredicate(leaf(10, 'lt', Number.NaN), scope).value).toBe(false)
  })

  test('isEmpty / notEmpty across shapes', () => {
    expect(evaluatePredicate(leaf('', 'isEmpty'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf([], 'isEmpty'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf({}, 'isEmpty'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf(null, 'isEmpty'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf('x', 'notEmpty'), scope).value).toBe(true)
    expect(evaluatePredicate(leaf(0, 'isEmpty'), scope).value).toBe(false) // a number is never "empty"
  })
})

describe('totality — every GATE_OP against pathological operands never throws (99.3 verifiable result)', () => {
  const UNARY_OPS = new Set<GateOp>(['exists', 'notExists', 'isEmpty', 'notEmpty'])

  const weirdRefs: ValueExpr[] = [
    { from: 'missing', optional: false }, // a node that never ran — "undefined"
    { from: 'nullNode', optional: false },
    { from: 'nanNode', optional: false },
    { from: 'emptyArray', optional: false },
    { from: 'nested', path: 'a.b.c', optional: false }, // a nested object, resolved
    { from: 'nested', path: 'a.b.doesNotExist', optional: false }, // a nested object, missed
    { from: 'numberNode', optional: false },
    { from: 'stringNode', optional: false }, // sets up the number-vs-string mismatch case below
  ]

  const scope: ResolveScope = {
    params: {},
    outputs: new Map<string, unknown>([
      ['nullNode', null],
      ['nanNode', Number.NaN],
      ['emptyArray', []],
      ['nested', { a: { b: { c: 1 } } }],
      ['numberNode', 5],
      ['stringNode', '5'],
    ]),
    summary: [],
  }

  for (const op of GATE_OPS) {
    test(`${op} never throws, against every pathological (left, right) pair`, () => {
      for (const left of weirdRefs) {
        for (const right of weirdRefs) {
          const pred: Predicate = UNARY_OPS.has(op) ? { left, op } : { left, op, right }
          expect(() => evaluatePredicate(pred, scope)).not.toThrow()
          const { value } = evaluatePredicate(pred, scope)
          expect(typeof value).toBe('boolean')
        }
      }
    })
  }
})

describe('PredicateTrace — shape sanity', () => {
  test('a leaf trace carries op/left/right/value; a compound trace carries op/value/children', () => {
    const scope: ResolveScope = { params: {}, outputs: new Map(), summary: [] }
    const leafTrace: PredicateTrace = evaluatePredicate({ left: { const: 1 }, op: 'eq', right: { const: 1 } }, scope).trace
    expect(leafTrace.left).toBe(1)
    expect(leafTrace.right).toBe(1)
    expect(leafTrace.children).toBeUndefined()

    const compoundTrace: PredicateTrace = evaluatePredicate({ not: { left: { const: 1 }, op: 'eq', right: { const: 1 } } }, scope).trace
    expect(compoundTrace.op).toBe('not')
    expect(compoundTrace.children).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------ *
 * `$run.index` / `$run.count` — dividing a fleet into equal shares.
 * ------------------------------------------------------------------------ */

describe('$run.index and $run.count (the fleet-split case, 2026-09-05)', () => {
  const scopeFor = (runIndex: number, runCount: number): ResolveScope => ({ params: {}, outputs: new Map(), summary: [], runIndex, runCount })

  test('an expression can read this run’s place in its batch', () => {
    expect(resolveValue({ expr: '$run.index' }, scopeFor(7, 20))).toEqual({ ok: true, value: 7 })
    expect(resolveValue({ expr: '$run.count' }, scopeFor(7, 20))).toEqual({ ok: true, value: 20 })
  })

  test('index % 4 divides twenty devices into EXACTLY five each — the thing $random cannot promise', () => {
    const buckets = [0, 0, 0, 0]
    for (let i = 0; i < 20; i++) {
      const outcome = resolveValue({ expr: '$run.index % 4' }, scopeFor(i, 20))
      expect(outcome.ok).toBe(true)
      const bucket = (outcome as { value: number }).value
      buckets[bucket] = (buckets[bucket] ?? 0) + 1
    }
    expect(buckets).toEqual([5, 5, 5, 5])
  })

  test('a run with no batch is index 0 of 1, never undefined', () => {
    const bare: ResolveScope = { params: {}, outputs: new Map(), summary: [] }
    expect(resolveValue({ expr: '$run.index' }, bare)).toEqual({ ok: true, value: 0 })
    expect(resolveValue({ expr: '$run.count' }, bare)).toEqual({ ok: true, value: 1 })
  })
})
