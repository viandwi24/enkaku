'use client'

import { useEffect, useState } from 'react'
import { GitBranch, LayoutGrid, Plus, Workflow as WorkflowIcon, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ValueExpr, WorkflowFinding } from '@enkaku/protocol'
import { publishWorkflow, validateWorkflow, WorkflowPublishError } from '@/lib/api'
import { useAction, Button, Input, Label, Switch, Textarea, cn } from '@enkaku/ui'
import { readLocalPrefs, writeLocalPrefs } from '@/lib/prefs'
import { applyEdgeChange, type EdgeChange } from './canvas-edit'
import {
  addGateNode,
  addScriptNode,
  moveNode,
  removeNode,
  toWorkflowDoc,
  updateNode,
  zodIssuesToFindings,
  type WorkflowDocDraft,
  type WorkflowNodeDraft,
} from './model'
import { NodeCard } from './NodeCard'
import { WorkflowCanvas } from './WorkflowCanvas'
import { ParamsEditor } from './ParamsEditor'
import { paramProperties, resolveScriptOption } from './scriptBindings'
import { ScriptPicker, type ScriptOption } from './ScriptPicker'
import { inferWorkflowParamType, promoteNodeParam } from './promote'
import { type NodeOption, ValueExprEditor } from './ValueExprEditor'

/** `nodes[2].params.keyword` → node index `2`; `undefined` for a doc-level or `onFail.*` finding. */
function nodeIndexOf(path: string): number | undefined {
  const m = /^nodes\[(\d+)\]/.exec(path)
  return m?.[1] !== undefined ? Number(m[1]) : undefined
}

function rootFindings(findings: readonly WorkflowFinding[]): WorkflowFinding[] {
  return findings.filter((f) => nodeIndexOf(f.path) === undefined && !f.path.startsWith('onFail'))
}

function onFailFindings(findings: readonly WorkflowFinding[]): WorkflowFinding[] {
  return findings.filter((f) => f.path.startsWith('onFail'))
}

function toNodeOption(n: WorkflowNodeDraft): NodeOption {
  return { id: n.id, label: n.title.trim() ? `${n.title} (${n.id})` : n.id }
}

/**
 * The whole node-list-plus-parameters authoring surface (plan 99 §3.9,
 * §4.11, §5 step 99.9). Everything below the doc-level fields is either a
 * generic control (`Input`/`Select`/`Switch`) or one of this package's own
 * small components — no raw JSON anywhere, which is the step's own
 * verifiable result.
 */
export function WorkflowBuilder({
  initialDraft,
  scripts,
  onPublished,
}: {
  initialDraft: WorkflowDocDraft
  scripts: readonly ScriptOption[]
  onPublished(result: { id: string; name: string; version: string }): void
}) {
  const [draft, setDraft] = useState(initialDraft)
  const [findings, setFindings] = useState<WorkflowFinding[]>([])
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  // Plan 102 (M67) §3.5, §5 step 102.6 — List stays the editor of record and
  // the default view (§2's own non-goal: "not replacing the list editor").
  // Lazy initial state so this reads `localStorage` at most once, the same
  // "default, then correct after mount" shape every `localStorage`-backed
  // value in a statically-exported app needs — but unlike `AppShell`'s
  // sidebar collapse, there is no SSR/prerender concern here (this
  // component only ever renders client-side, inside a page already gated
  // behind `'use client'`), so a lazy `useState` initializer is sufficient
  // and needs no separate mount-time correction effect.
  const [view, setView] = useState<'list' | 'canvas'>(() => readLocalPrefs().workflowEditorView)
  // Plan 102 §3.5, step 102.4 — which node's editor the canvas's side panel
  // shows, `null` when nothing is selected (panel hidden, canvas full
  // width). Cleared on a view switch and whenever the selected node no
  // longer exists (removed via the panel's own Remove button, or by any
  // other draft edit) — see the `useEffect` below.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const changeView = (next: 'list' | 'canvas') => {
    setView(next)
    writeLocalPrefs({ workflowEditorView: next })
    if (next === 'list') setSelectedNodeId(null)
  }

  // A selection pointing at a node that no longer exists (removed through
  // the panel itself, or any other path) is never left dangling.
  useEffect(() => {
    if (selectedNodeId && !draft.nodes.some((n) => n.id === selectedNodeId)) setSelectedNodeId(null)
  }, [draft.nodes, selectedNodeId])

  const patchNode = (index: number, patch: Partial<WorkflowNodeDraft>) => setDraft((d) => updateNode(d, index, patch))

  /**
   * Step 102.5 — one edge interaction on the canvas (a connection dragged,
   * an edge reconnected, or an edge deleted) writes straight to
   * `next`/`onFailure`/`then`/`else` through `canvas-edit.ts`'s
   * `applyEdgeChange` — the exact inverse of `deriveGraph`, and the SAME
   * `updateNode` call `patchNode` above already uses. There is still no
   * `edges` array anywhere in `draft` (§3.3) — this never creates one.
   */
  const handleEdgeChange = (change: EdgeChange) => setDraft((d) => applyEdgeChange(d, change))

  const handleValidate = () =>
    run(
      'validate',
      async () => {
        const parsed = toWorkflowDoc(draft)
        if (!parsed.success) {
          const f = zodIssuesToFindings(parsed.error)
          setFindings(f)
          return f
        }
        const f = await validateWorkflow(parsed.data)
        setFindings(f)
        return f
      },
      {
        onSuccess: (f) => {
          const errors = f.filter((x) => x.severity === 'error').length
          const warnings = f.length - errors
          if (f.length === 0) {
            toast.success('No problems found')
          } else if (errors > 0) {
            toast.error(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`)
          } else {
            toast.warning(`${warnings} warning${warnings === 1 ? '' : 's'}`)
          }
        },
        failure: 'Could not reach the validator',
      },
    )

  const handlePublish = () =>
    run(
      'publish',
      async () => {
        const parsed = toWorkflowDoc(draft)
        if (!parsed.success) {
          setFindings(zodIssuesToFindings(parsed.error))
          throw new Error('Fix the highlighted problems before publishing.')
        }
        try {
          return await publishWorkflow(parsed.data)
        } catch (err) {
          if (err instanceof WorkflowPublishError && err.findings.length > 0) setFindings(err.findings)
          throw err
        }
      },
      {
        success: 'Workflow published',
        failure: 'Could not publish the workflow',
        onSuccess: (script) => onPublished(script),
      },
    )

  const nodeOptions = draft.nodes.map(toNodeOption)
  const errorCount = findings.filter((f) => f.severity === 'error').length
  const warningCount = findings.length - errorCount

  // Plan 102 §3.5, step 102.4 — the canvas side panel's target: `-1`/`undefined`
  // whenever nothing is selected, or the selection was just invalidated (the
  // `useEffect` above catches up on the next render).
  const selectedNodeIndex = selectedNodeId ? draft.nodes.findIndex((n) => n.id === selectedNodeId) : -1
  const selectedNode = selectedNodeIndex === -1 ? undefined : draft.nodes[selectedNodeIndex]

  const onFailBindings = draft.onFail ? paramProperties(resolveScriptOption(draft.onFail.script, scripts)?.paramsSchema) : []

  const reorder = (from: number, to: number) => {
    if (from === to) return
    setDraft((d) => moveNode(d, from, to))
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 py-4 pb-28">
      <section className="space-y-3 rounded-lg border bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[12px] font-normal text-fg-muted">Name</Label>
            <Input
              className="readout h-9"
              placeholder="tiktok-search-pipeline"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              aria-label="Workflow name"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[12px] font-normal text-fg-muted">Version</Label>
            <Input
              className="readout h-9"
              placeholder="1.0.0"
              value={draft.version}
              onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))}
              aria-label="Workflow version"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-[12px] font-normal text-fg-muted">Title</Label>
          <Input
            className="h-9"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            aria-label="Title"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[12px] font-normal text-fg-muted">Description</Label>
          <Textarea
            className="min-h-16 text-[13px]"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            aria-label="Description"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-[12px] font-normal text-fg-muted">Step budget</Label>
          <Input
            type="number"
            min={1}
            max={500}
            className="h-8 w-24 text-[12.5px]"
            value={draft.maxSteps}
            onChange={(e) => setDraft((d) => ({ ...d, maxSteps: Math.max(1, Math.min(500, e.target.valueAsNumber || 1)) }))}
            aria-label="Maximum node executions"
          />
          <span className="text-[11.5px] text-fg-muted">node executions, total (a backward jump counts every time) — {draft.nodes.length} node{draft.nodes.length === 1 ? '' : 's'} right now.</span>
        </div>
      </section>

      <section className="space-y-2.5">
        <h2 className="rack-label">workflow parameters</h2>
        <ParamsEditor params={draft.params} onChange={(params) => setDraft((d) => ({ ...d, params }))} />
      </section>

      {rootFindings(findings).length > 0 && (
        <div className="space-y-1">
          {rootFindings(findings).map((f, i) => (
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

      <section className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h2 className="rack-label">nodes</h2>
            {/* Plan 102 (M67) §3.5, §5 step 102.6 — List stays the editor of
                record and the default (§2's own non-goal: "not replacing the
                list editor"); Canvas is a second VIEW onto the same
                document, not a fork of it — both read straight off `draft`. */}
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Editor view">
              <button
                type="button"
                onClick={() => changeView('list')}
                aria-pressed={view === 'list'}
                className={cn('rounded px-2 py-1 text-[11.5px]', view === 'list' ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted hover:text-fg')}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => changeView('canvas')}
                aria-pressed={view === 'canvas'}
                className={cn('flex items-center gap-1 rounded px-2 py-1 text-[11.5px]', view === 'canvas' ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted hover:text-fg')}
              >
                <LayoutGrid className="size-3" aria-hidden />
                Canvas
              </button>
            </div>
          </div>
          <div className="flex gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft((d) => addScriptNode(d))}>
              <Plus className="size-3.5" aria-hidden />
              Script node
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft((d) => addGateNode(d))}>
              <GitBranch className="size-3.5" aria-hidden />
              Gate
            </Button>
          </div>
        </div>

        {draft.nodes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
            <WorkflowIcon className="size-6 text-fg-subtle" aria-hidden />
            <p className="text-[13px] text-fg-muted">Add your first node to get started.</p>
          </div>
        ) : view === 'canvas' ? (
          <div className="flex flex-col gap-3 lg:flex-row">
            <div className="min-w-0 flex-1">
              <WorkflowCanvas draft={draft} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onEdgeChange={handleEdgeChange} />
            </div>
            {selectedNodeIndex !== -1 && selectedNode && (
              // Plan 102 §3.5, step 102.4 — the SAME `NodeCard` the list
              // below renders, not a second implementation: this panel
              // exists purely to place it beside the canvas instead of in
              // the list's own column. Drag-reorder is omitted (there is
              // only ever one card here, nothing to drop it onto); Move
              // up/down and Remove stay wired, since those are ordinary
              // node edits with nothing canvas-specific about them.
              <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-96">
                <div className="flex items-center justify-between px-0.5">
                  <h3 className="rack-label">editing · {selectedNode.title.trim() || selectedNode.id}</h3>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Close node editor" onClick={() => setSelectedNodeId(null)}>
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="max-h-[560px] overflow-y-auto pr-0.5">
                  <NodeCard
                    node={selectedNode}
                    index={selectedNodeIndex}
                    total={draft.nodes.length}
                    workflowParams={draft.params}
                    scripts={scripts}
                    precedingOptions={nodeOptions.slice(0, selectedNodeIndex)}
                    allOptions={nodeOptions.filter((_, i) => i !== selectedNodeIndex)}
                    findings={findings}
                    onChange={(patch) => patchNode(selectedNodeIndex, patch)}
                    onRemove={() => setDraft((d) => removeNode(d, selectedNodeIndex))}
                    onMove={(direction) => reorder(selectedNodeIndex, selectedNodeIndex + direction)}
                    onPromote={(param) => setDraft((d) => ({ ...d, params: [...d.params, param] }))}
                  />
                </div>
              </aside>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            {draft.nodes.map((node, index) => (
              <NodeCard
                key={node.id}
                node={node}
                index={index}
                total={draft.nodes.length}
                workflowParams={draft.params}
                scripts={scripts}
                precedingOptions={nodeOptions.slice(0, index)}
                allOptions={nodeOptions.filter((_, i) => i !== index)}
                findings={findings}
                onChange={(patch) => patchNode(index, patch)}
                onRemove={() => setDraft((d) => removeNode(d, index))}
                onMove={(direction) => reorder(index, index + direction)}
                onPromote={(param) => setDraft((d) => ({ ...d, params: [...d.params, param] }))}
                dropTarget={overIndex === index && dragIndex !== null && dragIndex !== index}
                onDragStart={(e) => {
                  setDragIndex(index)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (dragIndex === null) return
                  e.preventDefault()
                  setOverIndex(index)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragIndex !== null) reorder(dragIndex, index)
                  setDragIndex(null)
                  setOverIndex(null)
                }}
                onDragEnd={() => {
                  setDragIndex(null)
                  setOverIndex(null)
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="rack-label">cleanup on failure</h2>
          <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            <Switch
              checked={draft.onFail !== undefined}
              onCheckedChange={(on) => setDraft((d) => ({ ...d, onFail: on ? { script: '', params: {} } : undefined }))}
              aria-label="Run a cleanup script when the workflow fails"
            />
            run a cleanup script when the workflow fails
          </label>
        </div>
        {draft.onFail && (
          <div className="space-y-3 rounded-lg border bg-surface p-3.5">
            {onFailFindings(findings).map((f, i) => (
              <p key={i} data-testid="finding" data-severity={f.severity} className="rounded border border-led-danger/30 bg-led-danger/5 px-2 py-1 text-[11.5px] text-led-danger">
                {f.message}
              </p>
            ))}
            <ScriptPicker
              scripts={scripts}
              value={draft.onFail.script}
              onChange={(script) => setDraft((d) => (d.onFail ? { ...d, onFail: { ...d.onFail, script } } : d))}
            />
            {onFailBindings.length > 0 && (
              <div className="space-y-2 border-t pt-2.5">
                <p className="rack-label">parameters</p>
                {onFailBindings.map(({ key, node: fieldSchema, required }) => {
                  const bound = draft.onFail?.params[key]
                  const boundToParam = bound !== undefined && 'param' in bound
                  return (
                  <div key={key} className="flex flex-wrap items-start gap-2">
                    <div className="w-32 shrink-0 pt-1.5">
                      <p className="text-[12px] font-medium">
                        {typeof fieldSchema.title === 'string' ? fieldSchema.title : key}
                        {required && <span className="ml-1 text-led-warn">*</span>}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <ValueExprEditor
                        value={draft.onFail?.params[key]}
                        onChange={(next) =>
                          setDraft((d) => {
                            if (!d.onFail) return d
                            const params: Record<string, ValueExpr> = { ...d.onFail.params }
                            if (next === undefined) delete params[key]
                            else params[key] = next
                            return { ...d, onFail: { ...d.onFail, params } }
                          })
                        }
                        workflowParams={draft.params}
                        nodeOptions={nodeOptions}
                      />
                    </div>
                    {required && fieldSchema.default === undefined && !boundToParam && inferWorkflowParamType(fieldSchema) !== null && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 text-[11px]"
                        onClick={() =>
                          setDraft((d) => {
                            if (!d.onFail) return d
                            const existing = new Set(d.params.map((p) => p.name))
                            const promoted = promoteNodeParam(fieldSchema, key, existing, true)
                            if (!promoted) return d
                            const params: Record<string, ValueExpr> = { ...d.onFail.params, [key]: { param: promoted.name } }
                            return { ...d, params: [...d.params, promoted], onFail: { ...d.onFail, params } }
                          })
                        }
                      >
                        Promote
                      </Button>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </section>

      <div className="fixed bottom-0 left-0 z-20 flex w-full flex-wrap items-center gap-3 border-t bg-bg px-5 py-3 lg:pl-60">
        <Button type="button" variant="outline" onClick={() => void handleValidate()} disabled={isPending('validate')}>
          {isPending('validate') ? 'Validating…' : 'Validate'}
        </Button>
        <Button type="button" onClick={() => void handlePublish()} disabled={isPending('publish') || draft.nodes.length === 0}>
          {isPending('publish') ? 'Publishing…' : 'Publish'}
        </Button>
        {findings.length > 0 && (
          <span className="readout text-[11.5px] text-fg-muted">
            {errorCount > 0 ? <span className="text-led-danger">{errorCount} error{errorCount === 1 ? '' : 's'}</span> : null}
            {errorCount > 0 && warningCount > 0 ? ', ' : ''}
            {warningCount > 0 ? <span className="text-led-warn">{warningCount} warning{warningCount === 1 ? '' : 's'}</span> : null}
          </span>
        )}
      </div>
    </div>
  )
}
