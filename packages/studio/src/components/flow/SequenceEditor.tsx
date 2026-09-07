'use client'

import { useMemo } from 'react'
import { gapExpr, readLinear, type LinearView, type NodeType, type WorkflowDoc, type WorkflowNode } from '@enkaku/protocol'
import { ArrowDownIcon, ArrowUpIcon, Button, Input, Label, PlusIcon, ShuffleIcon, XIcon, cn } from '@enkaku/ui'
import type { DocEdit, EdgeKind } from './doc-edit'
import { freshNodeId, nodeIdsOf } from './doc-edit'

/**
 * Sequential Mode (plan 313 §4.5) — the client brief's screen 3, and the
 * whole reason this plan exists: building a three-action sequence with delays
 * on the canvas means placing five nodes and dragging five edges, and this is
 * six clicks.
 *
 * It is a LAYOUT, not a second editor. Every gesture below dispatches the
 * same `DocEdit`s the canvas dispatches, against the same document, through
 * the same `useHistory` — so undo, validation, the run overlay and the JSON
 * view all keep working with no knowledge that this screen exists. What the
 * list can show is decided by `readLinear` (plan 313 §3.3), never by a stored
 * flag, which is what makes switching between the two editors reversible.
 */

/**
 * A coalesce key unique to one user gesture. `useHistory` folds every
 * dispatch sharing a key into ONE undo entry, so a reorder undoes as a
 * reorder rather than as the eight edge rewires it is made of — and two
 * reorders in a row stay two entries, because each call gets its own key.
 */
let opSeq = 0
function opKey(prefix: string): string {
  opSeq += 1
  return `seq-${prefix}-${opSeq}`
}

/** The one place a sequence's node positions are decided — a plain column, so opening the same document on the canvas shows a readable chain rather than a pile. */
const COLUMN_X = 240
const ROW_GAP = 110

export function SequenceEditor({
  doc,
  dispatch,
  onOpenNode,
  onAddAction,
  selectedId,
}: {
  doc: WorkflowDoc
  dispatch(edit: DocEdit, coalesceKey?: string): void
  /** Opens the shared `NodePanel` for one row — the ⚙ of the brief's screen 3. */
  onOpenNode(id: string): void
  /**
   * Opens the shared `NodePalette` — the "ADD ACTION" grid of the brief's
   * screen 2 — to insert AFTER `afterNodeId`. It is an insert rather than a
   * plain add because a node dropped unconnected would orphan itself, and an
   * orphan makes `readLinear` refuse the document — which would eject the
   * author from this editor the moment they added their first action.
   */
  onAddAction(afterNodeId: string): void
  selectedId: string | null
}) {
  const linear = useMemo(() => readLinear(doc), [doc])

  if (!linear.ok) {
    return (
      <div className="mx-auto max-w-lg space-y-2 p-8 text-center">
        <p className="text-body font-medium">This workflow is a graph, not a sequence</p>
        <p className="text-body text-dim">{linear.refusal.message}.</p>
        <p className="text-meta text-faint">
          Open it on the canvas to edit it. Sequential Mode becomes available again on its own if the branch is removed — nothing here is one-way.
        </p>
      </div>
    )
  }

  const view = linear.view
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <ActionList doc={doc} view={view} dispatch={dispatch} onOpenNode={onOpenNode} selectedId={selectedId} />
      <Button type="button" variant="outline" className="w-full" onClick={() => onAddAction(view.steps.at(-1)?.node.id ?? view.start.id)}>
        <PlusIcon className="size-4" /> Add action
      </Button>
      <DelayControl doc={doc} view={view} dispatch={dispatch} />
    </div>
  )
}

function ActionList({
  doc,
  view,
  dispatch,
  onOpenNode,
  selectedId,
}: {
  doc: WorkflowDoc
  view: LinearView
  dispatch(edit: DocEdit, coalesceKey?: string): void
  onOpenNode(id: string): void
  selectedId: string | null
}) {
  const steps = view.steps

  /**
   * Reordering rewires `next` rather than moving array entries — plan 300 D1
   * made array order meaningless, so a list that reordered `nodes[]` would
   * look right in this editor and change nothing about what runs.
   */
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= steps.length) return
    const order = steps.map((s) => s.node)
    const [moved] = order.splice(from, 1)
    if (!moved) return
    order.splice(to, 0, moved)
    relink(doc, view, order, dispatch)
  }

  if (steps.length === 0) {
    return <p className="rounded-lg border border-dashed border-border-3 p-8 text-center text-body text-dim">No actions yet. Add the first one below.</p>
  }

  return (
    <ol className="space-y-2">
      {steps.map((step, i) => {
        const node = step.node
        const isShuffle = node.kind === 'shuffle'
        return (
          <li
            key={node.id}
            className={cn(
              'flex items-center gap-3 rounded-lg border border-border-3 bg-panel px-3 py-2.5',
              selectedId === node.id && 'ring-2 ring-accent',
              !node.enabled && 'opacity-50',
            )}
          >
            <div className="flex flex-col">
              <button type="button" aria-label={`Move ${node.title || node.id} up`} disabled={i === 0} onClick={() => move(i, i - 1)} className="disabled:opacity-30">
                <ArrowUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${node.title || node.id} down`}
                disabled={i === steps.length - 1}
                onClick={() => move(i, i + 1)}
                className="disabled:opacity-30"
              >
                <ArrowDownIcon className="size-3.5" />
              </button>
            </div>
            <span className="w-5 shrink-0 text-center text-meta text-faint">{i + 1}</span>
            {/*
              The brief's per-action ON/OFF. It writes `enabled`, so it means
              exactly what the executor does with it: the action is skipped
              and the sequence carries on (plan 313 §3.4).
            */}
            <input
              type="checkbox"
              checked={node.enabled}
              aria-label={`${node.enabled ? 'Switch off' : 'Switch on'} ${node.title || node.id}`}
              onChange={(e) => dispatch({ t: 'update-node', id: node.id, patch: { enabled: e.target.checked } as Partial<WorkflowNode> })}
            />
            <button type="button" className="flex-1 truncate text-left text-[13px]" onClick={() => onOpenNode(node.id)}>
              {isShuffle && <ShuffleIcon className="mr-1.5 inline size-3.5" />}
              {node.title || node.id}
              {isShuffle && <span className="ml-1.5 text-meta text-faint">random order</span>}
              {!node.enabled && <span className="ml-1.5 text-meta text-faint">off</span>}
            </button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenNode(node.id)}>
              Configure
            </Button>
            <button
              type="button"
              aria-label={`Remove ${node.title || node.id}`}
              onClick={() => {
                // Removing the row removes the gap that preceded it too —
                // leaving an orphan delay behind would break `readLinear` and
                // eject the author from the editor they are standing in.
                const ids = [node.id, ...(step.delayBefore ? [step.delayBefore.id] : [])]
                dispatch({ t: 'remove-nodes', ids })
              }}
            >
              <XIcon className="size-4" />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The brief's "DELAY BETWEEN ACTIONS, 1s ~ 10s". One control over every gap:
 * writing it inserts (or repoints, or removes) a `delay` node between each
 * pair of adjacent actions.
 */
function DelayControl({ doc, view, dispatch }: { doc: WorkflowDoc; view: LinearView; dispatch(edit: DocEdit, coalesceKey?: string): void }) {
  const current = view.uniformDelay
  const minSec = current ? String(Math.round(current.minMs / 1000)) : '0'
  const maxSec = current ? String(Math.round(current.maxMs / 1000)) : '0'
  const mixed = current === null && view.steps.some((s) => s.delayBefore !== null)

  const apply = (minMs: number, maxMs: number): void => {
    const key = opKey('delay')
    const existing = view.steps.map((s) => s.delayBefore).filter((d): d is WorkflowNode => d !== null)
    if (maxMs <= 0) {
      if (existing.length > 0) dispatch({ t: 'remove-nodes', ids: existing.map((d) => d.id) }, key)
      return
    }
    // Repoint the gaps that already exist, then relink so the ones that do
    // not get created. Both go through the same `relink` the reorder uses, so
    // there is one definition of "what the chain looks like".
    for (const gap of existing) {
      dispatch({ t: 'update-node', id: gap.id, patch: { ms: gapExpr(minMs, maxMs), maxMs } as Partial<WorkflowNode> }, key)
    }
    if (existing.length < Math.max(0, view.steps.length - 1)) {
      insertMissingGaps(doc, view, minMs, maxMs, dispatch, key)
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-border-3 p-3">
      <Label htmlFor="seq-delay-min">Delay between each action</Label>
      <div className="flex items-center gap-2">
        <Input
          id="seq-delay-min"
          className="w-[92px]"
          inputMode="numeric"
          defaultValue={minSec}
          key={`min-${minSec}`}
          onBlur={(e) => apply(Math.max(0, Number(e.target.value) || 0) * 1000, Math.max(0, Number(maxSec) || 0) * 1000)}
          aria-label="Minimum delay between actions, seconds"
        />
        <span className="text-body text-faint">to</span>
        <Input
          className="w-[92px]"
          inputMode="numeric"
          defaultValue={maxSec}
          key={`max-${maxSec}`}
          onBlur={(e) => apply(Math.max(0, Number(minSec) || 0) * 1000, Math.max(0, Number(e.target.value) || 0) * 1000)}
          aria-label="Maximum delay between actions, seconds"
        />
        <span className="text-body text-faint">seconds</span>
      </div>
      <p className="text-meta text-faint">
        {mixed
          ? 'The gaps in this workflow are not all the same. Typing here sets every one of them; until then they are left as they are.'
          : 'Each action waits a fresh random amount inside this range before it starts. Set the range to 0 to remove the waits.'}
      </p>
    </div>
  )
}

/**
 * Rewires `start -> …order… -> finish`, keeping each action's own gap in
 * front of it.
 *
 * Every dispatch here shares ONE coalesce key, so a reorder is a single undo
 * step rather than the eight `set-edge`s it happens to be made of. The key is
 * unique per call (`opKey`), so two reorders in a row stay two undo steps.
 */
function relink(doc: WorkflowDoc, view: LinearView, order: WorkflowNode[], dispatch: (edit: DocEdit, coalesceKey?: string) => void): void {
  const key = opKey('relink')
  const gapOf = new Map(view.steps.map((s) => [s.node.id, s.delayBefore]))
  // The chain as node ids, gaps included, in the order they will run.
  const chain: string[] = []
  order.forEach((node, i) => {
    const gap = gapOf.get(node.id)
    // A gap only belongs between two actions — the first action never has one.
    if (gap && i > 0) chain.push(gap.id)
    chain.push(node.id)
  })

  // A gap that no longer sits between two actions has nowhere to go — the
  // action it belonged to is now first. Left in the document it would be an
  // orphan, `readLinear` would refuse the document, and the author would be
  // ejected from the editor they are standing in by a reorder. So it is
  // removed, before the rewiring that would otherwise strand it.
  const inChain = new Set(chain)
  const stranded = view.steps
    .map((s) => s.delayBefore)
    .filter((d): d is WorkflowNode => d !== null && !inChain.has(d.id))
    .map((d) => d.id)
  if (stranded.length > 0) dispatch({ t: 'remove-nodes', ids: stranded }, key)

  dispatch({ t: 'set-edge', from: view.start.id, kind: 'next', to: chain[0] }, key)
  chain.forEach((id, i) => {
    dispatch({ t: 'set-edge', from: id, kind: 'next', to: chain[i + 1] ?? view.finish?.id }, key)
  })
  // Re-lay the column so the canvas view of the same document stays readable.
  const positions: Record<string, { x: number; y: number }> = { [view.start.id]: { x: COLUMN_X, y: 0 } }
  chain.forEach((id, i) => {
    positions[id] = { x: COLUMN_X, y: (i + 1) * ROW_GAP }
  })
  if (view.finish) positions[view.finish.id] = { x: COLUMN_X, y: (chain.length + 1) * ROW_GAP }
  dispatch({ t: 'move-nodes', positions }, key)
}

/** Adds a `delay` node in front of every action that has no gap yet. */
function insertMissingGaps(doc: WorkflowDoc, view: LinearView, minMs: number, maxMs: number, dispatch: (edit: DocEdit, coalesceKey?: string) => void, key: string): void {
  const taken = nodeIdsOf(doc)
  for (let i = 1; i < view.steps.length; i++) {
    const step = view.steps[i]
    if (!step || step.delayBefore !== null) continue
    const previous = view.steps[i - 1]
    if (!previous) continue
    const id = freshNodeId('wait', taken)
    taken.add(id)
    dispatch(
      {
        t: 'insert-on-edge',
        edge: { from: previous.node.id, kind: 'next' as EdgeKind },
        node: {
          kind: 'delay',
          id,
          title: 'Wait',
          ui: { x: COLUMN_X, y: 0 },
          enabled: true,
          ms: gapExpr(minMs, maxMs),
          maxMs,
        },
      },
      key,
    )
  }
}

/** Re-exported for the editor shell's mode switch — a document is offered Sequential Mode only when it can actually be read as one. */
export function canUseSequence(doc: WorkflowDoc): boolean {
  return readLinear(doc).ok
}

export type { NodeType }
