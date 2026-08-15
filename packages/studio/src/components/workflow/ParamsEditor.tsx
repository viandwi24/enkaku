'use client'

import { Plus, Trash2 } from 'lucide-react'
import { WORKFLOW_PARAM_TYPES, type ParamKind, type WorkflowParam, type WorkflowParamType } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

/**
 * Authoring `doc.params` (plan 99 §3.8) — the workflow's own parameter
 * DECLARATIONS, which `compileWorkflowParams` turns into the same JSON
 * Schema a hand-written Zod object would produce. This form fills in plan
 * 95's vocabulary (`title`, `description`, `hints.kind`, `hints.group`)
 * directly — never JSON — which is what lets a promoted or hand-declared
 * parameter render through a real `SchemaForm` control later, in the run
 * dialog, with no code written for workflows at all.
 */

const KIND_OPTIONS_BY_TYPE: Record<WorkflowParamType, ParamKind[]> = {
  string: ['text', 'packageName'],
  number: ['count', 'chance', 'duration', 'bytes', 'bitrate', 'pixels', 'temperature'],
  integer: ['count', 'bytes', 'bitrate', 'pixels'],
  boolean: [],
  stringList: [],
  numberPair: [],
}

const TYPE_LABELS: Record<WorkflowParamType, string> = {
  string: 'Text',
  number: 'Number',
  integer: 'Whole number',
  boolean: 'Yes/No',
  stringList: 'List of text',
  numberPair: 'Number range',
}

function defaultForType(type: WorkflowParamType): unknown {
  switch (type) {
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'stringList':
      return []
    case 'numberPair':
      return [0, 0]
  }
}

function withoutHintKind(param: WorkflowParam): WorkflowParam {
  if (!param.hints) return param
  const { kind: _kind, unit: _unit, ...rest } = param.hints
  return { ...param, hints: Object.keys(rest).length > 0 ? rest : undefined }
}

export function ParamsEditor({
  params,
  onChange,
}: {
  params: readonly WorkflowParam[]
  onChange(next: WorkflowParam[]): void
}) {
  const update = (i: number, patch: Partial<WorkflowParam>) => onChange(params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  const remove = (i: number) => onChange(params.filter((_, idx) => idx !== i))
  const add = () =>
    onChange([
      ...params,
      { name: `param${params.length + 1}`, type: 'string', required: false, title: `Parameter ${params.length + 1}`, description: '' },
    ])

  return (
    <div className="space-y-3">
      {params.length === 0 && (
        <p className="text-[12px] text-fg-muted">
          No workflow parameters yet. Add one here, or bind a node field and use <span className="font-medium">Promote</span> to create one from it.
        </p>
      )}
      {params.map((param, i) => (
        <div key={i} className="space-y-2.5 rounded-lg border bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1">
              <Label className="text-[11.5px] font-normal text-fg-muted">Name</Label>
              <Input
                className="readout h-8 text-[12.5px]"
                value={param.name}
                onChange={(e) => update(i, { name: e.target.value })}
                aria-label="Parameter name"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11.5px] font-normal text-fg-muted">Type</Label>
              <Select value={param.type} onValueChange={(type) => update(i, withoutHintKind({ ...param, type: type as WorkflowParamType }) )}>
                <SelectTrigger className="h-8 w-full text-[12.5px]" aria-label="Parameter type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_PARAM_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end justify-end gap-2">
              <label className="flex items-center gap-1.5 pb-1.5 text-[11.5px] text-fg-muted">
                <Switch size="sm" checked={param.required} onCheckedChange={(required) => update(i, { required })} aria-label="Required" />
                required
              </label>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove parameter" onClick={() => remove(i)}>
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11.5px] font-normal text-fg-muted">Title</Label>
              <Input className="h-8 text-[12.5px]" value={param.title} onChange={(e) => update(i, { title: e.target.value })} aria-label="Title" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11.5px] font-normal text-fg-muted">Group (optional)</Label>
              <Input
                className="h-8 text-[12.5px]"
                value={param.hints?.group ?? ''}
                onChange={(e) => update(i, { hints: { ...param.hints, group: e.target.value || undefined } })}
                aria-label="Section group"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11.5px] font-normal text-fg-muted">Description</Label>
            <Textarea
              className="min-h-14 text-[12.5px]"
              value={param.description}
              onChange={(e) => update(i, { description: e.target.value })}
              aria-label="Description"
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11.5px] font-normal text-fg-muted">Meaning (optional)</Label>
              <Select
                value={param.hints?.kind ?? 'none'}
                onValueChange={(kind) =>
                  update(i, { hints: { ...param.hints, kind: kind === 'none' ? undefined : (kind as ParamKind), unit: kind === 'duration' ? 's' : undefined } })
                }
                disabled={KIND_OPTIONS_BY_TYPE[param.type].length === 0}
              >
                <SelectTrigger className="h-8 w-full text-[12.5px]" aria-label="Parameter meaning">
                  <SelectValue placeholder="Plain value" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Plain value</SelectItem>
                  {KIND_OPTIONS_BY_TYPE[param.type].map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DefaultEditor param={param} onChange={(d) => update(i, { default: d })} />
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="size-3.5" aria-hidden />
        Add parameter
      </Button>
    </div>
  )
}

function DefaultEditor({ param, onChange }: { param: WorkflowParam; onChange(next: unknown): void }) {
  const has = param.default !== undefined
  const current = has ? param.default : defaultForType(param.type)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[11.5px] font-normal text-fg-muted">Default (optional)</Label>
        {has && (
          <button type="button" className="text-[11px] text-fg-subtle hover:text-fg-muted" onClick={() => onChange(undefined)}>
            clear
          </button>
        )}
      </div>
      {param.type === 'boolean' ? (
        <Switch checked={Boolean(current)} onCheckedChange={onChange} aria-label="Default value" />
      ) : param.type === 'number' || param.type === 'integer' ? (
        <Input
          type="number"
          className="h-8 text-[12.5px]"
          value={typeof current === 'number' ? current : 0}
          onChange={(e) => onChange(e.target.valueAsNumber || 0)}
          aria-label="Default value"
        />
      ) : param.type === 'stringList' ? (
        <Input
          type="text"
          placeholder="one, two, three"
          className="h-8 text-[12.5px]"
          value={Array.isArray(current) ? current.join(', ') : ''}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
          aria-label="Default value, comma-separated"
        />
      ) : param.type === 'numberPair' ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            className="h-8 text-[12.5px]"
            value={Array.isArray(current) ? (current[0] ?? 0) : 0}
            onChange={(e) => onChange([e.target.valueAsNumber || 0, Array.isArray(current) ? (current[1] ?? 0) : 0])}
            aria-label="Default low value"
          />
          <span className="text-fg-subtle">–</span>
          <Input
            type="number"
            className="h-8 text-[12.5px]"
            value={Array.isArray(current) ? (current[1] ?? 0) : 0}
            onChange={(e) => onChange([Array.isArray(current) ? (current[0] ?? 0) : 0, e.target.valueAsNumber || 0])}
            aria-label="Default high value"
          />
        </div>
      ) : (
        <Input
          type="text"
          className="h-8 text-[12.5px]"
          value={typeof current === 'string' ? current : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Default value"
        />
      )}
    </div>
  )
}
