'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeType, ValueExpr, WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { saveWorkflow, type WorkflowInfo } from '@/lib/api'
import {
  ArrowsClockwiseIcon,
  ArrowCounterClockwiseIcon,
  Badge,
  Button,
  Input,
  Label,
  SquaresFourIcon,
  PlusIcon,
  Switch,
  Textarea,
  useAction,
  XIcon,
} from '@enkaku/ui'
import { FlowCanvas } from './FlowCanvas'
import { NodePalette } from './NodePalette'
import { ParamsEditor } from './ParamsEditor'
import { PredicateEditor } from './PredicateEditor'
import { ScriptPicker, type ScriptOption } from './ScriptPicker'
import { paramProperties, resolveScriptOption } from './scriptBindings'
import { type NodeOption, ValueExprEditor } from './ValueExprEditor'
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
      return { kind: 'switch', id, title, ui, cases: [{ when: placeholderPredicate(), label: '' }] }
    case 'delay':
      return { kind: 'delay', id, title, ui, ms: { const: 1000 }, maxMs: 60_000 }
    case 'finish':
      return { kind: 'finish', id, title, ui, status: 'succeed', message: '' }
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
  scripts,
  mode,
  onSaved,
}: {
  initialDoc: WorkflowDoc
  scripts: readonly ScriptOption[]
  mode: 'create' | 'update'
  onSaved(workflow: WorkflowInfo): void
}) {
  const history = useHistory(initialDoc)
  const { doc, dispatch, undo, redo, canUndo, canRedo } = history
  const validation = useValidation(doc)
  const clipboard = useClipboard(history)
  const { run, isPending } = useAction()

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const pendingInsert = useRef<PendingInsert | null>(null)
  const dirty = doc !== initialDoc

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

  const selectedId = selectedIds.size === 1 ? [...selectedIds][0]! : null
  const selectedIndex = selectedId ? doc.nodes.findIndex((n) => n.id === selectedId) : -1
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
        <Button type="button" onClick={() => void handleSave()} disabled={isPending('publish') || doc.nodes.length === 0}>
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
          <FlowCanvas
            doc={doc}
            findings={validation.findings}
            selectedIds={selectedIds}
            notInstalledScriptRefs={notInstalledScriptRefs}
            onSelectionChange={(ids) => setSelectedIds(new Set(ids))}
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

        {selectedNode && (
          <aside className="flex w-full shrink-0 flex-col gap-2 overflow-y-auto lg:w-96">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="rack-label">editing · {selectedNode.title.trim() || selectedNode.id}</h3>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close node editor" onClick={() => setSelectedIds(new Set())}>
                <XIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
            <NodeInspector
              node={selectedNode}
              doc={doc}
              scripts={scripts}
              findings={validation.findingsByNodeIndex.get(selectedIndex) ?? []}
              onChange={(patch) => dispatch({ t: 'update-node', id: selectedNode.id, patch })}
              onRemove={() => {
                dispatch({ t: 'remove-nodes', ids: [selectedNode.id] })
                setSelectedIds(new Set())
              }}
            />
          </aside>
        )}
      </div>

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
        <div className="min-w-40 flex-1 space-y-1">
          <Label className="text-[11.5px] font-normal text-fg-muted">Name</Label>
          <Input
            className="readout h-8 text-[12.5px]"
            placeholder="tiktok-search-pipeline"
            value={doc.name}
            onChange={(e) => dispatch({ t: 'set-meta', patch: { name: e.target.value } }, 'meta-name')}
            aria-label="Workflow name"
          />
        </div>
        <div className="min-w-40 flex-1 space-y-1">
          <Label className="text-[11.5px] font-normal text-fg-muted">Title</Label>
          <Input
            className="h-8 text-[12.5px]"
            value={doc.title}
            onChange={(e) => dispatch({ t: 'set-meta', patch: { title: e.target.value } }, 'meta-title')}
            aria-label="Title"
          />
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

function NodeInspector({
  node,
  doc,
  scripts,
  findings,
  onChange,
  onRemove,
}: {
  node: WorkflowNode
  doc: WorkflowDoc
  scripts: readonly ScriptOption[]
  findings: readonly { path: string; message: string; severity: 'error' | 'warning' }[]
  onChange(patch: Partial<WorkflowNode>): void
  onRemove(): void
}) {
  const nodeOptions: NodeOption[] = doc.nodes
    .filter((n) => n.id !== node.id)
    .map((n) => ({ id: n.id, label: n.title.trim() ? `${n.title} (${n.id})` : n.id }))

  const scriptOption = node.kind === 'script' ? resolveScriptOption(node.script, scripts) : undefined
  const bindingFields = node.kind === 'script' ? paramProperties(scriptOption?.paramsSchema) : []

  return (
    <div className="space-y-3 rounded-lg border bg-surface p-3.5">
      <div className="space-y-1">
        <Label className="text-[11.5px] font-normal text-fg-muted">Title</Label>
        <Input className="h-8 text-[13px]" value={node.title} onChange={(e) => onChange({ title: e.target.value })} aria-label="Node title" />
      </div>

      {findings.length > 0 && (
        <div className="space-y-1">
          {findings.map((f, i) => (
            <p
              key={i}
              data-testid="finding"
              data-severity={f.severity}
              className={
                f.severity === 'error'
                  ? 'rounded border border-led-danger/30 bg-led-danger/5 px-2 py-1 text-[11.5px] text-led-danger'
                  : 'rounded border border-led-warn/30 bg-led-warn/5 px-2 py-1 text-[11.5px] text-led-warn'
              }
            >
              {f.message}
            </p>
          ))}
        </div>
      )}

      {node.kind === 'script' && (
        <div className="space-y-3">
          <ScriptPicker scripts={scripts} value={node.script} onChange={(ref) => onChange({ script: ref })} />
          {bindingFields.map(({ key, node: fieldSchema, required }) => (
            <div key={key} className="space-y-1">
              <p className="text-[12px] font-medium">
                {typeof fieldSchema.title === 'string' ? fieldSchema.title : key}
                {required && <span className="ml-1 text-led-warn">*</span>}
              </p>
              <ValueExprEditor
                value={node.params[key]}
                onChange={(next) => {
                  const params: Record<string, ValueExpr> = { ...node.params }
                  if (next === undefined) delete params[key]
                  else params[key] = next
                  onChange({ params })
                }}
                workflowParams={doc.params}
                nodeOptions={nodeOptions}
              />
            </div>
          ))}
        </div>
      )}

      {node.kind === 'gate' && <PredicateEditor value={node.when} onChange={(when) => onChange({ when })} workflowParams={doc.params} nodeOptions={nodeOptions} />}

      {node.kind === 'switch' && (
        <div className="space-y-2">
          {node.cases.map((c, i) => (
            <div key={i} className="space-y-1 rounded-md border border-dashed p-2">
              <p className="rack-label">case {i + 1}</p>
              <PredicateEditor
                value={c.when}
                onChange={(when) => onChange({ cases: node.cases.map((x, j) => (j === i ? { ...x, when } : x)) })}
                workflowParams={doc.params}
                nodeOptions={nodeOptions}
              />
            </div>
          ))}
        </div>
      )}

      {node.kind === 'delay' && (
        <div className="space-y-1">
          <Label className="text-[11.5px] font-normal text-fg-muted">Maximum wait (ms)</Label>
          <Input
            type="number"
            className="h-8 text-[12.5px]"
            value={node.maxMs}
            onChange={(e) => onChange({ maxMs: Math.max(0, e.target.valueAsNumber || 0) })}
            aria-label="Maximum wait, milliseconds"
          />
        </div>
      )}

      {node.kind === 'finish' && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-[12px]">
            <Switch checked={node.status === 'succeed'} onCheckedChange={(on) => onChange({ status: on ? 'succeed' : 'fail' })} />
            Ends the run: {node.status === 'succeed' ? 'succeeded' : 'failed'}
          </Label>
          <Textarea className="text-[12.5px]" value={node.message} onChange={(e) => onChange({ message: e.target.value })} aria-label="Finish message" />
        </div>
      )}

      <Button type="button" variant="outline" size="sm" onClick={onRemove} disabled={node.kind === 'start'}>
        Remove node
      </Button>
    </div>
  )
}
