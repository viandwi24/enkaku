import { describe, expect, test } from 'bun:test'
import { WorkflowDocSchema } from '@enkaku/protocol'
import {
  addGateNode,
  addScriptNode,
  bumpPatchVersion,
  defaultReset,
  docToDraft,
  emptyDraft,
  freshNodeId,
  moveNode,
  removeNode,
  startsFromLabel,
  toWorkflowDoc,
  updateNode,
  zodIssuesToFindings,
} from './model'

describe('freshNodeId', () => {
  test('slugifies a human title into WorkflowNodeIdSchema\'s own grammar', () => {
    expect(freshNodeId('Scroll FYP (warm-up)', new Set())).toBe('scroll-fyp-warm-up')
  })

  test('disambiguates a collision with -2, -3, ...', () => {
    const existing = new Set(['step', 'step-2'])
    expect(freshNodeId('step', existing)).toBe('step-3')
  })

  test('falls back to "node" for a seed with no legal characters', () => {
    expect(freshNodeId('!!!', new Set())).toBe('node')
  })
})

describe('defaultReset / startsFromLabel (plan 99 §3.3)', () => {
  test('the first node defaults to a clean device; every later node defaults to continuing', () => {
    expect(defaultReset(0)).toBe('farm')
    expect(defaultReset(1)).toBe('none')
    expect(defaultReset(4)).toBe('none')
  })

  test('the plain-language sentence, never a "reset" toggle label', () => {
    expect(startsFromLabel('farm')).toBe('a clean device')
    expect(startsFromLabel('none')).toBe('where the previous node finished')
  })
})

describe('node list editing', () => {
  test('addScriptNode/addGateNode append with a fresh id and schema-correct defaults', () => {
    let d = emptyDraft()
    d = addScriptNode(d, 'scroll')
    d = addGateNode(d)
    expect(d.nodes.map((n) => n.id)).toEqual(['scroll', 'gate'])
    expect(d.nodes[0]).toMatchObject({ kind: 'script', script: '', params: {}, onFailure: { go: 'fail' } })
    expect(d.nodes[1]).toMatchObject({ kind: 'gate', then: { go: 'continue' }, else: { go: 'stop' } })
  })

  test('removeNode drops exactly the targeted index', () => {
    let d = emptyDraft()
    d = addScriptNode(d, 'a')
    d = addScriptNode(d, 'b')
    d = addScriptNode(d, 'c')
    d = removeNode(d, 1)
    expect(d.nodes.map((n) => n.id)).toEqual(['a', 'c'])
  })

  test('moveNode reorders and is a no-op past either end', () => {
    let d = emptyDraft()
    d = addScriptNode(d, 'a')
    d = addScriptNode(d, 'b')
    d = addScriptNode(d, 'c')
    const moved = moveNode(d, 0, 2)
    expect(moved.nodes.map((n) => n.id)).toEqual(['b', 'c', 'a'])
    expect(moveNode(d, 0, -1)).toBe(d)
    expect(moveNode(d, 0, 3)).toBe(d)
  })

  test('updateNode patches only the targeted node', () => {
    let d = emptyDraft()
    d = addScriptNode(d, 'a')
    d = addScriptNode(d, 'b')
    d = updateNode(d, 1, { title: 'Renamed' })
    expect(d.nodes[0]?.title).toBe('')
    expect(d.nodes[1]?.title).toBe('Renamed')
  })
})

describe('toWorkflowDoc / zodIssuesToFindings — the draft never disagrees with the real schema', () => {
  test('an empty draft fails the real WorkflowDocSchema (at least one node)', () => {
    const result = toWorkflowDoc(emptyDraft())
    expect(result.success).toBe(false)
    if (!result.success) {
      const findings = zodIssuesToFindings(result.error)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.every((f) => f.code === 'E_WORKFLOW_INVALID' && f.severity === 'error')).toBe(true)
    }
  })

  test('a minimally complete draft parses as a real WorkflowDoc', () => {
    let d = emptyDraft()
    d.name = 'my-pipeline'
    d = addScriptNode(d, 'scroll1')
    d = updateNode(d, 0, { script: 'tiktok/auto-scroll@1.4.0' })
    const result = toWorkflowDoc(d)
    expect(result.success).toBe(true)
  })
})

describe('docToDraft / bumpPatchVersion (plan 99 §4.9 — the editor\'s "start from version")', () => {
  test('round-trips a published WorkflowDoc into an editable draft with a bumped patch version', () => {
    const doc = WorkflowDocSchema.parse({
      schema: 1,
      name: 'roundtrip',
      version: '1.2.3',
      nodes: [{ kind: 'script', id: 'n0', script: 'tiktok/auto-scroll@1.4.0', params: {}, onFailure: { go: 'fail' } }],
    })
    const draft = docToDraft(doc, bumpPatchVersion(doc.version))
    expect(draft.version).toBe('1.2.4')
    expect(draft.name).toBe('roundtrip')
    expect(draft.nodes[0]).toMatchObject({ kind: 'script', id: 'n0', script: 'tiktok/auto-scroll@1.4.0' })
    // Round-tripping straight back through the real schema still validates.
    expect(toWorkflowDoc({ ...draft, version: '1.2.4' }).success).toBe(true)
  })

  test('bumpPatchVersion leaves a non-semver string alone rather than guessing', () => {
    expect(bumpPatchVersion('not-a-version')).toBe('not-a-version')
  })
})
