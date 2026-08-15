'use client'

import type { DragEvent } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, GripVertical, Sparkles, Trash2 } from 'lucide-react'
import type { ValueExpr, WorkflowFinding, WorkflowParam } from '@enkaku/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BranchRail } from './BranchRail'
import { edgeLabelsFor } from './edges'
import { GateOutcomeEditor } from './GateOutcomeEditor'
import { defaultReset, type WorkflowNodeDraft } from './model'
import { PredicateEditor } from './PredicateEditor'
import { inferWorkflowParamType, promoteNodeParam } from './promote'
import { ScriptPicker, type ScriptOption } from './ScriptPicker'
import { paramProperties, resolveScriptOption } from './scriptBindings'
import { type NodeOption, ValueExprEditor } from './ValueExprEditor'

function findingsFor(findings: readonly WorkflowFinding[], index: number): WorkflowFinding[] {
  const prefix = `nodes[${index}]`
  return findings.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}.`) || f.path.startsWith(`${prefix}[`))
}

function stripPrefix(path: string, index: number): string {
  return path.replace(new RegExp(`^nodes\\[${index}\\]\\.?`), '') || '(this node)'
}

export function NodeCard({
  node,
  index,
  total,
  workflowParams,
  scripts,
  precedingOptions,
  allOptions,
  findings,
  onChange,
  onRemove,
  onMove,
  onPromote,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dropTarget = false,
}: {
  node: WorkflowNodeDraft
  index: number
  total: number
  workflowParams: readonly WorkflowParam[]
  scripts: readonly ScriptOption[]
  /** Nodes strictly earlier in ARRAY order — what a `{ from }` binding may legitimately name in the common (non-looping) case (plan 99 §3.6). */
  precedingOptions: readonly NodeOption[]
  /** Every other node — what a `goto` target may name (a jump may go forward or backward, §3.7). */
  allOptions: readonly NodeOption[]
  findings: readonly WorkflowFinding[]
  onChange(patch: Partial<WorkflowNodeDraft>): void
  onRemove(): void
  onMove(direction: -1 | 1): void
  onPromote(param: WorkflowParam): void
  /** Drag-reorder (plan 99 §5 step 99.9) — native HTML5 DnD, started only from the grip handle so dragging text inside an input never gets hijacked as a card drag; the Move up/down buttons above are the same operation for anyone not using a mouse. */
  onDragStart?(e: DragEvent<HTMLButtonElement>): void
  onDragOver?(e: DragEvent<HTMLDivElement>): void
  onDrop?(e: DragEvent<HTMLDivElement>): void
  onDragEnd?(e: DragEvent<HTMLButtonElement>): void
  dropTarget?: boolean
}) {
  const own = findingsFor(findings, index)
  const edges = edgeLabelsFor(node.kind === 'gate' ? [node] : [node], 0)
  const scriptForBindings = node.kind === 'script' ? resolveScriptOption(node.script, scripts) : undefined
  const bindingFields = node.kind === 'script' ? paramProperties(scriptForBindings?.paramsSchema) : []
  const reset = node.kind === 'script' ? (node.reset ?? defaultReset(index)) : undefined

  return (
    <div
      data-testid={`node-card-${index}`}
      className={`flex items-stretch gap-1.5${dropTarget ? ' rounded-lg outline-2 outline-dashed outline-accent' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <BranchRail index={index} total={total} edges={edges} />
      <div className="min-w-0 flex-1 space-y-3 rounded-lg border bg-surface p-3.5">
        <div className="flex items-start gap-2">
          <button
            type="button"
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            className="mt-1.5 shrink-0 cursor-grab touch-none text-fg-subtle hover:text-fg-muted active:cursor-grabbing"
            aria-label={`Drag to reorder ${node.title || node.id}`}
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
          <span className="readout mt-1.5 shrink-0 text-[11px] text-fg-subtle">{index + 1}</span>
          <Badge variant={node.kind === 'gate' ? 'secondary' : 'outline'} className="mt-1 shrink-0 text-[10px]">
            {node.kind === 'gate' ? 'Gate' : 'Script'}
          </Badge>
          <Input
            className="h-8 min-w-0 flex-1 text-[13px] font-medium"
            placeholder={node.kind === 'gate' ? 'Untitled gate' : 'Untitled node'}
            value={node.title}
            onChange={(e) => onChange({ title: e.target.value })}
            aria-label="Node title"
          />
          <span className="readout mt-1.5 shrink-0 text-[10.5px] text-fg-subtle">{node.id}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
              <ChevronUp className="size-3.5" aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove node" onClick={onRemove}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>

        {own.length > 0 && (
          <div className="space-y-1">
            {own.map((f, i) => (
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
                <span className="readout mr-1 opacity-70">{stripPrefix(f.path, index)}:</span>
                {f.message}
              </p>
            ))}
          </div>
        )}

        {node.kind === 'script' ? (
          <div className="space-y-3">
            <ScriptPicker scripts={scripts} value={node.script} onChange={(ref) => onChange({ script: ref })} />

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-[11.5px] text-fg-muted">starts from:</span>
                <Select value={reset} onValueChange={(v) => onChange({ reset: v as 'farm' | 'none' })}>
                  <SelectTrigger className="h-7 w-56 text-[11.5px]" aria-label="Starts from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">where the previous node finished</SelectItem>
                    <SelectItem value="farm">a clean device</SelectItem>
                  </SelectContent>
                </Select>
                {node.reset === undefined && <span className="rack-label text-fg-subtle">default</span>}
              </div>

              <div className="flex items-center gap-1.5">
                <Label className="text-[11.5px] font-normal text-fg-muted">Retries</Label>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  className="h-7 w-16 text-[11.5px]"
                  placeholder="script default"
                  value={node.retries ?? ''}
                  onChange={(e) => onChange({ retries: e.target.value === '' ? undefined : Math.max(0, Math.min(10, e.target.valueAsNumber || 0)) })}
                  aria-label="Retries override"
                />
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="w-16 shrink-0 text-[11.5px] text-fg-muted">on success</span>
              <Select value={node.next ?? '__default__'} onValueChange={(v) => onChange({ next: v === '__default__' ? undefined : v })}>
                <SelectTrigger className="h-8 w-56 text-[12px]" aria-label="on success outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">continue to the next node</SelectItem>
                  {allOptions.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      jump to {n.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <GateOutcomeEditor value={node.onFailure} onChange={(onFailure) => onChange({ onFailure })} nodeOptions={allOptions} label="on failure" />

            {bindingFields.length > 0 && (
              <div className="space-y-2 border-t pt-2.5">
                <p className="rack-label">parameters</p>
                {bindingFields.map(({ key, node: fieldSchema, required }) => {
                  const hasDefault = fieldSchema.default !== undefined
                  const boundToParam = node.params[key] !== undefined && 'param' in node.params[key]!
                  const canPromote = required && !hasDefault && !boundToParam && inferWorkflowParamType(fieldSchema) !== null
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
                          value={node.params[key]}
                          onChange={(next) => {
                            const params: Record<string, ValueExpr> = { ...node.params }
                            if (next === undefined) delete params[key]
                            else params[key] = next
                            onChange({ params })
                          }}
                          workflowParams={workflowParams}
                          nodeOptions={precedingOptions}
                        />
                      </div>
                      {canPromote && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 text-[11px]"
                          onClick={() => {
                            const existing = new Set(workflowParams.map((p) => p.name))
                            const promoted = promoteNodeParam(fieldSchema, key, existing, true)
                            if (!promoted) return
                            onPromote(promoted)
                            const params: Record<string, ValueExpr> = { ...node.params, [key]: { param: promoted.name } }
                            onChange({ params })
                          }}
                        >
                          <Sparkles className="size-3.5" aria-hidden />
                          Promote
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="text-[11.5px] text-fg-muted">Evaluates in-process — no device call, no child process.</span>
            </div>
            <PredicateEditor value={node.when} onChange={(when) => onChange({ when })} workflowParams={workflowParams} nodeOptions={precedingOptions} />
            <GateOutcomeEditor value={node.then} onChange={(then) => onChange({ then })} nodeOptions={allOptions} label="then" />
            <GateOutcomeEditor value={node.else} onChange={(v) => onChange({ else: v })} nodeOptions={allOptions} label="else" />
            <div className="space-y-1">
              <Label className="text-[11.5px] font-normal text-fg-muted">Message shown on the job when this gate ends the workflow (optional)</Label>
              <Input className="h-8 text-[12.5px]" value={node.message} onChange={(e) => onChange({ message: e.target.value })} aria-label="Gate message" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
