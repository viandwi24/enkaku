'use client'

import { useEffect, useMemo, useState } from 'react'
import { gapExpr, planSequence, readGap, readLinear, type LinearView, type NodeType, type WorkflowDoc, type WorkflowNode } from '@enkaku/protocol'
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
      <ShuffleToggle doc={doc} view={view} dispatch={dispatch} />
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

  /**
   * Removing a row has to BRIDGE the sequence, not just delete a node.
   * `remove-nodes` clears every edge that pointed at what it removed — right
   * for the canvas, where deleting a node must not invent an edge between two
   * nodes the author never connected, and wrong here: it would leave
   * `start -> a` dangling with `c` orphaned, `readLinear` would refuse the
   * document, and deleting one action would eject the author from the editor.
   * So the removal is followed by a `relink` over what remains, which writes
   * every edge explicitly and repairs the ones the delete cleared.
   *
   * A shuffle's members are PROMOTED into the sequence where the shuffle was,
   * rather than deleted with it. They are actions the author configured, and
   * they were only ever reachable through the shuffle — dropping the
   * container should stop the shuffling, not silently throw away the work.
   * `relink`'s own stranded-gap sweep removes the wait that preceded the row.
   */
  const remove = (index: number): void => {
    const target = steps[index]
    if (!target) return
    const key = opKey('remove')
    const promoted = target.node.kind === 'shuffle' ? target.node.members.flatMap((id) => doc.nodes.filter((n) => n.id === id)) : []
    const order = steps.flatMap((s, i) => (i === index ? promoted : [s.node]))
    dispatch({ t: 'remove-nodes', ids: [target.node.id] }, key)
    relink(doc, view, order, dispatch, key)
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
              onClick={() => remove(i)}
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
  const mixed = current === null && view.steps.some((s) => s.delayBefore !== null)

  /**
   * The two fields are LOCAL state, not values derived from the document on
   * every render, for two reasons that were both bugs first:
   *
   * - Blurring one field has to read what the OTHER field currently shows,
   *   not what the document currently stores. Reading the document meant
   *   that with mixed gaps — where the document has no single answer, so both
   *   derived values were "0" — typing a minimum and tabbing away called
   *   `apply(min, 0)` and silently deleted every wait in the workflow.
   * - An empty field is not the same as a zero one. `''` means "no answer
   *   yet" and applies nothing; `'0'` is the author saying *remove the
   *   waits*, and still does exactly that.
   */
  const seed = (n: number | undefined): string => (n === undefined ? '' : String(Math.round(n / 1000)))
  const [minText, setMinText] = useState(seed(current?.minMs))
  const [maxText, setMaxText] = useState(seed(current?.maxMs))

  // Re-seed when the DOCUMENT's gaps change under us — an undo, a reorder, or
  // an edit on the canvas — but never on every render, which would fight the
  // author mid-keystroke.
  useEffect(() => {
    setMinText(seed(current?.minMs))
    setMaxText(seed(current?.maxMs))
  }, [current?.minMs, current?.maxMs])

  const apply = (): void => {
    // Nothing to do until the author has actually given both numbers. This is
    // what makes the mixed-gaps case safe: the fields start empty, so tabbing
    // through them changes nothing.
    if (minText.trim() === '' || maxText.trim() === '') return
    const minMs = Math.max(0, Number(minText) || 0) * 1000
    const maxMs = Math.max(0, Number(maxText) || 0) * 1000
    if (maxMs < minMs) return

    const key = opKey('delay')
    const existing = view.steps.map((s) => s.delayBefore).filter((d): d is WorkflowNode => d !== null)
    if (maxMs <= 0) {
      if (existing.length > 0) dispatch({ t: 'remove-nodes', ids: existing.map((d) => d.id) }, key)
      return
    }
    // Repoint the gaps that already exist, then add the ones that do not.
    for (const gap of existing) {
      dispatch({ t: 'update-node', id: gap.id, patch: { ms: gapExpr(minMs, maxMs), maxMs } as Partial<WorkflowNode> }, key)
    }
    if (existing.length < Math.max(0, view.steps.length - 1)) {
      insertMissingGaps(doc, view, minMs, maxMs, dispatch, key)
    }
  }

  const inverted = minText.trim() !== '' && maxText.trim() !== '' && Number(maxText) < Number(minText)

  return (
    <div className="space-y-1.5 rounded-lg border border-border-3 p-3">
      <Label htmlFor="seq-delay-min">Delay between each action</Label>
      <div className="flex items-center gap-2">
        <Input
          id="seq-delay-min"
          className="w-[92px]"
          inputMode="numeric"
          value={minText}
          onChange={(e) => setMinText(e.target.value)}
          onBlur={apply}
          placeholder={mixed ? '—' : '0'}
          aria-label="Minimum delay between actions, seconds"
        />
        <span className="text-body text-faint">to</span>
        <Input
          className="w-[92px]"
          inputMode="numeric"
          value={maxText}
          onChange={(e) => setMaxText(e.target.value)}
          onBlur={apply}
          placeholder={mixed ? '—' : '0'}
          aria-label="Maximum delay between actions, seconds"
        />
        <span className="text-body text-faint">seconds</span>
      </div>
      <p className="text-meta text-faint">
        {inverted
          ? 'The range is inverted — the second number has to be at least the first.'
          : mixed
            ? 'The gaps in this workflow are not all the same, so there is no single range to show. Filling both fields sets every one of them; leaving them empty changes nothing.'
            : 'Each action waits a fresh random amount inside this range before it starts. Set both to 0 to remove the waits.'}
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
function relink(doc: WorkflowDoc, view: LinearView, order: WorkflowNode[], dispatch: (edit: DocEdit, coalesceKey?: string) => void, sharedKey?: string): void {
  const key = sharedKey ?? opKey('relink')
  // The chain and the gaps it leaves behind are decided by `planSequence`
  // (`@enkaku/protocol`), which is pure and tested — this file only turns its
  // answer into dispatches.
  const { chain, stranded } = planSequence(view, order)
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

/**
 * The brief's screen 2: "Shuffle order — each device runs actions in a random
 * order", as one switch over the whole sequence.
 *
 * This is the gesture §4.5 promised and the first implementation did not
 * deliver: the node panel's member picker offers only nodes with no `next`,
 * and every action in a linear chain has one — so from this editor nothing
 * was ever selectable. Wrapping is the operation an author actually wants
 * anyway ("run these in a random order"), and it is reversible: turning the
 * switch off puts the members back in the list in their stored order.
 *
 * The gaps survive the round trip as the shuffle's own `between`, which is
 * why that field exists — a member declares no `next`, so there is no edge
 * for a `delay` node to sit on.
 */
function ShuffleToggle({ doc, view, dispatch }: { doc: WorkflowDoc; view: LinearView; dispatch(edit: DocEdit, coalesceKey?: string): void }) {
  const only = view.steps.length === 1 ? view.steps[0]?.node : undefined
  const shuffle = only?.kind === 'shuffle' ? only : undefined
  const on = shuffle !== undefined
  const actionCount = on ? (shuffle?.members.length ?? 0) : view.steps.length

  const toggle = (): void => {
    const key = opKey('shuffle')
    if (shuffle) {
      // Unwrap: the members become the sequence again, and the shuffle's own
      // `between` becomes ordinary gaps between them.
      const members = shuffle.members.flatMap((id) => doc.nodes.filter((n) => n.id === id))
      dispatch({ t: 'remove-nodes', ids: [shuffle.id] }, key)
      relink(doc, view, members, dispatch, key)
      if (shuffle.betweenMaxMs > 0) {
        const unwrapped: LinearView = { ...view, steps: members.map((node) => ({ node, delayBefore: null })) }
        insertMissingGaps(doc, unwrapped, 0, shuffle.betweenMaxMs, dispatch, key)
      }
      return
    }
    const members = view.steps.map((s) => s.node)
    if (members.length < 2) return
    // The gaps between the actions become the shuffle's `between`, so the
    // author's "1 to 10 seconds" survives being wrapped.
    const gaps = view.steps.map((s) => (s.delayBefore ? readGap(s.delayBefore) : null)).filter((g): g is { minMs: number; maxMs: number } => g !== null)
    const range = gaps[0] ?? { minMs: 0, maxMs: 0 }
    const id = freshNodeId('shuffle', nodeIdsOf(doc))
    dispatch(
      {
        t: 'add-node',
        node: {
          kind: 'shuffle',
          id,
          title: 'Shuffle order',
          ui: { x: COLUMN_X, y: ROW_GAP },
          enabled: true,
          members: members.map((m) => m.id),
          between: gapExpr(range.minMs, range.maxMs),
          betweenMaxMs: range.maxMs,
        },
      },
      key,
    )
    // The members lose their own `next` — the shuffle decides what follows
    // each of them — and every gap node goes, since there is no edge left for
    // one to sit on. `relink` over just the shuffle rewires start -> sh -> end.
    for (const m of members) dispatch({ t: 'set-edge', from: m.id, kind: 'next', to: undefined }, key)
    const gapIds = view.steps.map((s) => s.delayBefore).filter((d): d is WorkflowNode => d !== null).map((d) => d.id)
    if (gapIds.length > 0) dispatch({ t: 'remove-nodes', ids: gapIds }, key)
    dispatch({ t: 'set-edge', from: view.start.id, kind: 'next', to: id }, key)
    dispatch({ t: 'set-edge', from: id, kind: 'next', to: view.finish?.id }, key)
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-3 p-3">
      <input type="checkbox" id="seq-shuffle" checked={on} onChange={toggle} disabled={!on && view.steps.length < 2} />
      <Label htmlFor="seq-shuffle" className="flex-1">
        <span className="flex items-center gap-1.5">
          <ShuffleIcon className="size-3.5" /> Shuffle order
        </span>
        <span className="mt-0.5 block text-meta font-normal text-faint">
          {on
            ? `Each device runs these ${actionCount} actions in its own random order.`
            : view.steps.length < 2
              ? 'Add at least two actions to shuffle them.'
              : 'Each device runs the actions in a random order instead of top to bottom. The delay between actions is kept.'}
        </span>
      </Label>
    </div>
  )
}
