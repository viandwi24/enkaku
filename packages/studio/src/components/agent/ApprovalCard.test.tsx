import { describe, expect, test } from 'bun:test'
import type { AgentApproval } from '@enkaku/protocol'
import { ApprovalCard } from './ApprovalCard'

/**
 * `ApprovalCard` (plan 69 §3.3, §7 — "ApprovalCard decisions"). No hooks of
 * its own, so — like `DeviceHeader` and `ToolCallCardView` — it can be
 * called directly with no DOM renderer (see `TileChips.test.tsx`).
 *
 * The one property that MUST hold, because it is the detection mechanism
 * for prompt injection (criterion 7): the exact input is never truncated.
 */

type NodeLike = unknown
interface ElementLike {
  type: unknown
  props: Record<string, unknown>
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node
}

function walk(node: NodeLike, visit: (el: ElementLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  for (const value of Object.values(node.props)) walk(value, visit)
}

function textOf(node: NodeLike): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isElement(node)) return ''
  return textOf(node.props.children as NodeLike)
}

function findButtons(node: NodeLike): ElementLike[] {
  const out: ElementLike[] = []
  walk(node, (el) => {
    // `Button` (the shadcn wrapper) is a function component; its element type carries a name.
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'Button') out.push(el)
  })
  return out
}

const baseApproval: AgentApproval = {
  id: 'appr-1',
  runId: 'run-1',
  threadId: 'thread-1',
  capabilityId: 'device.app.launch',
  toolCallId: 'call-1',
  input: { deviceId: 'dev-1', packageName: 'com.example.definitely-not-mentioned' },
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  createdAt: Math.floor(Date.now() / 1000),
}

describe('ApprovalCard — decisions', () => {
  test('pending shows both decision buttons, neither disabled', () => {
    const el = ApprovalCard({ approval: baseApproval, onDecide: () => undefined, pendingDecision: null })
    const buttons = findButtons(el)
    expect(buttons).toHaveLength(2)
    expect(buttons.every((b) => !b.props.disabled)).toBe(true)
  })

  test('a decision in flight disables both buttons, and names which one is working', () => {
    const el = ApprovalCard({ approval: baseApproval, onDecide: () => undefined, pendingDecision: 'approve' })
    const buttons = findButtons(el)
    expect(buttons.every((b) => b.props.disabled)).toBe(true)
    expect(textOf(el)).toContain('Approving…')
  })

  test('a decided approval shows the outcome, not decision buttons', () => {
    const decided: AgentApproval = { ...baseApproval, status: 'approved', decidedBy: 'alice', decidedAt: baseApproval.createdAt }
    const el = ApprovalCard({ approval: decided, onDecide: () => undefined, pendingDecision: null })
    expect(findButtons(el)).toHaveLength(0)
    expect(textOf(el)).toContain('approved')
    expect(textOf(el)).toContain('alice')
  })

  test('the COMPLETE input is shown, never truncated — the detection mechanism for prompt injection (criterion 7)', () => {
    const suspicious = { deviceId: 'dev-1', packageName: 'com.evil.miner', args: 'x'.repeat(1000) }
    const el = ApprovalCard({ approval: { ...baseApproval, input: suspicious }, onDecide: () => undefined, pendingDecision: null })
    const text = textOf(el)
    expect(text).toContain('com.evil.miner')
    expect(text).toContain('x'.repeat(1000))
    expect(text).not.toContain('…')
  })

  test('with agent/device/thread context, all three are named', () => {
    const el = ApprovalCard({
      approval: baseApproval,
      context: { agentName: 'Triage bot', agentColour: '#7c6df2', deviceLabel: 'moto g06 — rack 1', threadTitle: 'Overnight sweep' },
      onDecide: () => undefined,
      pendingDecision: null,
    })
    const text = textOf(el)
    expect(text).toContain('Triage bot')
    expect(text).toContain('moto g06 — rack 1')
    expect(text).toContain('Overnight sweep')
  })
})
