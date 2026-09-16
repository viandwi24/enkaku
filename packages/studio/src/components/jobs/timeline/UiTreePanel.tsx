'use client'

import { useEffect, useMemo, useState } from 'react'
import { UiNodeSchema, type JobTraceEvent, type UiNode } from '@enkaku/protocol'
import { api, cn, Input } from '@enkaku/ui'
import { flatten, formatBounds, primaryLabel, shortClassName, treeExtent, type FlatRow } from '@/lib/ui-tree'
import { formatOffset } from './lane-math'

/**
 * Card 5 — the UI nodes a step saw, read from the trace's own stored tree
 * (`GET /api/jobs/:id/runs/:runId/trace/ui/:hash`). Before this card the
 * Frame + Event panel offered that tree only as a `captured` link to raw
 * JSON in a new tab, so "which nodes were on screen at frame A" meant reading
 * a gzipped dump by hand (owner, 2026-09-17).
 *
 * The rows, labels and detail fields are Device Control's Inspector's
 * (`lib/ui-tree.ts`), so a node reads the same live and recorded. Selecting
 * one draws its bounds on the Frame panel through `onSelectNode`.
 *
 * A tree is content-addressed and never changes, so it is fetched once per
 * hash and kept for the life of the page: playback steps through dozens of
 * events that share one tree, and refetching it on every tick would be all
 * the network traffic a replay makes.
 */
const treeCache = new Map<string, Promise<UiNode>>()

function loadTree(jobId: string, runId: string, hash: string): Promise<UiNode> {
  const key = `${runId}:${hash}`
  let pending = treeCache.get(key)
  if (!pending) {
    pending = api(`/api/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/trace/ui/${hash}`, UiNodeSchema)
    // A failed fetch is not cached: the next selection of this step tries again.
    pending.catch(() => treeCache.delete(key))
    treeCache.set(key, pending)
  }
  return pending
}

export interface SelectedUiNode {
  node: UiNode
  /** The screen size the tree was laid out on — what the Frame overlay scales the bounds against. */
  extent: { width: number; height: number }
}

type TreeState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; root: UiNode }

export function UiTreePanel({
  jobId,
  runId,
  originMs,
  step,
  treeEvent,
  onSelectNode,
}: {
  jobId: string
  runId: string
  originMs: number
  /** The step under the playhead. */
  step: JobTraceEvent | null
  /** The step whose tree is shown: `step` itself, or the most recent earlier one that stored a tree. */
  treeEvent: JobTraceEvent | null
  onSelectNode: (selected: SelectedUiNode | null) => void
}) {
  const hash = treeEvent?.uiHash ?? null
  const [tree, setTree] = useState<TreeState>({ status: 'idle' })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setSelectedKey(null)
    onSelectNode(null)
    if (!hash) {
      setTree({ status: 'idle' })
      return
    }
    let cancelled = false
    setTree({ status: 'loading' })
    loadTree(jobId, runId, hash).then(
      (root) => {
        if (!cancelled) setTree({ status: 'ready', root })
      },
      (err: unknown) => {
        if (!cancelled) setTree({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      cancelled = true
    }
    // `onSelectNode` is a state setter's wrapper from the parent; the tree is keyed on the hash alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, runId, hash])

  const root = tree.status === 'ready' ? tree.root : null
  const rows = useMemo(() => (root ? flatten(root) : []), [root])
  const extent = useMemo(() => (root ? treeExtent(root) : { width: 0, height: 0 }), [root])
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => (needle ? rows.filter((r) => matches(r, needle)) : rows), [rows, needle])
  const selected = selectedKey === null ? null : (rows.find((r) => keyOf(r) === selectedKey)?.node ?? null)

  function select(row: FlatRow): void {
    const key = keyOf(row)
    if (key === selectedKey) {
      setSelectedKey(null)
      onSelectNode(null)
      return
    }
    setSelectedKey(key)
    onSelectNode({ node: row.node, extent })
  }

  const borrowed = treeEvent !== null && step !== null && treeEvent.id !== step.id

  return (
    <div className="rounded-inner border border-line-2 px-3 pt-[10px] pb-3">
      <div className="flex items-center gap-3 pb-2">
        <div className="min-w-0 flex-1 truncate text-label text-faint">
          UI nodes
          {root ? ` · ${rows.length} node${rows.length === 1 ? '' : 's'}` : ''}
          {treeEvent ? ` · from ${treeEvent.name} ${formatOffset(treeEvent.atMs, originMs)}` : ''}
          {borrowed ? ' — this step stored no tree, so this is the last one read before it' : ''}
        </div>
        {root && (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by id, text, desc or class"
            className="h-8 w-56 flex-none text-[12.5px]"
          />
        )}
      </div>

      {!hash ? (
        <p className="text-meta text-faint">
          No UI tree stored at or before this point. A tree is kept for every <span className="font-mono">dump</span>,{' '}
          <span className="font-mono">find</span> and <span className="font-mono">waitFor</span>, for a failing action, and at the end
          of each script phase.
        </p>
      ) : tree.status === 'loading' || tree.status === 'idle' ? (
        <p className="text-meta text-faint">Loading the UI tree…</p>
      ) : tree.status === 'error' ? (
        <p className="text-meta text-danger">This UI tree could not be read: {tree.message}</p>
      ) : (
        <div className="flex items-stretch gap-[10px]">
          <div className="max-h-[360px] min-w-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
            {shown.length === 0 ? (
              <p className="px-1 text-faint">No node matches “{query.trim()}”.</p>
            ) : (
              shown.map((row) => {
                const key = keyOf(row)
                const label = primaryLabel(row.node)
                return (
                  <button
                    key={key}
                    type="button"
                    // A filtered list keeps each match's depth: where a node sits is half of what it is.
                    style={{ paddingLeft: row.depth * 12 + 4 }}
                    className={cn(
                      'block w-full truncate rounded-inner py-0.5 pr-1 text-left',
                      key === selectedKey ? 'bg-accent-soft text-accent' : 'text-text hover:bg-muted-2',
                    )}
                    onClick={() => select(row)}
                  >
                    {shortClassName(row.node.className)}
                    {label ? <span className={key === selectedKey ? undefined : 'text-text-3'}> “{label}”</span> : null}
                    {row.node.clickable ? <span className="text-faint"> · clickable</span> : null}
                  </button>
                )
              })
            )}
          </div>

          <dl className="grid w-[260px] flex-none grid-cols-[auto_1fr] content-start gap-x-3 gap-y-1 border-l border-line-2 pl-3 font-mono text-[11px]">
            <NodeDetailRow label="class" value={selected ? shortClassName(selected.className) : null} />
            <NodeDetailRow label="resource id" value={selected?.resourceId || null} />
            <NodeDetailRow label="text" value={selected?.text || null} />
            <NodeDetailRow label="desc" value={selected?.desc || null} />
            <NodeDetailRow label="bounds" value={selected ? formatBounds(selected.bounds) : null} />
            <NodeDetailRow label="clickable" value={selected ? String(selected.clickable) : null} />
            <NodeDetailRow label="enabled" value={selected ? String(selected.enabled) : null} />
            <NodeDetailRow label="focused" value={selected ? String(selected.focused) : null} />
            <NodeDetailRow label="package" value={selected?.packageName || null} />
            {!selected && <dd className="col-span-2 pt-1 font-sans text-meta text-faint">Select a node to read it and outline it on the frame.</dd>}
          </dl>
        </div>
      )}
    </div>
  )
}

function keyOf(row: FlatRow): string {
  return row.path.join(',') || 'root'
}

function matches(row: FlatRow, needle: string): boolean {
  const n = row.node
  return (
    n.resourceId.toLowerCase().includes(needle) ||
    n.text.toLowerCase().includes(needle) ||
    n.desc.toLowerCase().includes(needle) ||
    n.className.toLowerCase().includes(needle)
  )
}

function NodeDetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="break-words text-text">{value || '–'}</dd>
    </>
  )
}
