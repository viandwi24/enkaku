'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  gapExpr,
  groupSplitCases,
  planSequence,
  readBetween,
  readGap,
  readGrouped,
  readLinear,
  type GroupedView,
  type LinearStep,
  type LinearView,
  type NodeType,
  type WorkflowDoc,
  type WorkflowNode,
} from '@enkaku/protocol'
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

/**
 * One editable chain of actions, and the two edges that hold it in place.
 *
 * A plain sequence hangs off `start.next` and ends at the document's finish.
 * A share of a grouped workflow hangs off one of the split's `case:i` edges
 * and ends at the same finish as its siblings. Everything between those two
 * anchors — reordering, gaps, the shuffle wrapper, add and remove — is
 * identical, so the row list takes a slot rather than a `LinearView` and both
 * modes drive the exact same code. Two copies of this interaction logic would
 * have drifted on the first fix that landed in one of them.
 */
export interface ChainSlot {
  /** The edge the chain hangs from. */
  head: { from: string; kind: EdgeKind }
  /** What the last action points at once the chain ends. */
  tailTo: string | undefined
  steps: LinearStep[]
  uniformDelay: { minMs: number; maxMs: number } | null
  /** Where to re-lay this chain on the canvas, so shares sit side by side instead of on top of each other. */
  columnX: number
  /** Laid out above the chain when this slot owns it — only a plain sequence does; shares share one split. */
  layoutHead: boolean
}

/** The whole document as one chain. */
function linearSlot(view: LinearView): ChainSlot {
  return { head: { from: view.start.id, kind: 'next' }, tailTo: view.finish?.id, steps: view.steps, uniformDelay: view.uniformDelay, columnX: COLUMN_X, layoutHead: true }
}

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
  onAddAction(from: string, edge: EdgeKind): void
  selectedId: string | null
}) {
  const linear = useMemo(() => readLinear(doc), [doc])
  const grouped = useMemo(() => readGrouped(doc), [doc])

  /*
    Grouped first, because the two readings are mutually exclusive by
    construction: a document with a split is never linear (`readLinear`
    refuses every switch), and one without a split is never grouped. Reading
    both and preferring the grouped one keeps this a single easy mode with an
    option inside it, rather than a third button an author has to know to
    press.
  */
  if (grouped.ok) {
    return <GroupsEditor doc={doc} view={grouped.view} dispatch={dispatch} onOpenNode={onOpenNode} onAddAction={onAddAction} selectedId={selectedId} />
  }

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
  const slot = linearSlot(view)
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <ActionList doc={doc} slot={slot} dispatch={dispatch} onOpenNode={onOpenNode} selectedId={selectedId} />
      <ShuffleToggle doc={doc} slot={slot} dispatch={dispatch} />
      <Button type="button" variant="outline" className="w-full" onClick={() => onAddAction(slot.steps.at(-1)?.node.id ?? view.start.id, 'next')}>
        <PlusIcon className="size-4" /> Add action
      </Button>
      <DelayControl doc={doc} slot={slot} dispatch={dispatch} />
      <SplitControl doc={doc} view={view} dispatch={dispatch} />
    </div>
  )
}

function ActionList({
  doc,
  slot,
  dispatch,
  onOpenNode,
  selectedId,
}: {
  doc: WorkflowDoc
  slot: ChainSlot
  dispatch(edit: DocEdit, coalesceKey?: string): void
  onOpenNode(id: string): void
  selectedId: string | null
}) {
  const steps = slot.steps

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
    relink(doc, slot, order, dispatch)
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
    relink(doc, slot, order, dispatch, key)
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
function DelayControl({ doc, slot, dispatch }: { doc: WorkflowDoc; slot: ChainSlot; dispatch(edit: DocEdit, coalesceKey?: string): void }) {
  const current = slot.uniformDelay
  const mixed = current === null && slot.steps.some((s) => s.delayBefore !== null)

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
    const existing = slot.steps.map((s) => s.delayBefore).filter((d): d is WorkflowNode => d !== null)
    if (maxMs <= 0) {
      if (existing.length > 0) dispatch({ t: 'remove-nodes', ids: existing.map((d) => d.id) }, key)
      return
    }
    // Repoint the gaps that already exist, then add the ones that do not.
    for (const gap of existing) {
      dispatch({ t: 'update-node', id: gap.id, patch: { ms: gapExpr(minMs, maxMs), maxMs } as Partial<WorkflowNode> }, key)
    }
    if (existing.length < Math.max(0, slot.steps.length - 1)) {
      insertMissingGaps(doc, slot, minMs, maxMs, dispatch, key)
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
function relink(doc: WorkflowDoc, slot: ChainSlot, order: WorkflowNode[], dispatch: (edit: DocEdit, coalesceKey?: string) => void, sharedKey?: string): void {
  const key = sharedKey ?? opKey('relink')
  // The chain and the gaps it leaves behind are decided by `planSequence`
  // (`@enkaku/protocol`), which is pure and tested — this file only turns its
  // answer into dispatches.
  const { chain, stranded } = planSequence(slot, order)
  if (stranded.length > 0) dispatch({ t: 'remove-nodes', ids: stranded }, key)

  dispatch({ t: 'set-edge', from: slot.head.from, kind: slot.head.kind, to: chain[0] }, key)
  /*
    A failure edge that FOLLOWS the line has to be carried along with it.

    A script may say "if this fails, carry on with the next action" by
    pointing `onFailure` at the very node `next` points at. Rewriting only
    `next` on a reorder would leave that failure edge aimed at the action's
    old neighbour — which is a jump backwards or a skip, a real branch, and
    `readLinear` would then refuse the document and eject the author from the
    editor they were working in. So the intent is read from the node as it
    stands BEFORE this rewrite, and re-aimed at wherever `next` now goes.

    A failure edge pointing at the finish means something different — "stop
    the run here" — and is left exactly where it is.
  */
  const before = new Map(doc.nodes.map((n) => [n.id, n]))
  chain.forEach((id, i) => {
    const to = chain[i + 1] ?? slot.tailTo
    dispatch({ t: 'set-edge', from: id, kind: 'next', to }, key)
    const node = before.get(id)
    if (node?.kind !== 'script' || node.onFailure === undefined) return
    if (node.onFailure !== node.next) return
    dispatch({ t: 'set-edge', from: id, kind: 'onFailure', to }, key)
  })
  // Re-lay the column so the canvas view of the same document stays readable.
  const positions: Record<string, { x: number; y: number }> = slot.layoutHead ? { [slot.head.from]: { x: slot.columnX, y: 0 } } : {}
  chain.forEach((id, i) => {
    positions[id] = { x: slot.columnX, y: (i + 1) * ROW_GAP }
  })
  // Only a slot that owns its tail places it: four shares all ending at one
  // finish would otherwise each drag it under their own column.
  if (slot.layoutHead && slot.tailTo) positions[slot.tailTo] = { x: slot.columnX, y: (chain.length + 1) * ROW_GAP }
  dispatch({ t: 'move-nodes', positions }, key)
}

/** Adds a `delay` node in front of every action that has no gap yet. */
function insertMissingGaps(doc: WorkflowDoc, slot: ChainSlot, minMs: number, maxMs: number, dispatch: (edit: DocEdit, coalesceKey?: string) => void, key: string): void {
  const taken = nodeIdsOf(doc)
  for (let i = 1; i < slot.steps.length; i++) {
    const step = slot.steps[i]
    if (!step || step.delayBefore !== null) continue
    const previous = slot.steps[i - 1]
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
    // The gap now sits on the `next` edge, so a failure edge that was
    // following that same line has to move onto it too — otherwise it skips
    // the wait, stops matching `next`, and becomes a branch the list cannot
    // show. Same rule as `relink`: only an edge that was following, never one
    // that ends the run.
    if (previous.node.kind === 'script' && previous.node.onFailure !== undefined && previous.node.onFailure === previous.node.next) {
      dispatch({ t: 'set-edge', from: previous.node.id, kind: 'onFailure' as EdgeKind, to: id }, key)
    }
  }
}

/** Re-exported for the editor shell's mode switch — a document is offered Sequential Mode only when it can actually be read as one. */
export function canUseSequence(doc: WorkflowDoc): boolean {
  return readLinear(doc).ok
}

/**
 * Whether the easy editor can open this document at all — a plain sequence OR
 * a fleet split into shares.
 *
 * One button, two shapes. Grouping is an option INSIDE the easy mode rather
 * than a third mode beside it: an author who splits their sequence should not
 * find the editor they were using has disappeared from the toolbar.
 */
export function canUseEasy(doc: WorkflowDoc): boolean {
  return readLinear(doc).ok || readGrouped(doc).ok
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
function ShuffleToggle({ doc, slot, dispatch }: { doc: WorkflowDoc; slot: ChainSlot; dispatch(edit: DocEdit, coalesceKey?: string): void }) {
  const only = slot.steps.length === 1 ? slot.steps[0]?.node : undefined
  const shuffle = only?.kind === 'shuffle' ? only : undefined
  const on = shuffle !== undefined
  const actionCount = on ? (shuffle?.members.length ?? 0) : slot.steps.length

  const toggle = (): void => {
    const key = opKey('shuffle')
    if (shuffle) {
      // Unwrap: the members become the sequence again, and the shuffle's own
      // `between` becomes ordinary gaps between them.
      const members = shuffle.members.flatMap((id) => doc.nodes.filter((n) => n.id === id))
      dispatch({ t: 'remove-nodes', ids: [shuffle.id] }, key)
      relink(doc, slot, members, dispatch, key)
      // The shuffle's own `between` becomes ordinary gaps again, MINIMUM
      // included — reading only `betweenMaxMs` here turned a 5-10 s wait into
      // a 0-10 s one every time an author unwrapped a sequence.
      const between = readBetween(shuffle)
      if (between !== null && between.maxMs > 0) {
        const unwrapped: ChainSlot = { ...slot, steps: members.map((node) => ({ node, delayBefore: null })) }
        insertMissingGaps(doc, unwrapped, between.minMs, between.maxMs, dispatch, key)
      }
      return
    }
    const members = slot.steps.map((s) => s.node)
    if (members.length < 2) return
    // The gaps between the actions become the shuffle's `between`, so the
    // author's "1 to 10 seconds" survives being wrapped.
    const gaps = slot.steps.map((s) => (s.delayBefore ? readGap(s.delayBefore) : null)).filter((g): g is { minMs: number; maxMs: number } => g !== null)
    const range = gaps[0] ?? { minMs: 0, maxMs: 0 }
    const id = freshNodeId('shuffle', nodeIdsOf(doc))
    dispatch(
      {
        t: 'add-node',
        node: {
          kind: 'shuffle',
          id,
          title: 'Shuffle order',
          // Wrapping a sequence keeps the failure policy it already had: its
          // actions aborted the run when one failed, and they still do until
          // the author turns "keep going" on.
          continueOnMemberFailure: false,
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
    const gapIds = slot.steps.map((s) => s.delayBefore).filter((d): d is WorkflowNode => d !== null).map((d) => d.id)
    if (gapIds.length > 0) dispatch({ t: 'remove-nodes', ids: gapIds }, key)
    dispatch({ t: 'set-edge', from: slot.head.from, kind: slot.head.kind, to: id }, key)
    dispatch({ t: 'set-edge', from: id, kind: 'next', to: slot.tailTo }, key)
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-3 p-3">
      <div className="flex items-center gap-3">
      <input type="checkbox" id="seq-shuffle" checked={on} onChange={toggle} disabled={!on && slot.steps.length < 2} />
      <Label htmlFor="seq-shuffle" className="flex-1">
        <span className="flex items-center gap-1.5">
          <ShuffleIcon className="size-3.5" /> Shuffle order
        </span>
        <span className="mt-0.5 block text-meta font-normal text-faint">
          {on
            ? `Each device runs these ${actionCount} actions in its own random order.`
            : slot.steps.length < 2
              ? 'Add at least two actions to shuffle them.'
              : 'Each device runs the actions in a random order instead of top to bottom. The delay between actions is kept.'}
        </span>
      </Label>
      </div>
      {/*
        The failure policy, offered only once there IS a shuffle to hold it.

        Without it the only expressible policies were "end the run" and "go to
        the finish": a member declares no `next` — the shuffle picks the order
        at run time — so there is no node an author could point `onFailure` at
        to mean "carry on with the others". On the owner's farm five devices
        each lost a whole six-minute warm-up, and seven already-successful
        scripts with it, to one action that met a screen it could not read.
      */}
      {on && shuffle && (
        <div className="flex items-center gap-3 border-t border-border-3 pt-2">
          <input
            type="checkbox"
            id="seq-shuffle-keep-going"
            checked={shuffle.continueOnMemberFailure}
            onChange={(e) =>
              dispatch(
                { t: 'update-node', id: shuffle.id, patch: { continueOnMemberFailure: e.target.checked } as Partial<WorkflowNode> },
                `shuffle-keep-going:${shuffle.id}`,
              )
            }
          />
          <Label htmlFor="seq-shuffle-keep-going" className="flex-1">
            Keep going if one action fails
            <span className="mt-0.5 block text-meta font-normal text-faint">
              {shuffle.continueOnMemberFailure
                ? 'A failed action is recorded and the rest still run.'
                : 'One failed action ends the whole run, and the actions that already succeeded are recorded as a failed run.'}
            </span>
          </Label>
        </div>
      )}
    </div>
  )
}

/** One share's chain, hung off the split's `case:i` edge instead of `start.next`. */
function groupSlot(view: GroupedView, index: number, steps: LinearStep[], uniformDelay: ChainSlot['uniformDelay']): ChainSlot {
  return {
    head: { from: view.split.id, kind: `case:${index}` as EdgeKind },
    tailTo: view.finishes[0]?.id,
    steps,
    uniformDelay,
    // Side by side, so the canvas view of a grouped document reads as shares
    // rather than as four chains stacked in one column.
    columnX: COLUMN_X + index * 320,
    layoutHead: false,
  }
}

/** The `switch` node a G-way split is written as — the one shape `readGrouped` reads back. */
function splitNodeFor(id: string, groupCount: number, firstTarget: string | undefined, y: number): WorkflowNode {
  return {
    kind: 'switch',
    id,
    title: `Split ${groupCount} ways`,
    ui: { x: COLUMN_X, y },
    enabled: true,
    mode: 'predicate',
    cases: groupSplitCases(groupCount, [{ to: firstTarget }]),
  }
}

/**
 * Turns a plain sequence into shares of the fleet — the brief's "20 devices,
 * 5 and 5 and 5 and 5, each doing something different".
 *
 * The existing actions stay put as group 1; the new groups start empty. What
 * this writes is an ordinary `switch` on `$run.index % G`, which is what the
 * engine has always run — the author simply never had a way to say it without
 * typing the expression.
 */
function SplitControl({ doc, view, dispatch }: { doc: WorkflowDoc; view: LinearView; dispatch(edit: DocEdit, coalesceKey?: string): void }) {
  const split = (groupCount: number): void => {
    const key = opKey('split')
    const id = freshNodeId('split', nodeIdsOf(doc))
    const head = view.steps[0]?.delayBefore?.id ?? view.steps[0]?.node.id
    dispatch({ t: 'add-node', node: splitNodeFor(id, groupCount, head, ROW_GAP) }, key)
    dispatch({ t: 'set-edge', from: view.start.id, kind: 'next', to: id }, key)
  }
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[13px] font-medium">Split the devices into groups</p>
      <p className="text-meta text-faint">
        Each group runs its own list of actions. Which phone lands in which group follows the run&rsquo;s device order — pick Random when you start the run to
        draw it fresh each time.
      </p>
      <div className="mt-2 flex gap-2">
        {[2, 3, 4].map((n) => (
          <Button key={n} type="button" variant="outline" size="sm" onClick={() => split(n)}>
            {n} groups
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * The same easy mode, once the fleet is split into shares.
 *
 * Every share drives the SAME `ActionList`, `ShuffleToggle` and `DelayControl`
 * as a plain sequence — only the two anchor edges differ, which is the whole
 * point of `ChainSlot`. What is stored stays an ordinary v2 document: one
 * `switch` on `$run.index % G`, one chain per case. The canvas can open it,
 * the executor has always run it, and nothing here is a second format.
 */
function GroupsEditor({
  doc,
  view,
  dispatch,
  onOpenNode,
  onAddAction,
  selectedId,
}: {
  doc: WorkflowDoc
  view: GroupedView
  dispatch(edit: DocEdit, coalesceKey?: string): void
  onOpenNode(id: string): void
  onAddAction(from: string, edge: EdgeKind): void
  selectedId: string | null
}) {
  const setGroupCount = (next: number): void => {
    const key = opKey('group-count')
    const cases = groupSplitCases(next, view.groups.map((g) => ({ to: g.headId, label: g.label })))
    dispatch({ t: 'update-node', id: view.split.id, patch: { title: `Split ${next} ways`, cases } as Partial<WorkflowNode> }, key)
  }

  /*
    Ungrouping keeps every action rather than dropping the shares it cannot
    show: the lists are concatenated in group order, which is lossless and
    reversible by splitting again. The alternative — deleting all but the
    first share — throws away work an author did, silently, on a control that
    reads like a view toggle.
  */
  const ungroup = (): void => {
    const key = opKey('ungroup')
    const steps = view.groups.flatMap((g) => g.steps)
    const slot: ChainSlot = {
      // A stagger stays where it is and the chain hangs off it, so the wait
      // survives the change instead of being quietly dropped.
      head: view.stagger ? { from: view.stagger.node.id, kind: 'next' } : { from: view.start.id, kind: 'next' },
      tailTo: view.finishes[0]?.id,
      steps,
      uniformDelay: null,
      columnX: COLUMN_X,
      layoutHead: true,
    }
    relink(doc, slot, steps.map((s) => s.node), dispatch, key)
    // The split's own fallback finish, and any share that ended at its own,
    // are unreachable the moment the split goes — and an orphan makes the
    // document refuse to open as a list at all.
    const keep = view.finishes[0]?.id
    const doomed = doc.nodes.filter((n) => n.kind === 'finish' && n.id !== keep).map((n) => n.id)
    dispatch({ t: 'remove-nodes', ids: [view.split.id, ...doomed] }, key)
  }

  const lastGroupEmpty = (view.groups.at(-1)?.steps.length ?? 0) === 0

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <StaggerControl doc={doc} view={view} dispatch={dispatch} />

      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <p className="mr-auto text-[13px] font-medium">{view.groupCount} groups</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setGroupCount(view.groupCount + 1)} disabled={view.groupCount >= 8}>
          <PlusIcon className="size-4" /> Add group
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => (view.groupCount > 2 ? setGroupCount(view.groupCount - 1) : ungroup())}
          disabled={!lastGroupEmpty}
          title={lastGroupEmpty ? undefined : 'Remove the last group’s actions first'}
        >
          {view.groupCount > 2 ? 'Remove group' : 'Ungroup'}
        </Button>
        {view.groupCount > 2 && (
          <Button type="button" variant="ghost" size="sm" onClick={ungroup}>
            Ungroup
          </Button>
        )}
      </div>

      {view.groups.map((group) => {
        const slot = groupSlot(view, group.index, group.steps, group.uniformDelay)
        return (
          <section key={group.index} className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <span className="text-meta text-faint">Group {group.index + 1}</span>
              <Input
                value={group.label}
                onChange={(e) => {
                  const cases = groupSplitCases(
                    view.groupCount,
                    view.groups.map((g, i) => ({ to: g.headId, label: i === group.index ? e.target.value.slice(0, 40) : g.label })),
                  )
                  dispatch({ t: 'update-node', id: view.split.id, patch: { cases } as Partial<WorkflowNode> }, `group-label:${group.index}`)
                }}
                placeholder={`Group ${group.index + 1}`}
                className="h-8 max-w-[220px]"
              />
            </div>
            <ActionList doc={doc} slot={slot} dispatch={dispatch} onOpenNode={onOpenNode} selectedId={selectedId} />
            <ShuffleToggle doc={doc} slot={slot} dispatch={dispatch} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                const last = slot.steps.at(-1)?.node.id
                if (last === undefined) onAddAction(slot.head.from, slot.head.kind)
                else onAddAction(last, 'next')
              }}
            >
              <PlusIcon className="size-4" /> Add action
            </Button>
            <DelayControl doc={doc} slot={slot} dispatch={dispatch} />
          </section>
        )
      })}
    </div>
  )
}

/**
 * The wait before the split — "hold each device a random moment so twenty
 * phones do not all begin on the same second".
 *
 * It is stored as one `delay` between `start` and the split, which is what
 * the owner's `tiktok-split-staggered` already does by hand. Deliberately NOT
 * confused with the Run dialog's per-device start delay: that one paces how
 * the batch is dispatched, this one is part of the workflow and travels with
 * it wherever it runs.
 */
function StaggerControl({ doc, view, dispatch }: { doc: WorkflowDoc; view: GroupedView; dispatch(edit: DocEdit, coalesceKey?: string): void }) {
  const stagger = view.stagger
  const write = (minMs: number, maxMs: number): void => {
    if (stagger === null) return
    dispatch(
      { t: 'update-node', id: stagger.node.id, patch: { ms: gapExpr(minMs, maxMs), maxMs } as Partial<WorkflowNode> },
      `stagger:${stagger.node.id}`,
    )
  }
  if (stagger === null) {
    return (
      <div className="flex items-center gap-2 rounded-lg border p-3">
        <p className="mr-auto text-[13px] font-medium">All devices start together</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const id = freshNodeId('stagger', nodeIdsOf(doc))
            dispatch({
              t: 'insert-on-edge',
              edge: { from: view.start.id, kind: 'next' },
              node: { kind: 'delay', id, title: 'Stagger', ui: { x: COLUMN_X, y: 0 }, enabled: true, ms: gapExpr(0, 30_000), maxMs: 30_000 },
            })
          }}
        >
          Stagger their start
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-1.5 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <p className="mr-auto text-[13px] font-medium">Stagger each device&rsquo;s start</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            const key = opKey('unstagger')
            // Bridge before removing, or `start` is left pointing at nothing.
            dispatch({ t: 'set-edge', from: view.start.id, kind: 'next', to: view.split.id }, key)
            dispatch({ t: 'remove-nodes', ids: [stagger.node.id] }, key)
          }}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          value={String(Math.round(stagger.minMs / 1000))}
          onChange={(e) => write(Math.max(0, Number(e.target.value) || 0) * 1000, stagger.maxMs)}
          className="h-8 w-24"
          aria-label="Minimum start delay, seconds"
        />
        <span className="text-meta text-faint">–</span>
        <Input
          type="number"
          min={0}
          value={String(Math.round(stagger.maxMs / 1000))}
          onChange={(e) => {
            const max = Math.max(0, Number(e.target.value) || 0) * 1000
            write(Math.min(stagger.minMs, max), max)
          }}
          className="h-8 w-24"
          aria-label="Maximum start delay, seconds"
        />
        <span className="text-meta text-faint">seconds</span>
      </div>
    </div>
  )
}
