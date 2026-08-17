import { describe, expect, test } from 'bun:test'
import { WorkflowDocSchema } from '@enkaku/protocol'
import { clearEdge, connectionToEdgeChange, retargetEdge } from './canvas-edit'
import { addGateNode, addScriptNode, emptyDraft, toWorkflowDoc, updateNode, type WorkflowDocDraft } from './model'

function threeNodeDraft(): WorkflowDocDraft {
  let d = emptyDraft()
  d.name = 'wf'
  d = addScriptNode(d, 'a')
  d = addScriptNode(d, 'b')
  d = addGateNode(d) // id 'gate'
  d = updateNode(d, 0, { script: 'demo@1.0.0' })
  d = updateNode(d, 1, { script: 'demo@1.0.0' })
  return d
}

describe('retargetEdge (plan 102 §3.3, §4.2, step 102.5) — the write-back half of deriveGraph', () => {
  test('a script node\'s "next" edge writes a bare node id, forward', () => {
    const d = retargetEdge(threeNodeDraft(), 'a', 'next', 'gate')
    expect(d.nodes[0]).toMatchObject({ kind: 'script', next: 'gate' })
  })

  test('a script node\'s "onFailure" edge writes a GateOutcome goto — the SAME shape GateOutcomeEditor\'s "Jump to a node…" writes', () => {
    const d = retargetEdge(threeNodeDraft(), 'a', 'onFailure', 'b')
    expect(d.nodes[0]).toMatchObject({ kind: 'script', onFailure: { go: 'goto', node: 'b' } })
  })

  test('a gate\'s "then"/"else" edges write a GateOutcome goto', () => {
    let d = retargetEdge(threeNodeDraft(), 'gate', 'then', 'a')
    d = retargetEdge(d, 'gate', 'else', 'b')
    expect(d.nodes[2]).toMatchObject({ kind: 'gate', then: { go: 'goto', node: 'a' }, else: { go: 'goto', node: 'b' } })
  })

  test('a backward target (an earlier node, plan 102 G5) is written exactly the same way as a forward one — direction is not this function\'s concern', () => {
    const d = retargetEdge(threeNodeDraft(), 'gate', 'then', 'a')
    expect(d.nodes[2]).toMatchObject({ then: { go: 'goto', node: 'a' } })
  })

  test('a kind the node does not own is a no-op (defensive — the canvas never renders that handle for that kind)', () => {
    const d = threeNodeDraft()
    expect(retargetEdge(d, 'a', 'then', 'b')).toBe(d) // 'a' is a script node; it has no "then"
    expect(retargetEdge(d, 'gate', 'next', 'a')).toBe(d) // 'gate' is a gate node; it has no "next"
  })

  test('an unknown source node id is a no-op', () => {
    const d = threeNodeDraft()
    expect(retargetEdge(d, 'nope', 'next', 'a')).toBe(d)
  })

  test('an unknown target node id is a no-op — a connection cannot complete onto a node the canvas did not render', () => {
    const d = threeNodeDraft()
    expect(retargetEdge(d, 'a', 'next', 'nope')).toBe(d)
  })
})

describe('clearEdge — deletion reverts to the exact default a freshly-added node already has', () => {
  test('clearing "next" un-sets the explicit override, falling back to array order', () => {
    let d = retargetEdge(threeNodeDraft(), 'a', 'next', 'gate')
    d = clearEdge(d, 'a', 'next')
    expect(d.nodes[0]).toMatchObject({ next: undefined })
  })

  test('clearing "onFailure"/"then"/"else" reverts to the same defaults model.ts\'s newScriptNode/newGateNode give', () => {
    let d = threeNodeDraft()
    d = retargetEdge(d, 'a', 'onFailure', 'b')
    d = retargetEdge(d, 'gate', 'then', 'a')
    d = retargetEdge(d, 'gate', 'else', 'b')
    d = clearEdge(d, 'a', 'onFailure')
    d = clearEdge(d, 'gate', 'then')
    d = clearEdge(d, 'gate', 'else')
    expect(d.nodes[0]).toMatchObject({ onFailure: { go: 'fail' } })
    expect(d.nodes[2]).toMatchObject({ then: { go: 'continue' }, else: { go: 'stop' } })
    // Byte-identical to a node that was never retargeted at all.
    expect(d).toEqual(threeNodeDraft())
  })
})

describe('connectionToEdgeChange — the library Connection shape, translated', () => {
  test('a complete connection with a recognised handle id resolves', () => {
    expect(connectionToEdgeChange({ source: 'a', sourceHandle: 'next', target: 'b' })).toEqual({ nodeId: 'a', kind: 'next', targetId: 'b' })
  })

  test('an incomplete connection (dropped over empty canvas) resolves to null', () => {
    expect(connectionToEdgeChange({ source: 'a', sourceHandle: 'next', target: null })).toBeNull()
    expect(connectionToEdgeChange({ source: null, sourceHandle: 'next', target: 'b' })).toBeNull()
    expect(connectionToEdgeChange({ source: 'a', sourceHandle: null, target: 'b' })).toBeNull()
  })

  test('an unrecognised handle id resolves to null rather than a bogus kind', () => {
    expect(connectionToEdgeChange({ source: 'a', sourceHandle: 'target', target: 'b' })).toBeNull()
  })
})

describe('H3 round-trip (plan 102 §7) — a canvas edit and a list edit commute wherever order is semantically irrelevant', () => {
  test('retargeting an edge on one node and editing another node\'s title produce the same document regardless of order', () => {
    const base = threeNodeDraft()

    const canvasThenList = updateNode(retargetEdge(base, 'a', 'next', 'gate'), 1, { title: 'Renamed via list' })
    const listThenCanvas = retargetEdge(updateNode(base, 1, { title: 'Renamed via list' }), 'a', 'next', 'gate')

    expect(canvasThenList).toEqual(listThenCanvas)

    const parsedA = toWorkflowDoc(canvasThenList)
    const parsedB = toWorkflowDoc(listThenCanvas)
    expect(parsedA.success && parsedB.success).toBe(true)
    if (parsedA.success && parsedB.success) {
      expect(WorkflowDocSchema.parse(parsedA.data)).toEqual(WorkflowDocSchema.parse(parsedB.data))
    }
  })

  test('editing THE SAME node through canvas (onFailure) and through the list (title) also commutes — the merge is a plain object spread in updateNode either way', () => {
    const base = threeNodeDraft()

    const canvasThenList = updateNode(retargetEdge(base, 'a', 'onFailure', 'b'), 0, { title: 'Step A' })
    const listThenCanvas = retargetEdge(updateNode(base, 0, { title: 'Step A' }), 'a', 'onFailure', 'b')

    expect(canvasThenList).toEqual(listThenCanvas)
  })

  test('opening the canvas after a list edit, then reopening the list after a canvas edit, never resurrects a cleared field (delete commutes too)', () => {
    const base = retargetEdge(threeNodeDraft(), 'a', 'next', 'gate')

    // canvas: clear the edge, then list: rename node 'b'
    const canvasFirst = updateNode(clearEdge(base, 'a', 'next'), 1, { title: 'B' })
    // list: rename node 'b', then canvas: clear the edge
    const listFirst = clearEdge(updateNode(base, 1, { title: 'B' }), 'a', 'next')

    expect(canvasFirst).toEqual(listFirst)
    expect(canvasFirst.nodes[0]).toMatchObject({ next: undefined })
  })
})
