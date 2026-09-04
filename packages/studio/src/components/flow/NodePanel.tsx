'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DeviceInfo, GroupInfo, NodeType, ValueExpr, WorkflowDoc, WorkflowFinding, WorkflowNode, WorkflowParam } from '@enkaku/protocol'
import { GroupInfoSchema } from '@enkaku/protocol'
import {
  Button,
  Input,
  Label,
  PlayIcon,
  Switch,
  Textarea,
  XIcon,
  useAction,
} from '@enkaku/ui'
import { DevicePicker } from '@/components/target/DevicePicker'
import { useTarget } from '@/components/target/useTarget'
import { fetchAllPages, fetchDevices, fetchNodeTypes, fetchWorkflowLastRun, listWorkflowPins, runWorkflowNode, setWorkflowPin, deleteWorkflowPin } from '@/lib/api'
import type { WorkflowLastRunResponse } from '@/lib/api'
import { PredicateEditor } from './PredicateEditor'
import { ScriptPicker, type ScriptOption } from './ScriptPicker'
import { paramProperties, resolveScriptOption } from './scriptBindings'
import { DataTree, type DataTreeSegment } from './DataTree'
import { DataView } from './DataView'
import { ExprField, type ActiveField } from './ExprField'
import { PinControls } from './PinControls'
import { StartPanel } from './StartPanel'
import type { PreviewScope } from './usePreview'
import type { NodeOption } from './ValueExprEditor'
import { deriveGraph } from './derive-graph'

/**
 * The node panel (plan 306 §4.1–§4.2) — a right-hand drawer replacing plan
 * 305's interim single-column node editor. Three panes at ≥ 1280 px: input
 * data (left, plan 300 P6/P7), parameters (centre), output data (right,
 * P6), both data panes read from the last REAL run with no re-run
 * (`GET /api/workflows/:name/last-run`, plan 306 §3.1). Below 1280 px this
 * stacks to one column rather than tabs — a deliberate simplification from
 * the plan's own diagram, recorded in the handoff report.
 */

/** Only a `script` or a `delay` node may be pinned (plan 300 R6, `E_PIN_NOT_PINNABLE` since commit `388f8c5`) — this control is never even rendered for anything else. */
function isPinnable(node: WorkflowNode): node is Extract<WorkflowNode, { kind: 'script' | 'delay' }> {
  return node.kind === 'script' || node.kind === 'delay'
}

function emptyPreviewScope(): PreviewScope {
  return { params: {}, nodes: {}, input: undefined, seed: 0, seq: 0 }
}

export function NodePanel({
  doc,
  node,
  scripts,
  findings,
  onChange,
  onRemove,
  onClose,
  onSetParams,
  onPinsChanged,
}: {
  doc: WorkflowDoc
  node: WorkflowNode
  scripts: readonly ScriptOption[]
  findings: readonly { path: string; message: string; severity: 'error' | 'warning' }[]
  onChange(patch: Partial<WorkflowNode>): void
  onRemove(): void
  onClose(): void
  /** Only reached from the `start` node's own panel (G7) — the document's own `params[]`, never a node field. */
  onSetParams(params: WorkflowParam[]): void
  /** The canvas's own pin badges are a separate fetch (`FlowEditor.tsx`) — this tells it to refresh after a pin/unpin/edit here. */
  onPinsChanged(): void
}) {
  const [lastRun, setLastRun] = useState<WorkflowLastRunResponse | null | 'loading'>('loading')
  const [nodeTypes, setNodeTypes] = useState<NodeType[]>([])
  const [activeField, setActiveField] = useState<ActiveField | null>(null)

  const workflowName = doc.name.trim()

  useEffect(() => {
    let cancelled = false
    if (!workflowName) {
      setLastRun(null)
      return
    }
    setLastRun('loading')
    void fetchWorkflowLastRun(workflowName)
      .then((r) => {
        if (!cancelled) setLastRun(r)
      })
      .catch(() => {
        if (!cancelled) setLastRun(null)
      })
    return () => {
      cancelled = true
    }
    // Re-fetched only when the panel opens a different workflow — a running
    // node-test does not change the LAST REAL run, and `refreshLastRun`
    // below is what re-fetches after a pin edit or a fresh run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowName, node.id])

  useEffect(() => {
    void fetchNodeTypes()
      .then(setNodeTypes)
      .catch(() => setNodeTypes([]))
  }, [])

  const refreshLastRun = () => {
    if (!workflowName) return
    void fetchWorkflowLastRun(workflowName).then(setLastRun)
  }
  /** Pin changes affect BOTH this panel's own data (`nodeRun.pinned`) and the canvas's separately-fetched badges (`FlowEditor.tsx`). */
  const refreshAfterPinChange = () => {
    refreshLastRun()
    onPinsChanged()
  }

  const graph = useMemo(() => deriveGraph(doc), [doc])
  const predecessorId = useMemo(() => graph.edges.find((e) => e.to === node.id)?.from ?? null, [graph, node.id])

  const nodeRun = lastRun && lastRun !== 'loading' ? lastRun.nodes[node.id] : undefined
  const inputValue = nodeRun?.input.state === 'value' ? nodeRun.input.value : undefined
  const outputValue = nodeRun?.output.state === 'value' ? nodeRun.output.value : undefined

  const nodesScope = useMemo(() => {
    if (!lastRun || lastRun === 'loading') return {}
    const out: Record<string, unknown> = {}
    for (const [id, n] of Object.entries(lastRun.nodes)) {
      if (n.output.state === 'value') out[id] = n.output.value
    }
    return out
  }, [lastRun])

  const previewScope: PreviewScope = useMemo(() => {
    if (!lastRun || lastRun === 'loading') return emptyPreviewScope()
    return { params: lastRun.params, nodes: nodesScope, input: inputValue, seed: lastRun.seed, seq: nodeRun?.seq ?? 0 }
  }, [lastRun, nodesScope, inputValue, nodeRun])

  const nodeOptions: NodeOption[] = doc.nodes.filter((n) => n.id !== node.id).map((n) => ({ id: n.id, label: n.title.trim() ? `${n.title} (${n.id})` : n.id }))

  const scriptOption = node.kind === 'script' ? resolveScriptOption(node.script, scripts) : undefined
  const bindingFields = node.kind === 'script' ? paramProperties(scriptOption?.paramsSchema) : []

  // §4.6 — a newer node version exists.
  const versionNotice = useMemo(() => {
    if (node.kind !== 'script') return null
    const at = node.script.lastIndexOf('@')
    if (at <= 0) return null
    const family = node.script.slice(0, at)
    const pinnedVersion = node.script.slice(at + 1)
    const active = nodeTypes.find((t) => t.source === 'plugin' && t.script && t.script.slice(0, t.script.lastIndexOf('@')) === family)
    if (!active?.script) return null
    const activeVersion = active.script.slice(active.script.lastIndexOf('@') + 1)
    if (activeVersion === pinnedVersion || activeVersion === 'latest') return null
    return { family, pinnedVersion, activeVersion, ref: active.script }
  }, [node, nodeTypes])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b px-3.5 py-2.5">
        <h3 className="rack-label truncate">editing · {node.title.trim() || node.id}</h3>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close node editor" onClick={onClose}>
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {node.kind === 'start' ? (
          <StartPanel doc={doc} onSetParams={onSetParams} />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <section className="min-w-0 space-y-1.5">
              <p className="rack-label">input</p>
              {lastRun === 'loading' ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">Loading…</p>
              ) : !lastRun ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">This workflow has never run — save and run it once to see real data here.</p>
              ) : !nodeRun || nodeRun.input.state === 'none' ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">This node has not run in the most recent run.</p>
              ) : nodeRun.input.state === 'dropped' ? (
                <p className="px-2 py-3 text-[11.5px] text-led-warn">The input was over the 256 KB cap and was not recorded.</p>
              ) : nodeRun.input.state === 'empty' ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">This node ran and its input was empty.</p>
              ) : (
                <DataTree
                  value={inputValue}
                  root="$input"
                  onInsert={(ref, segments) => activeField?.onLeafClick(ref, segments)}
                />
              )}
            </section>

            <section className="min-w-0 space-y-3">
              <p className="rack-label">parameters</p>

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

              {versionNotice && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-led-warn/30 bg-led-warn/5 px-2 py-1.5 text-[11.5px] text-led-warn">
                  <span>
                    {versionNotice.activeVersion} is activated; this node uses {versionNotice.pinnedVersion}.
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => onChange({ script: versionNotice.ref } as Partial<WorkflowNode>)}>
                    Update
                  </Button>
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
                      <ExprField
                        value={node.params[key]}
                        onChange={(next) => {
                          const params: Record<string, ValueExpr> = { ...node.params }
                          if (next === undefined) delete params[key]
                          else params[key] = next
                          onChange({ params })
                        }}
                        workflowParams={doc.params}
                        nodeOptions={nodeOptions}
                        previewScope={previewScope}
                        predecessorId={predecessorId}
                        onRegisterActive={setActiveField}
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
                <div className="space-y-3">
                  <div className="space-y-1">
                    <p className="text-[12px] font-medium">Wait</p>
                    <ExprField
                      value={node.ms}
                      onChange={(next) => onChange({ ms: next ?? { const: 0 } } as Partial<WorkflowNode>)}
                      workflowParams={doc.params}
                      nodeOptions={nodeOptions}
                      previewScope={previewScope}
                      predecessorId={predecessorId}
                      onRegisterActive={setActiveField}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11.5px] font-normal text-fg-muted">Maximum wait (ms)</Label>
                    <Input
                      type="number"
                      className="h-8 text-[12.5px]"
                      value={node.maxMs}
                      onChange={(e) => onChange({ maxMs: Math.max(0, e.target.valueAsNumber || 0) } as Partial<WorkflowNode>)}
                      aria-label="Maximum wait, milliseconds"
                    />
                  </div>
                </div>
              )}

              {node.kind === 'finish' && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-[12px]">
                    <Switch checked={node.status === 'succeed'} onCheckedChange={(on) => onChange({ status: on ? 'succeed' : 'fail' } as Partial<WorkflowNode>)} />
                    Ends the run: {node.status === 'succeed' ? 'succeeded' : 'failed'}
                  </Label>
                  <Textarea className="text-[12.5px]" value={node.message} onChange={(e) => onChange({ message: e.target.value } as Partial<WorkflowNode>)} aria-label="Finish message" />
                </div>
              )}

              {isPinnable(node) && (
                <RunAndPin
                  workflowName={workflowName}
                  node={node}
                  pinned={nodeRun?.pinned ?? false}
                  hasLastOutput={nodeRun?.output.state === 'value'}
                  onRunSuccess={refreshLastRun}
                  onPinChanged={refreshAfterPinChange}
                />
              )}

              <Button type="button" variant="outline" size="sm" onClick={onRemove}>
                Remove node
              </Button>
            </section>

            <section className="min-w-0 space-y-1.5">
              <p className="rack-label">output</p>
              {lastRun === 'loading' ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">Loading…</p>
              ) : !lastRun ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">This workflow has never run.</p>
              ) : !nodeRun || nodeRun.output.state === 'none' ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">This node has not run in the most recent run.</p>
              ) : nodeRun.output.state === 'dropped' ? (
                <p className="px-2 py-3 text-[11.5px] text-led-warn">The output was over the 256 KB cap and was not recorded.</p>
              ) : nodeRun.output.state === 'empty' ? (
                <p className="px-2 py-3 text-[11.5px] text-fg-subtle">This node ran and returned nothing.</p>
              ) : (
                <DataView value={outputValue} />
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

/** "Run this node" (P9) plus pin controls (P10) — grouped together because both act on the SAME node and both need the same `workflowName`/device machinery. */
function RunAndPin({
  workflowName,
  node,
  pinned,
  hasLastOutput,
  onRunSuccess,
  onPinChanged,
}: {
  workflowName: string
  node: Extract<WorkflowNode, { kind: 'script' | 'delay' }>
  pinned: boolean
  hasLastOutput: boolean
  onRunSuccess(): void
  onPinChanged(): void
}) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const { run, isPending } = useAction()
  const target = useTarget({ devices, groups, initial: {}, maxTargets: 1 })

  useEffect(() => {
    let cancelled = false
    void fetchDevices()
      .then((list) => {
        if (!cancelled) setDevices(list)
      })
      .catch(() => undefined)
    void fetchAllPages('/api/groups', undefined, GroupInfoSchema)
      .then((list) => {
        if (!cancelled) setGroups(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const deviceId = target.resolvedIds[0]

  const handleRun = () => {
    if (!workflowName || !deviceId) return
    void run('run-node', () => runWorkflowNode(workflowName, { nodeId: node.id, deviceId }), {
      success: 'Node run started',
      failure: 'Could not run this node',
      onSuccess: onRunSuccess,
    })
  }

  return (
    <div className="space-y-2 border-t pt-2.5">
      <p className="rack-label">run this node</p>
      {!workflowName ? (
        <p className="text-[11.5px] text-fg-subtle">Save the workflow first.</p>
      ) : (
        <>
          <DevicePicker state={target} forceExpanded className="rounded-md border" />
          <Button type="button" size="sm" disabled={!deviceId || isPending('run-node')} onClick={handleRun}>
            <PlayIcon className="size-3.5" aria-hidden />
            {isPending('run-node') ? 'Running…' : 'Run this node'}
          </Button>
        </>
      )}

      <PinControls
        pinned={pinned}
        pinnedUpdatedAt={null}
        hasLastOutput={hasLastOutput}
        onPin={async () => {
          await setWorkflowPin(workflowName, node.id, { from: 'last-run' })
          onPinChanged()
        }}
        onUnpin={async () => {
          await deleteWorkflowPin(workflowName, node.id)
          onPinChanged()
        }}
        onEdit={async (data) => {
          await setWorkflowPin(workflowName, node.id, { data })
          onPinChanged()
        }}
      />
    </div>
  )
}
