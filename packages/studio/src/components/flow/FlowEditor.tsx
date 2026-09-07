'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { NodeType, ScriptListItem, WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { fetchWorkflowLastRun, listWorkflowPins, saveWorkflow, type WorkflowInfo } from '@/lib/api'
import { Sheet, SheetContent } from '@enkaku/ui'
import {
  ArrowsClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  WarningIcon,
  Badge,
  ClipboardIcon,
  CopyIcon,
  ClockCounterClockwiseIcon,
  Button,
  cn,
  Input,
  Label,
  PlayIcon,
  RocketIcon,
  SquaresFourIcon,
  PlusIcon,
  Textarea,
  TrayArrowDownIcon,
  UploadSimpleIcon,
  useAction,
} from '@enkaku/ui'
import { RunOverlay } from './RunOverlay'
import { CanvasContextMenu, type CanvasMenuRequest } from './CanvasContextMenu'
import { HistoryPanel } from './HistoryPanel'
import { NodePalette } from './NodePalette'
import { ActionSettings } from './ActionSettings'
import { SequenceEditor, canUseEasy } from './SequenceEditor'
import { NodePanel } from './NodePanel'
import { ParamsEditor } from './ParamsEditor'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'
import { SimulateDialog } from './SimulateDialog'
import { useHistory, type UseHistoryResult } from './useHistory'
import { useValidation, nodeIndexOf } from './useValidation'
import { docToJson, useClipboard } from './useClipboard'
import { WorkflowPanel, type PanelTab } from './WorkflowPanel'
import { JsonMenu } from './JsonMenu'
import { toast } from 'sonner'
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
  // A node is born switched on (plan 313 §3.4) — `enabled` is something an
  // author turns OFF later, never a state anything starts in.
  const enabled = true
  switch (type.kind) {
    case 'script':
      return { kind: 'script', id, title, ui, enabled, script: type.script ?? '', params: {} }
    case 'gate':
      return { kind: 'gate', id, title, ui, enabled, when: placeholderPredicate() }
    case 'switch':
      return { kind: 'switch', id, title, ui, enabled, mode: 'predicate', cases: [{ when: placeholderPredicate(), label: '' }] }
    case 'delay':
      return { kind: 'delay', id, title, ui, enabled, ms: { const: 1000 }, maxMs: 60_000 }
    case 'finish':
      return { kind: 'finish', id, title, ui, enabled, status: 'succeed', message: '' }
    case 'set':
      return { kind: 'set', id, title, ui, enabled, assignments: [], keepOnlySet: false }
    case 'shuffle':
      // Placed empty: membership is assigned by selecting rows in the
      // sequence editor or by dragging members onto it, never guessed here.
      return { kind: 'shuffle', id, title, ui, enabled, members: [], between: { const: 0 }, betweenMaxMs: 0 }
    case 'start':
      // `start` cannot be placed a second time (plan 301 §3.4) — the
      // palette never lists it as pickable; kept only so the switch above
      // is exhaustive.
      return { kind: 'script', id, title, ui, enabled, script: type.script ?? '', params: {} }
  }
}

interface PendingInsert {
  mode: 'plain' | 'connect' | 'edge'
  from?: string
  kind?: EdgeKind
}

/**
 * The document as it is for the purpose of "has anything changed?" — the same
 * document with the editor preference taken out.
 *
 * Compared as text rather than by key: both sides come from the same reducer,
 * which spreads the previous document, so their key order matches. If that
 * ever stopped being true this would report a change that is not one, which
 * is exactly what the code did before this existed — a strictly no-worse
 * failure.
 */
function withoutEditorPref(doc: WorkflowDoc): string {
  if (doc.ui === undefined) return JSON.stringify(doc)
  const { editor: _editor, ...rest } = doc.ui
  return JSON.stringify(Object.keys(rest).length === 0 ? { ...doc, ui: undefined } : { ...doc, ui: rest })
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
  /**
   * Which editor is showing (plan 313 §3.3). `doc.ui.editor` is a stored
   * PREFERENCE; `canUseSequence` is the truth about the document's shape.
   * The preference alone never puts an author in a list that cannot draw
   * what they are looking at.
   */
  const [editorMode, setEditorMode] = useState<'sequence' | 'canvas'>(initialDoc.ui?.editor === 'sequence' && canUseEasy(initialDoc) ? 'sequence' : 'canvas')
  const { doc, dispatch, undo, redo, canUndo, canRedo } = history
  const validation = useValidation(doc)
  const clipboard = useClipboard(history)
  const importInput = useRef<HTMLInputElement>(null)
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuRequest | null>(null)
  /**
   * The history panel, and the run it has pinned.
   *
   * `pinnedRun` overrides `lastRunRef` while it is set — one overlay, two
   * sources, exactly as Simulate already overrides it. Clearing it falls back
   * to the last real run rather than to nothing, so closing the panel leaves
   * the canvas where the author expects it.
   */
  /*
    Which panel section is showing. Selecting a node moves it to `node` on
    its own (below) — the panel follows the canvas rather than making the
    author go and find the right tab.
  */
  const [panelTab, setPanelTab] = useState<PanelTab>('properties')
  /* The sentence under the panel's title — composed by `RunOverlay`, which is the only thing that knows the step count. */
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const router = useRouter()
  const [pinnedRun, setPinnedRun] = useState<{ jobId: string; runId: string } | null>(null)
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
  /*
    Which editor is open is a VIEW choice, not an edit.

    The mode is stored on the document on purpose (plan 313 §3.3) so it
    follows a workflow to another browser — but writing it on every toggle
    meant merely LOOKING at a workflow in the other editor marked it unsaved,
    put "Unsaved" in the toolbar, and armed the leave-confirmation dialog for
    a change the author never made (owner, 2026-09-07). Switching back and
    forth left it dirty either way.

    So the preference still travels with the document and still saves with it
    — it just does not, on its own, count as something to save.
  */
  const dirty = useMemo(() => doc !== initialDoc && withoutEditorPref(doc) !== withoutEditorPref(initialDoc), [doc, initialDoc])

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
  //
  // Plan 309 §4.5 — a fresh Simulate result overrides this SAME ref (one
  // overlay, no second read path, G6): `simulated` is what tells `RunOverlay`
  // to draw the dashed halo and chip rather than the "live/replay" chrome a
  // real run gets. Opening a different node, editing the graph, or refetching
  // the real last run all clear it, so a stale simulation is never mistaken
  // for the workflow's own history the moment either changes.
  const [lastRunRef, setLastRunRef] = useState<{ jobId: string; runId: string } | null>(null)
  const [simulated, setSimulated] = useState(false)
  const { open: openAction } = useActionDialogs()
  const [simulateOpen, setSimulateOpen] = useState(false)
  /** Author-written mocks from the node panel's "Use as mock" (plan 309 §4.5, §9 Q2) — session-only, merged over stored pins by `simulateWorkflow` itself; never persisted unless the author separately pins the node. */
  const [mocks, setMocks] = useState<Record<string, unknown>>({})

  const refreshLastRun = useCallback(() => {
    const name = doc.name.trim()
    if (!name) {
      setLastRunRef(null)
      setSimulated(false)
      return () => {}
    }
    let cancelled = false
    void fetchWorkflowLastRun(name)
      .then((r) => {
        if (!cancelled) {
          setLastRunRef(r ? { jobId: r.jobId, runId: r.runId } : null)
          setSimulated(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLastRunRef(null)
          setSimulated(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [doc.name])
  useEffect(() => refreshLastRun(), [refreshLastRun])

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
        // Not awaited: the handler must stay synchronous so the browser's own
        // paste is not delayed behind a clipboard read that may prompt.
        void clipboard.paste().then((ok) => {
          if (!ok) toast.message('Nothing to paste — copy some nodes, or put a workflow’s JSON on the clipboard.')
        })
      } else if (meta && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        clipboard.copy(selectedIds)
        void clipboard.paste()
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
  /** In Sequential Mode a script node is configured as a plain form; everything else still opens the node inspector. */
  const simpleAction = editorMode === 'sequence' && selectedNode?.kind === 'script' ? selectedNode : null

  /*
    What the Node tab shows: the single node selected on the canvas. The
    `selectedNode` above is the SHEET's node (a double-click); this follows an
    ordinary click, which is what an inspector panel is for.
  */
  const panelNode = useMemo(() => {
    if (selectedIds.size !== 1) return null
    const id = [...selectedIds][0]
    return doc.nodes.find((n) => n.id === id) ?? null
  }, [selectedIds, doc.nodes])

  /* Selecting a node moves the panel to it, so the panel follows the canvas. */
  useEffect(() => {
    if (panelNode) setPanelTab('node')
  }, [panelNode])

  const rootFindings = validation.findings.filter((f) => nodeIndexOf(f.path) === undefined)
  /**
   * Export the document as a file. A blob URL rather than a data URI so a
   * large graph is not capped by URL length, and revoked on the next tick
   * because the click has already consumed it.
   */
  const handleExport = useCallback(() => {
    const blob = new Blob([docToJson(doc)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${doc.name || 'workflow'}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [doc])

  /**
   * Import APPENDS rather than replaces, for the same reason paste does: the
   * editor already holds a document with a name, an identifier and a history,
   * and silently swapping all three for a stranger's is not something Undo
   * can honestly put back. The nodes arrive with fresh ids beside what is
   * already there, and the author wires or deletes from a canvas they can see.
   */
  const handleImport = useCallback(
    async (file: File) => {
      const text = await file.text().catch(() => null)
      if (text === null) {
        toast.error(`Could not read ${file.name}.`)
        return
      }
      if (clipboard.pasteJson(text)) toast.success(`Imported ${file.name}.`)
      else toast.error(`${file.name} is not a workflow this editor can read.`)
    },
    [clipboard],
  )

  /** Export's twin: the same JSON, on the clipboard instead of on disk. */
  const handleCopyJson = useCallback(async () => {
    const json = docToJson(doc)
    try {
      await navigator.clipboard.writeText(json)
      toast.success('Workflow JSON copied.')
    } catch {
      // A refused permission or an insecure context is not this editor's
      // fault, and there is a working alternative one button away.
      toast.error('Could not reach the clipboard — use Export to write a file instead.')
    }
  }, [doc])

  /** Import's twin. The same payload path, so a pasted document lands exactly as an imported file does. */
  const handlePasteJson = useCallback(async () => {
    const ok = await clipboard.paste()
    if (ok) toast.success('Workflow pasted from the clipboard.')
    else toast.error('The clipboard holds nothing this editor can read — copy a workflow’s JSON first.')
  }, [clipboard])

  const errorCount = validation.findings.filter((f) => f.severity === 'error').length
  const warningCount = validation.findings.length - errorCount

  return (
    /*
      One container, not a stack (CEO's redesign, 2026-09-07).

      This screen used to be four bands: a page header, a meta form, a
      toolbar row, and whatever height was left over for the graph. The graph
      IS the screen, so it fills the container now and everything else floats
      over it. The container takes the canvas's own background so the two read
      as one surface rather than a canvas sitting inside a page.
    */
    <div className="relative h-[calc(100vh-56px)] min-h-[520px] overflow-hidden bg-bg">

      {/*
        The actions, floating. Two clusters in one overlay bar that stops
        before the panel — `space-between` so they sit at the two ends, and
        wrapping rather than clipping on a narrow window. Nothing here takes
        height from the canvas any more.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-wrap items-start justify-between gap-2 p-3 pr-[352px]">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-card border border-border bg-panel/95 p-1 shadow-panel-2 backdrop-blur">
          {/*
            The confirm travels with the button. The page header's link had
            it, and losing it here would restore the exact fault that comment
            was written for: leaving with an unsaved graph and no warning.
          */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="All workflows"
            onClick={() => {
              if (dirty && !window.confirm('This workflow has unsaved changes. Leave and lose them?')) return
              router.push('/scripts?tab=workflows')
            }}
          >
            <CaretLeftIcon className="size-4" aria-hidden />
          </Button>
          <Button type="button" size="icon" aria-label="Add node" onClick={openPlainPalette}>
            <PlusIcon className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={undo} disabled={!canUndo} aria-label="Undo">
            <ArrowCounterClockwiseIcon className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={redo} disabled={!canRedo} aria-label="Redo">
            <ArrowsClockwiseIcon className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={handleAutoArrange} aria-label="Auto-arrange">
            <SquaresFourIcon className="size-4" aria-hidden />
          </Button>
          {/*
            Plan 313 §3.3 — the mode switch. Offered only while the document
            can actually BE a list, and it re-evaluates on every edit, so
            adding a gate takes the option away and deleting it gives the
            option back. The choice is stored on the document (`ui.editor`)
            so it follows the workflow to another browser, but it is never
            believed on its own: `canUseSequence` decides.
          */}
          {(editorMode === 'sequence' || canUseEasy(doc)) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = editorMode === 'sequence' ? 'canvas' : 'sequence'
                setEditorMode(next)
                dispatch({ t: 'set-meta', patch: { ui: { editor: next } } })
              }}
            >
              {editorMode === 'sequence' ? 'Canvas' : 'Sequence'}
            </Button>
          )}
          {/*
            Four ways in and out of this document behind one icon: a file each
            way, and the clipboard each way. They were four labelled buttons
            taking a third of the toolbar for something used once a session.
          */}
          <JsonMenu
            disabled={doc.nodes.length === 0}
            onExport={handleExport}
            onCopy={() => void handleCopyJson()}
            onImport={() => importInput.current?.click()}
            onPaste={() => void handlePasteJson()}
          />
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Cleared straight away so choosing the SAME file twice fires
              // again — a browser input fires `change` only when the value
              // differs, and re-importing the file you just edited is the
              // ordinary case.
              e.target.value = ''
              if (file) void handleImport(file)
            }}
          />
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-card border border-border bg-panel/95 p-1 shadow-panel-2 backdrop-blur">
          {validation.findings.length > 0 && (
            <button
              type="button"
              onClick={() => setPanelTab('runs')}
              className={cn(
                'flex items-center gap-1.5 rounded-button px-2.5 py-1.5 text-[12px] font-medium',
                errorCount > 0 ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn',
              )}
              title="Show them in the Runs panel"
            >
              <WarningIcon className="size-3.5" aria-hidden />
              {errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : `${warningCount} warning${warningCount === 1 ? '' : 's'}`}
            </button>
          )}
          {dirty && <Badge variant="outline">Unsaved</Badge>}
          {/*
            The n8n split, in one screen rather than two: the canvas is the
            graph you are shaping, Runs is what it has actually done — and
            picking a run there replays it over the SAME canvas, which is the
            whole reason it is a tab beside it rather than a page of its own.
          */}
          <Button type="button" variant="ghost" size="icon" active={panelTab === 'runs'} aria-label="Run history" onClick={() => setPanelTab('runs')}>
            <ClockCounterClockwiseIcon className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Simulate" onClick={() => setSimulateOpen(true)} disabled={doc.nodes.length === 0}>
            <PlayIcon className="size-4" aria-hidden />
          </Button>
          {/*
            Run, on the page where the workflow is.

            It was only ever on the workflow's CARD in the grid, so an author
            who had just finished editing had to go back a screen to run the
            thing in front of them — the owner looked for it here twice and
            did not find it (2026-09-07). Same dialog the card opens, so the
            device picker, the group tab and the batch pacing are unchanged.

            Disabled while there are unsaved changes on purpose: a run reads
            the SAVED document, so offering it here would run something other
            than what is on screen.
          */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={dirty || mode === 'create' ? 'Save before running' : 'Run on devices'}
            title={dirty || mode === 'create' ? 'Save first — a run uses the saved workflow' : 'Run on devices'}
            disabled={dirty || mode === 'create' || doc.nodes.length === 0}
            onClick={() => openAction('run-workflow', {}, { workflowName: doc.name })}
          >
            <RocketIcon className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            // The server refuses a document with an error, so offering Save
            // here only produced a red toast an author could miss. The error
            // chip beside this button already says how many.
            disabled={isPending('publish') || doc.nodes.length === 0 || errorCount > 0}
            title={errorCount > 0 ? `Fix ${errorCount} error${errorCount === 1 ? '' : 's'} before saving` : undefined}
          >
            {isPending('publish') ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {canvasMenu && (
        <CanvasContextMenu
          request={canvasMenu}
          onClose={() => setCanvasMenu(null)}
          onCopy={() => clipboard.copy(selectedIds)}
          onCut={() => {
            clipboard.cut(selectedIds)
            setSelectedIds(new Set())
          }}
          onPaste={() =>
            void clipboard.paste().then((ok) => {
              if (!ok) toast.message('Nothing to paste — copy some nodes, or put a workflow’s JSON on the clipboard.')
            })
          }
          onDuplicate={() => {
            clipboard.copy(selectedIds)
            void clipboard.paste()
          }}
          onDelete={() => {
            if (selectedIds.size === 0) return
            dispatch({ t: 'remove-nodes', ids: [...selectedIds] })
            setSelectedIds(new Set())
          }}
        />
      )}

      {rootFindings.length > 0 && (
        <div className="space-y-1">
          {rootFindings.map((f, i) => (
            <p
              key={i}
              data-testid="finding"
              data-severity={f.severity}
              className={
                f.severity === 'error'
                  ? 'rounded border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[12px] text-danger'
                  : 'rounded border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-[12px] text-warn'
              }
            >
              {f.message}
            </p>
          ))}
        </div>
      )}

      {/*
        Plan 313 §4.5 — Sequential Mode. The SAME document, the same
        `dispatch`, the same `NodePanel` and `NodePalette`; only the layout
        differs, which is what keeps undo, validation and the run view
        working without knowing which editor is showing.
      */}
      {editorMode === 'sequence' && (
        /*
          `pt-14` clears the floating action bars.

          The pane fills the whole container so the list can scroll the full
          height, and the toolbars float ON TOP of it — which put the "4
          warnings / Save" pill directly over the first row's Configure and
          remove buttons. Rows 2 and 3 looked like they had controls the first
          row lacked (owner's screenshot, 2026-09-07). The canvas does not
          have this problem because a canvas can be panned out from under
          them; a list cannot.
        */
        <div className="absolute inset-0 overflow-auto bg-bg pt-14">
          <SequenceEditor doc={doc} dispatch={dispatch} onOpenNode={setOpenNodeId} onAddAction={(from, edge) => openEdgePalette(from, edge)} selectedId={openNodeId} />
        </div>
      )}

      {/* The canvas is the container. Everything else sits on top of it. */}
      <div className={cn('absolute inset-0', editorMode === 'sequence' && 'hidden')}>
          <RunOverlay
            jobId={(pinnedRun ?? lastRunRef)?.jobId ?? null}
            runId={(pinnedRun ?? lastRunRef)?.runId ?? null}
            simulated={pinnedRun ? false : simulated}
            onStatusChange={setRunStatus}
            doc={doc}
            findings={validation.findings}
            selectedIds={selectedIds}
            onContextMenu={(at) => {
              // Right-clicking a node OUTSIDE the current selection makes it
              // the selection, the way every file manager does; inside it,
              // the whole selection stands. Empty space keeps whatever was
              // selected, because Paste is the row that belongs there.
              const ids: ReadonlySet<string> = at.nodeId === null || selectedIds.has(at.nodeId) ? selectedIds : new Set([at.nodeId])
              if (ids !== selectedIds) setSelectedIds(new Set(ids))
              setCanvasMenu({ ...at, count: ids.size })
            }}
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

      {/*
        Floating, with a shadow, rather than a bordered column: the panel
        belongs ON the canvas the way an inspector does in a drawing tool,
        and the canvas runs underneath it instead of stopping at its edge.
      */}
      <div className="absolute inset-y-0 right-0 z-20 flex">
        <WorkflowPanel
          doc={doc}
          dispatch={dispatch}
          tab={panelTab}
          onTabChange={setPanelTab}
          selectedNode={panelNode}
          onOpenNode={() => panelNode && setOpenNodeId(panelNode.id)}
          onDuplicateNode={() => {
            if (!panelNode) return
            clipboard.copy(new Set([panelNode.id]))
            void clipboard.paste()
          }}
          onRemoveNode={() => {
            if (!panelNode) return
            dispatch({ t: 'remove-nodes', ids: [panelNode.id] })
            setSelectedIds(new Set())
          }}
          onPatchNode={(patch) => panelNode && dispatch({ t: 'update-node', id: panelNode.id, patch })}
          findings={validation.findings}
          runStatus={runStatus}
          pinnedRunId={pinnedRun?.runId ?? null}
          onPickRun={setPinnedRun}
        />
      </div>

      {/*
        Two panels behind one click, chosen by the mode the author is in.

        Sequential Mode exists so a workflow can be built without meeting the
        graph; opening a 1040px node inspector — identifier, script pin,
        failure target, expression fields — the moment someone configures an
        action put the graph straight back in front of them. `ActionSettings`
        is the same node rendered as a plain settings form. Canvas mode is
        untouched: a power user still gets everything, and "Open on the
        canvas" is the one-click way through from the simple panel.
      */}
      <Sheet open={!!selectedNode} onOpenChange={(open) => !open && setOpenNodeId(null)}>
        <SheetContent side="right" showCloseButton={false} className={cn('p-0', simpleAction ? 'w-[420px] max-w-[92vw]' : 'w-[1040px] max-w-[96vw]')}>
          {simpleAction && (
            <div className="flex h-full min-h-0 flex-col">
              <header className="border-b px-4 py-3">
                <p className="text-[13px] font-medium">{simpleAction.title || simpleAction.id}</p>
                <p className="text-meta text-faint">Action settings</p>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <ActionSettings
                  node={simpleAction}
                  doc={doc}
                  scripts={scripts}
                  dispatch={dispatch}
                  onOpenInCanvas={() => {
                    setEditorMode('canvas')
                    dispatch({ t: 'set-meta', patch: { ui: { editor: 'canvas' } } })
                  }}
                />
              </div>
            </div>
          )}
          {!simpleAction && selectedNode && (
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
              onMock={(nodeId, value) => setMocks((prev) => ({ ...prev, [nodeId]: value }))}
            />
          )}
        </SheetContent>
      </Sheet>

      <NodePalette open={paletteOpen} onOpenChange={setPaletteOpen} onPick={handlePick} />

      <SimulateDialog
        open={simulateOpen}
        onOpenChange={setSimulateOpen}
        doc={doc}
        scripts={scripts}
        pinnedIds={pinnedIds}
        mocks={mocks}
        onSimulated={(ref) => {
          setLastRunRef(ref)
          setSimulated(true)
        }}
      />
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