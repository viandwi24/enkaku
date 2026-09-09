import { describe, expect, test } from 'bun:test'
import { readRotation } from './workflow-rotation'
import { WorkflowDocSchema, type WorkflowDoc } from './workflow'

const ui = { x: 0, y: 0 }

function docOf(nodes: Record<string, unknown>[], params: Record<string, unknown>[] = [{ name: 'slot', title: 'Slot', type: 'number', required: true, default: 0 }]): WorkflowDoc {
  return WorkflowDocSchema.parse({ schema: 2, name: 'rot', title: '', description: '', params, entry: 'start', nodes })
}

/** The Latin square plan 314 §4 describes, as a document. */
function rotationSwitch(expr = '($device.number + $params.slot) % 3', cases = 3) {
  return {
    kind: 'switch',
    id: 'pick',
    title: 'Platform',
    ui,
    mode: 'predicate',
    cases: Array.from({ length: cases }, (_, i) => ({
      when: { left: { expr }, op: 'eq', right: { const: i } },
      to: `s${i}`,
      label: ['TikTok', 'Instagram', 'YouTube'][i] ?? `Case ${i}`,
    })),
  }
}

function scripts(n: number) {
  return Array.from({ length: n }, (_, i) => ({ kind: 'script', id: `s${i}`, title: '', ui, script: 'demo/a@1.0.0', params: {}, next: 'done' }))
}

describe('readRotation — does this document do anything different per session?', () => {
  test('the Latin square reads as a rotation, and names its switch', () => {
    const doc = docOf([{ kind: 'start', id: 'start', title: '', ui, next: 'pick' }, rotationSwitch(), ...scripts(3), { kind: 'finish', id: 'done', title: '', ui }])
    expect(readRotation(doc, 'slot')).toEqual({ nodeId: 'pick', caseCount: 3, refusal: null })
  })

  /*
    The failure this whole check exists for: a single-platform warm-up — the
    shape every farm has several of — accepted as a rotation, producing three
    schedules that all run TikTok and phones that never see the other two.
  */
  test('a workflow with no branch is refused, in the operator’s terms', () => {
    const doc = docOf([{ kind: 'start', id: 'start', title: '', ui, next: 's0' }, ...scripts(1), { kind: 'finish', id: 'done', title: '', ui }])
    const read = readRotation(doc, 'slot')
    expect(read.nodeId).toBeNull()
    expect(read.refusal).toContain('every session would do exactly the same thing')
  })

  test('a branch that ignores the session number is refused — it would branch, but not per session', () => {
    const doc = docOf([
      { kind: 'start', id: 'start', title: '', ui, next: 'pick' },
      rotationSwitch('$device.battery'),
      ...scripts(3),
      { kind: 'finish', id: 'done', title: '', ui },
    ])
    expect(readRotation(doc, 'slot').refusal).toContain('No branch in this workflow reads "slot"')
  })

  test('a one-case branch has nothing to rotate between', () => {
    const doc = docOf([{ kind: 'start', id: 'start', title: '', ui, next: 'pick' }, rotationSwitch(undefined, 1), ...scripts(1), { kind: 'finish', id: 'done', title: '', ui }])
    const read = readRotation(doc, 'slot')
    expect(read.nodeId).toBe('pick')
    expect(read.refusal).toContain('nothing to rotate between')
  })

  test('a slot the document does not declare goes nowhere, and says so', () => {
    const doc = docOf([{ kind: 'start', id: 'start', title: '', ui, next: 'pick' }, rotationSwitch(), ...scripts(3), { kind: 'finish', id: 'done', title: '', ui }])
    expect(readRotation(doc, 'session').refusal).toContain('no parameter called "session"')
  })

  /*
    Deliberately shallow: an author may write the rotation any number of ways,
    and a checker that recognised only the shape plan 314 drew would reject
    correct documents — a worse failure than the one it prevents.
  */
  test('the bracket form and a slot on the right-hand side both count', () => {
    const bracket = docOf([{ kind: 'start', id: 'start', title: '', ui, next: 'pick' }, rotationSwitch("($device.number + $params['slot']) % 3"), ...scripts(3), { kind: 'finish', id: 'done', title: '', ui }])
    expect(readRotation(bracket, 'slot').refusal).toBeNull()

    const onRight = docOf([
      { kind: 'start', id: 'start', title: '', ui, next: 'pick' },
      {
        kind: 'switch',
        id: 'pick',
        title: '',
        ui,
        mode: 'predicate',
        cases: [
          { when: { left: { expr: '$device.number % 3' }, op: 'eq', right: { expr: '$params.slot' } }, to: 's0', label: 'a' },
          { when: { left: { expr: '$device.number % 3' }, op: 'ne', right: { expr: '$params.slot' } }, to: 's1', label: 'b' },
        ],
      },
      ...scripts(2),
      { kind: 'finish', id: 'done', title: '', ui },
    ])
    expect(readRotation(onRight, 'slot').refusal).toBeNull()
  })

  test('a parameter whose name is a prefix of another is not matched by accident', () => {
    const doc = docOf(
      [{ kind: 'start', id: 'start', title: '', ui, next: 'pick' }, rotationSwitch('$params.slotCount % 3'), ...scripts(3), { kind: 'finish', id: 'done', title: '', ui }],
      [
        { name: 'slot', title: 'Slot', type: 'number', required: true, default: 0 },
        { name: 'slotCount', title: 'Slots', type: 'number', required: true, default: 3 },
      ],
    )
    expect(readRotation(doc, 'slot').refusal).toContain('No branch')
  })
})
