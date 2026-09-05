import { describe, expect, test } from 'bun:test'
import { WORKFLOW_LIMITS, WorkflowDocSchema } from './workflow'
import { assignmentsToJson, isDigitsOnlySegment, jsonToAssignments, setPath, SetPathError, type SetAssignment } from './workflow-set'

function startNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, ...overrides }
}

function setNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'set', id: 'set1', title: '', ui: { x: 0, y: 0 }, assignments: [], keepOnlySet: false, ...overrides }
}

function switchNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'switch', id: 'sw', title: '', ui: { x: 0, y: 0 }, cases: [{ when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, label: '' }], ...overrides }
}

function doc(nodes: Record<string, unknown>[], entry = 'start') {
  return { schema: 2, name: 'w', title: '', description: '', params: [], entry, nodes, maxSteps: 50 }
}

// ---------------------------------------------------------------------------
// dot notation (G2)
// ---------------------------------------------------------------------------

describe('setPath — dot notation (plan 312 §3.4, §4.3, G2)', () => {
  test('a.b + 20 => { a: { b: 20 } }', () => {
    expect(setPath({}, 'a.b', 20)).toEqual({ a: { b: 20 } })
  })

  test('a single segment sets a top-level field', () => {
    expect(setPath({}, 'count', 3)).toEqual({ count: 3 })
  })

  test('a later assignment overwrites an earlier one at the same path', () => {
    let base = setPath({}, 'a.b', 1)
    base = setPath(base, 'a.b', 2)
    expect(base).toEqual({ a: { b: 2 } })
  })

  test('a nested write preserves sibling fields already at that path', () => {
    let base = setPath({}, 'a.b', 1)
    base = setPath(base, 'a.c', 2)
    expect(base).toEqual({ a: { b: 1, c: 2 } })
  })

  test('never mutates the base object', () => {
    const base = { a: { b: 1 } }
    const next = setPath(base, 'a.c', 2)
    expect(base).toEqual({ a: { b: 1 } })
    expect(next).toEqual({ a: { b: 1, c: 2 } })
  })

  test('a digits-only segment is refused, naming the sentence (§3.4)', () => {
    expect(() => setPath({}, 'a.0.b', 1)).toThrow(SetPathError)
    expect(() => setPath({}, 'a.0.b', 1)).toThrow(/only digits/)
  })

  test('a top-level digits-only name is refused too', () => {
    expect(() => setPath({}, '0', 1)).toThrow(SetPathError)
  })

  test('an empty segment is refused', () => {
    expect(() => setPath({}, 'a..b', 1)).toThrow(SetPathError)
  })

  test('isDigitsOnlySegment', () => {
    expect(isDigitsOnlySegment('0')).toBe(true)
    expect(isDigitsOnlySegment('42')).toBe(true)
    expect(isDigitsOnlySegment('a0')).toBe(false)
    expect(isDigitsOnlySegment('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// assignment ceiling (G1's schema half)
// ---------------------------------------------------------------------------

describe('the set node schema (plan 312 §4.1)', () => {
  test('a bare set node parses, with keepOnlySet defaulting to false', () => {
    const result = WorkflowDocSchema.safeParse(doc([startNode({ next: 'set1' }), setNode()]))
    expect(result.success).toBe(true)
    if (result.success) {
      const node = result.data.nodes.find((n) => n.id === 'set1')
      expect(node && node.kind === 'set' && node.keepOnlySet).toBe(false)
    }
  })

  test('an assignment carries a name and a value, both ValueExprs', () => {
    const result = WorkflowDocSchema.safeParse(
      doc([startNode({ next: 'set1' }), setNode({ assignments: [{ name: { const: 'report.count' }, value: { expr: 'len($nodes.n1.videos)' } }] })]),
    )
    expect(result.success).toBe(true)
  })

  test(`the assignment ceiling is WORKFLOW_LIMITS.maxAssignments (${WORKFLOW_LIMITS.maxAssignments})`, () => {
    const atLimit = Array.from({ length: WORKFLOW_LIMITS.maxAssignments }, (_, i) => ({ name: { const: `f${i}` }, value: { const: i } }))
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'set1' }), setNode({ assignments: atLimit })])).success).toBe(true)

    const overLimit = Array.from({ length: WORKFLOW_LIMITS.maxAssignments + 1 }, (_, i) => ({ name: { const: `f${i}` }, value: { const: i } }))
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'set1' }), setNode({ assignments: overLimit })])).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// switch mode exclusivity
// ---------------------------------------------------------------------------

describe('the weighted switch — mode/case shape exclusivity (plan 312 §3.6, §4.2)', () => {
  test('predicate mode (the default) accepts a case with only "when"', () => {
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'sw' }), switchNode()])).success).toBe(true)
  })

  test('weighted mode accepts a case with only "weight"', () => {
    const node = switchNode({ mode: 'weighted', cases: [{ weight: 30, label: 'a' }, { weight: 50, label: 'b' }, { weight: 20, label: 'c' }] })
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'sw' }), node])).success).toBe(true)
  })

  test('a predicate-mode case carrying a "weight" is refused', () => {
    const node = switchNode({ cases: [{ when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, weight: 30, label: '' }] })
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'sw' }), node])).success).toBe(false)
  })

  test('a weighted-mode case carrying a "when" is refused', () => {
    const node = switchNode({ mode: 'weighted', cases: [{ when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, weight: 30, label: '' }] })
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'sw' }), node])).success).toBe(false)
  })

  test('a weighted-mode case missing "weight" is refused', () => {
    const node = switchNode({ mode: 'weighted', cases: [{ label: '' }] })
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'sw' }), node])).success).toBe(false)
  })

  test('a predicate-mode case missing "when" is refused', () => {
    const node = switchNode({ cases: [{ label: '' }] })
    expect(WorkflowDocSchema.safeParse(doc([startNode({ next: 'sw' }), node])).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// JSON round trip (G11)
// ---------------------------------------------------------------------------

describe('json round trip (G11) — the JSON tab and the Fields tab read identically', () => {
  test('a literal, a nested literal, and an expression', () => {
    const assignments: SetAssignment[] = [
      { name: { const: 'label' }, value: { const: 'nightly' } },
      { name: { const: 'report.count' }, value: { expr: 'len($nodes.n1.videos)' } },
    ]
    const encoded = assignmentsToJson(assignments)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(JSON.parse(encoded.json)).toEqual({ label: 'nightly', report: { count: '=len($nodes.n1.videos)' } })

    const decoded = jsonToAssignments(encoded.json)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.assignments).toEqual(assignments)
  })

  test('a literal string that begins with "=" round-trips escaped as "=="', () => {
    const assignments: SetAssignment[] = [{ name: { const: 'formula' }, value: { const: '=SUM(A1:A2)' } }]
    const encoded = assignmentsToJson(assignments)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(JSON.parse(encoded.json)).toEqual({ formula: '==SUM(A1:A2)' })
    const decoded = jsonToAssignments(encoded.json)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.assignments).toEqual(assignments)
  })

  test('number, boolean, null, and array literals round-trip as-is', () => {
    const assignments: SetAssignment[] = [
      { name: { const: 'n' }, value: { const: 42 } },
      { name: { const: 'b' }, value: { const: true } },
      { name: { const: 'z' }, value: { const: null } },
      { name: { const: 'list' }, value: { const: [1, 2, 3] } },
    ]
    const encoded = assignmentsToJson(assignments)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    const decoded = jsonToAssignments(encoded.json)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.assignments).toEqual(assignments)
  })

  test('decoding a fresh JSON document (never round through assignments first)', () => {
    const decoded = jsonToAssignments('{\n  "report": { "count": "=len($nodes.n1.videos)" },\n  "label": "nightly"\n}')
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.assignments).toEqual([
      { name: { const: 'report.count' }, value: { expr: 'len($nodes.n1.videos)' } },
      { name: { const: 'label' }, value: { const: 'nightly' } },
    ])
  })

  test('an interpolation template compiles to string concatenation', () => {
    const decoded = jsonToAssignments('{ "name": "run-{{ $now }}" }')
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.assignments).toEqual([{ name: { const: 'name' }, value: { expr: '"run-" + toText($now)' } }])
  })

  test('an assignment whose NAME is an expression cannot be shown as JSON', () => {
    const encoded = assignmentsToJson([{ name: { expr: '$params.field' }, value: { const: 1 } }])
    expect(encoded.ok).toBe(false)
  })

  test('an assignment whose VALUE is a param/from/run binding cannot be shown as JSON', () => {
    const encoded = assignmentsToJson([{ name: { const: 'x' }, value: { param: 'p' } }])
    expect(encoded.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// json refusals (G12) — 3 cases: top-level array, duplicate key, unholdable value
// ---------------------------------------------------------------------------

describe('json refusals (G12) — refused with a reason, never stored raw', () => {
  test('a top-level array is refused', () => {
    const result = jsonToAssignments('[1, 2, 3]')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('top_level_not_object')
  })

  test('a top-level primitive is refused too', () => {
    const result = jsonToAssignments('"just a string"')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('top_level_not_object')
  })

  test('a duplicate key at the top level is refused', () => {
    const result = jsonToAssignments('{ "a": 1, "a": 2 }')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('duplicate_key')
    expect(result.message).toContain('"a"')
  })

  test('a duplicate key nested inside an object is refused too', () => {
    const result = jsonToAssignments('{ "a": { "b": 1, "b": 2 } }')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('duplicate_key')
  })

  test('an unholdable value — a digits-only key, which cannot become a dot-notation segment — is refused', () => {
    const result = jsonToAssignments('{ "0": 1 }')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('digits_only_key')
  })

  test('a digits-only key nested inside an object is refused too', () => {
    const result = jsonToAssignments('{ "a": { "0": 1 } }')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('digits_only_key')
  })

  test('malformed JSON text is refused as a syntax error, not thrown', () => {
    const result = jsonToAssignments('{ not json')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('syntax')
  })

  test('an object nested inside an array is refused (arrays are leaves, §3.5)', () => {
    const result = jsonToAssignments('{ "a": [{ "b": 1 }] }')
    expect(result.ok).toBe(false)
  })
})
