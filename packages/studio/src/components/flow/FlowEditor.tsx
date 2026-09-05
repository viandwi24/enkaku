'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeType, ScriptListItem, WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { fetchWorkflowLastRun, listWorkflowPins, saveWorkflow, type WorkflowInfo } from '@/lib/api'
import { Sheet, SheetContent } from '@enkaku/ui'
import {
  ArrowsClockwiseIcon,
  ArrowCounterClockwiseIcon,
  Badge,
  Button,
  Input,
  Label,
  SquaresFourIcon,
  PlusIcon,
  Textarea,
  useAction,
} from '@enkaku/ui'
import { RunOverlay } from './RunOverlay'
import { NodePalette } from './NodePalette'
import { NodePanel } from './NodePanel'
import { ParamsEditor } from './ParamsEditor'
import { useHistory, type UseHistoryResult } from './useHistory'
import { useValidation, nodeIndexOf } from './useValidation'
import { useClipboard } from './useClipboard'
import { placeholderPredicate, edgeKindsOf, freshNodeId, nodeIdsOf, type EdgeKind } from './doc-edit'
import { autoArrangePositions } from './layout'

/**
 * Plan 305 §1, §4.1 — the page-level shell: canvas + palette + panel +
 * toolbar. The canvas IS the document now (§3.3): there is no second place
 * to edit a workflow, and no view toggle.
 */

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

function newNodeFromType(type: NodeType, id: string, x: number, y: number): WorkflowNode {
  const ui = { x, y }
  const title = ''
  switch (type.kind) {
    case 'script':
      return { kind: 'script', id, title, ui, script: type.script ?? '', params: {} }
    case 'gate':
      return { kind: 'gate', id, title, ui, when: placeholderPredicate() }
    case 'switch':
      return { kind: 'switch', id, title, ui, mode: 'predicate', cases: [{ when: placeholderPredicate(), label: '' }] }
    case 'delay':
      return { kind: 'delay', id, title, ui, ms: { const: 1000 }, maxMs: 60_000 }
    case 'finish':
      return { kind: 'finish', id, title, ui, status: 'succeed', message: '' }
    case 'set':
      return { kind: 'set', id, title, ui, assignments: [], keepOnlySet: false }
    case 'start':
      // `start` cannot be placed a second time (plan 301 §3.4) — the
      // palette never lists it as pickable; kept only so the switch above
      // is exhaustive.
      return { kind: 'script', id, title, ui, script: type.script ?? '', params: {} }
  }
}

interface PendingInsert {
  mode: 'plain' | 'connect' | 'edge'
  from?: string
  kind?: EdgeKind
}

export function FlowEditor({
  initialDoc,
  onDirtyChange,
  scripts,
  mode,
  onSaved,
}: {
  initialDoc: WorkflowDoc
  onDirtyChange?: (dirty: boolean) => void
  scripts: readonly ScriptListItem[]
  mode: 'create' | 'update'
  onSaved(workflow: WorkflowInfo): void
}) {
  const history = useHistory(initialDoc)
  const { doc, dispatch, undo, redo, canUndo, canRedo } = history
  const validation = useValidation(doc)
  const clipboard = useClipboard(history)
  const { run, isPending } = useAction()

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  /**
   * Which node's panel is OPEN — deliberately not "which node is selected".
   * Selecting and opening are two different acts: a click selects (so it can
   * be dragged, copied, box-selected with others), a double-click opens. The
   * first version of this editor gated the 1040px sheet on selection, so the
   * panel covered the canvas the instant a drag began and multi-select was
   * unusable. n8n draws the same line for the same reason.
   */
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)

  /**
   * React Flow fires `onSelectionChange` whenever it re-syncs its internal
   * node array — including on the re-sync caused by our OWN `nodes` prop
   * changing identity. Building `new Set(ids)` unconditionally therefore
   * looped: new Set → state change → the `flowNodes` memo (which depends on
   * `selectedIds`) rebuilds → React Flow re-syncs → fires again. "Maximum
   * update depth exceeded", on mount, before the editor ever rendered.
   *
   * Returning the PREVIOUS set when the contents are equal is what breaks it:
   * React bails out of a state update whose value is reference-identical, so
   * the cycle ends at step two. Content equality, not reference equality, is
   * the check — the incoming array is fresh every time by construction.
   */
  const setSelectionIfChanged = useCallback((ids: string[]) => {
    setSelectedIds((prev) => (prev.size === ids.length && ids.every((id) => prev.has(id)) ? prev : new Set(ids)))
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const pendingInsert = useRef<PendingInsert | null>(null)
  const dirty = doc !== initialDoc

  // Plan 306 §4.2 step 306.7 — the canvas badge plan 305 §4.4 reserved but
  // never actually wired. Pins are authoring state, outside the document
  // (plan 304 §3.3), so this is its own fetch, refreshed after any pin
  // change the node panel makes.
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(new Set())
  const refreshPinnedIds = useCallback(() => {
    const name = doc.name.trim()
    if (!name) {
      setPinnedIds(new Set())
      return
    }
    void listWorkflowPins(name)
      .then((list) => setPinnedIds(new Set(list.map((p) => p.nodeId))))
      .catch(() => setPinnedIds(new Set()))
  }, [doc.name])
  useEffect(() => {
    refreshPinnedIds()
  }, [refreshPinnedIds])

  // Plan 307 §4.1 — the run overlay draws over THIS canvas rather than a
  // second one: it needs only the last real run's `jobId`/`runId`, the same
  // read the node panel already makes (`fetchWorkflowLastRun`, plan 306
  // §3.1). `null`/`null` is the correct, quiet "nothing to show" state for a
  // workflow that has never run — `RunOverlay` renders no run chrome then.
  const [lastRunRef, setLastRunRef] = useState<{ jobId: string; runId: string } | null>(null)
  useEffect(() => {
    const name = doc.name.trim()
    if (!name) {
      setLastRunRef(null)
      return
    }
    let cancelled = false
    void fetchWorkflowLastRun(name)
      .then((r) => {
        if (!cancelled) setLastRunRef(r ? { jobId: r.jobId, runId: r.runId } : null)
      })
      .catch(() => {
        if (!cancelled) setLastRunRef(null)
      })
    return () => {
      cancelled = true
    }
  }, [doc.name])

  // `beforeunload` covers a reload or a closed tab, but NOT Next's
  // client-side navigation — the "All workflows" link in the page header is a
  // `next/link`, and it took unsaved work with it silently (owner report,
  // 2026-09-05). The page owns that link, so the page is told when the
  // document is dirty and guards its own navigation.
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // A browser-level warning on navigate-away, never autosave (plan 305 §3.5).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const installedScriptNames = useMemo(() => new Set(scripts.map((s) => s.name)), [scripts])
  const notInstalledScriptRefs = useMemo(() => {
    const out = new Set<string>()
    for (const n of doc.nodes) {
      if (n.kind !== 'script' || !n.script) continue
      const at = n.script.lastIndexOf('@')
      const name = at > 0 ? n.script.slice(0, at) : n.script
      if (!installedScriptNames.has(name)) out.add(n.script)
    }
    return out
  }, [doc.nodes, installedScriptNames])

  const openPlainPalette = useCallback(() => {
    pendingInsert.current = { mode: 'plain' }
    setPaletteOpen(true)
  }, [])

  const openConnectPalette = useCallback((from: string, kind: EdgeKind) => {
    pendingInsert.current = { mode: 'connect', from, kind }
    setPaletteOpen(true)
  }, [])

  const openEdgePalette = useCallback((from: string, kind: EdgeKind) => {
    pendingInsert.current = { mode: 'edge', from, kind }
    setPaletteOpen(true)
  }, [])

  const handlePick = useCallback(
    (type: NodeType) => {
      const pending = pendingInsert.current
      const id = freshNodeId(type.title, nodeIdsOf(doc))
      if (!pending || pending.mode === 'plain') {
        const rightmost = Math.max(0, ...doc.nodes.map((n) => n.ui.x))
        const node = newNodeFromType(type, id, doc.nodes.length === 0 ? 0 : rightmost + 240, 0)
        dispatch({ t: 'add-node', node })
      } else if (pending.mode === 'connect' && pending.from && pending.kind) {
        const fromNode = doc.nodes.find((n) => n.id === pending.from)
        const node = newNodeFromType(type, id, (fromNode?.ui.x ?? 0) + 240, fromNode?.ui.y ?? 0)
        dispatch({ t: 'add-node', node, connectFrom: { id: pending.from, edge: pending.kind } })
      } else if (pending.mode === 'edge' && pending.from && pending.kind) {
        const fromNode = doc.nodes.find((n) => n.id === pending.from)
        const node = newNodeFromType(type, id, (fromNode?.ui.x ?? 0) + 120, (fromNode?.ui.y ?? 0) + 60)
        dispatch({ t: 'insert-on-edge', edge: { from: pending.from, kind: pending.kind }, node })
      }
      pendingInsert.current = null
      setSelectedIds(new Set([id]))
      setOpenNodeId(id)
    },
    [doc, dispatch],
  )

  const handleAutoArrange = useCallback(() => {
    dispatch({ t: 'move-nodes', positions: autoArrangePositions(doc) })
  }, [doc, dispatch])

  const handleSave = () =>
    run('publish', () => saveWorkflow(doc, mode), {
      success: 'Workflow saved',
      failure: 'Could not save the workflow',
      onSuccess: (workflow) => onSaved(workflow),
    })

  // Plan 305 §4.3 — the whole keyboard table, disabled while an input or the
  // palette has focus (the omission that makes every canvas editor delete a
  // node while the user is typing a title).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (paletteOpen || isTypingTarget(e.target)) return
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault()
        redo()
      } else if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      } else if (meta && e.key.toLowerCase() === 'c') {
        clipboard.copy(selectedIds)
      } else if (meta && e.key.toLowerCase() === 'x') {
        clipboard.cut(selectedIds)
        setSelectedIds(new Set())
      } else if (meta && e.key.toLowerCase() === 'v') {
        clipboard.paste()
      } else if (meta && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        clipboard.copy(selectedIds)
        clipboard.paste()
      } else if (meta && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedIds(new Set(doc.nodes.map((n) => n.id)))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size === 0) return
        dispatch({ t: 'remove-nodes', ids: [...selectedIds] })
        setSelectedIds(new Set())
      } else if (e.key === 'Escape') {
        setSelectedIds(new Set())
      } else if (e.key === 'Tab' && selectedIds.size === 1) {
        const id = [...selectedIds][0]!
        const node = doc.nodes.find((n) => n.id === id)
        const kind = node ? edgeKindsOf(node)[0] : undefined
        if (node && kind) {
          e.preventDefault()
          openConnectPalette(node.id, kind)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [paletteOpen, selectedIds, doc.nodes, undo, redo, clipboard, dispatch, openConnectPalette])

  const selectedIndex = openNodeId ? doc.nodes.findIndex((n) => n.id === openNodeId) : -1
  const selectedNode = selectedIndex === -1 ? undefined : doc.nodes[selectedIndex]

  const rootFindings = validation.findings.filter((f) => nodeIndexOf(f.path) === undefined)
  const errorCount = validation.findings.filter((f) => f.severity === 'error').length
  const warningCount = validation.findings.length - errorCount

  return (
    <div className="flex h-[calc(100vh-56px)] min-h-[520px] flex-col gap-3 px-5 py-4">
      <WorkflowMetaForm doc={doc} dispatch={dispatch} />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={openPlainPalette}>
          <PlusIcon className="size-3.5" aria-hidden />
          Add node
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={undo} disabled={!canUndo} aria-label="Undo">
          <ArrowCounterClockwiseIcon className="size-3.5" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={redo} disabled={!canRedo} aria-label="Redo">
          <ArrowsClockwiseIcon className="size-3.5" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleAutoArrange}>
          <SquaresFourIcon className="size-3.5" aria-hidden />
          Auto-arrange
        </Button>
        <div className="flex-1" />
        {validation.findings.length > 0 && (
          <span className="readout text-[11.5px] text-fg-muted">
            {errorCount > 0 ? (
              <span className="text-led-danger">
                {errorCount} error{errorCount === 1 ? '' : 's'}
              </span>
            ) : null}
            {errorCount > 0 && warningCount > 0 ? ', ' : ''}
            {warningCount > 0 ? (
              <span className="text-led-warn">
                {warningCount} warning{warningCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </span>
        )}
        {dirty && <Badge variant="outline">Unsaved</Badge>}
        <Button
          type="button"
          onClick={() => void handleSave()}
          // The server refuses a document with an error, so offering Save
          // here only produced a red toast an author could miss — and then
          // the "All workflows" link took the unsaved graph with it. Reported
          // by the owner on 2026-09-05: a workflow saved holding nothing but
          // its `start` node while a script node they had added was gone.
          // The error count beside this button already says how many.
          disabled={isPending('publish') || doc.nodes.length === 0 || errorCount > 0}
          title={errorCount > 0 ? `Fix ${errorCount} error${errorCount === 1 ? '' : 's'} before saving` : undefined}
        >
          {isPending('publish') ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {rootFindings.length > 0 && (
        <div className="space-y-1">
          {rootFindings.map((f, i) => (
            <p
              key={i}
              data-testid="finding"
              data-severity={f.severity}
              className={
                f.severity === 'error'
                  ? 'rounded border border-led-danger/30 bg-led-danger/5 px-2.5 py-1.5 text-[12px] text-led-danger'
                  : 'rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-1.5 text-[12px] text-led-warn'
              }
            >
              {f.message}
            </p>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1">
          <RunOverlay
            jobId={lastRunRef?.jobId ?? null}
            runId={lastRunRef?.runId ?? null}
            doc={doc}
            findings={validation.findings}
            selectedIds={selectedIds}
            notInstalledScriptRefs={notInstalledScriptRefs}
            pinnedIds={pinnedIds}
            onSelectionChange={setSelectionIfChanged}
            onNodeOpen={setOpenNodeId}
            onNodesMoved={(positions) => dispatch({ t: 'move-nodes', positions }, 'move-nodes')}
            onEdgeChange={(change) => dispatch({ t: 'set-edge', from: change.nodeId, kind: change.kind, to: change.targetId ?? undefined })}
            onEdgesRemoved={(removed) => {
              for (const r of removed) dispatch({ t: 'set-edge', from: r.nodeId, kind: r.kind, to: undefined })
            }}
            onNodesRemoved={(ids) => dispatch({ t: 'remove-nodes', ids })}
            onInsertOnEdge={openEdgePalette}
            onConnectToEmpty={openConnectPalette}
          />
        </div>

      </div>

      <Sheet open={!!selectedNode} onOpenChange={(open) => !open && setOpenNodeId(null)}>
        <SheetContent side="right" showCloseButton={false} className="w-[1040px] max-w-[96vw] p-0">
          {selectedNode && (
            <NodePanel
              doc={doc}
              node={selectedNode}
              scripts={scripts}
              findings={validation.findingsByNodeIndex.get(selectedIndex) ?? []}
              onChange={(patch) => dispatch({ t: 'update-node', id: selectedNode.id, patch })}
              onRemove={() => {
                dispatch({ t: 'remove-nodes', ids: [selectedNode.id] })
                setOpenNodeId(null)
                setSelectedIds(new Set())
              }}
              onClose={() => setOpenNodeId(null)}
              onSetParams={(params) => dispatch({ t: 'set-meta', patch: { params } })}
              onPinsChanged={refreshPinnedIds}
            />
          )}
        </SheetContent>
      </Sheet>

      <NodePalette open={paletteOpen} onOpenChange={setPaletteOpen} onPick={handlePick} />
    </div>
  )
}

/**
 * The document-level fields (name/title/description/step budget/params) —
 * not a canvas node, so they live above the canvas rather than in the node
 * panel. `set-meta` is not in plan 305 §4.2's own `DocEdit` block (see that
 * file's own comment) — added because nothing else can express "the
 * document's own name changed," and a workflow needs one to save at all.
 */
function WorkflowMetaForm({ doc, dispatch }: { doc: WorkflowDoc; dispatch: UseHistoryResult['dispatch'] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="space-y-2 rounded-lg border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        {/*
          One editable name, not two (owner, 2026-09-05: "kenapa ada nama dan
          judul kenapa ga jadi satu aja"). `title` is the one an author reads
          and changes; `name` is the identity the URL, the API path and every
          schedule pointing at this workflow use (spec §4.7), so it is set
          once by `NewWorkflowDialog` and shown here as a fact, not a field.
          Renaming it would break a schedule silently, which is exactly the
          kind of edit a text input invites.
        */}
        <div className="min-w-40 flex-1 space-y-1">
          <Label className="text-[11.5px] font-normal text-fg-muted">Name</Label>
          <Input
            className="h-8 text-[12.5px]"
            value={doc.title}
            onChange={(e) => dispatch({ t: 'set-meta', patch: { title: e.target.value } }, 'meta-title')}
            aria-label="Title"
          />
        </div>
        <div className="min-w-40 flex-1 space-y-1">
          <Label className="text-[11.5px] font-normal text-fg-muted">Identifier</Label>
          <p className="readout flex h-8 items-center truncate rounded-md border bg-panel px-2.5 text-[12.5px] text-fg-muted" title={`${doc.name} — used by URLs, the API and schedules`}>
            {doc.name}
          </p>
        </div>
        <div className="w-28 space-y-1">
          <Label className="text-[11.5px] font-normal text-fg-muted">Step budget</Label>
          <Input
            type="number"
            min={1}
            max={500}
            className="h-8 text-[12.5px]"
            value={doc.maxSteps}
            onChange={(e) => dispatch({ t: 'set-meta', patch: { maxSteps: Math.max(1, Math.min(500, e.target.valueAsNumber || 1)) } }, 'meta-maxSteps')}
            aria-label="Maximum node executions"
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Less' : 'More'}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t pt-2.5">
          <div className="space-y-1">
            <Label className="text-[11.5px] font-normal text-fg-muted">Description</Label>
            <Textarea
              className="min-h-14 text-[12.5px]"
              value={doc.description}
              onChange={(e) => dispatch({ t: 'set-meta', patch: { description: e.target.value } }, 'meta-description')}
              aria-label="Description"
            />
          </div>
          <div className="space-y-2">
            <p className="rack-label">workflow parameters</p>
            <ParamsEditor params={doc.params} onChange={(params) => dispatch({ t: 'set-meta', patch: { params } })} />
          </div>
        </div>
      )}
    </section>
  )
}
