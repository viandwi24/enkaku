'use client'

import type { ValueExpr, WorkflowParam } from '@enkaku/protocol'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

/**
 * The bindings sub-form (plan 99 §3.6, §4.11) — a `ValueExpr` is a closed,
 * four-member union (`const` / `param` / `from` / `run`), never a general
 * expression (§3.6's own "a lookup, not a language"), so it is drawn with
 * ordinary Select/Input controls rather than routed through the schema-form
 * resolver: there is no JSON Schema for a `ValueExpr` to plan a control
 * from — it is a workflow-editor-native concept, the same category as
 * `DevicePicker` or `ParamSetPicker`, not a second entry in
 * `schema-form/plan.ts`'s `FieldPlan` union. `PredicateEditor.tsx`'s own doc
 * comment explains why THAT control, not this one, is the plan's one
 * bespoke control.
 *
 * Every constant is entered through a native `<input>` of the matching HTML
 * type (text/number/checkbox) — never a JSON textarea — which is what makes
 * "without typing JSON anywhere" (plan 99 §5 step 99.9's verifiable result)
 * literally true for a binding, not merely close.
 */

export type ValueExprKind = 'unset' | 'const' | 'param' | 'from' | 'run'

export function kindOfValueExpr(value: ValueExpr | undefined): ValueExprKind {
  if (value === undefined) return 'unset'
  if ('const' in value) return 'const'
  if ('param' in value) return 'param'
  if ('from' in value) return 'from'
  return 'run'
}

type ConstType = 'string' | 'number' | 'boolean'

function constTypeOf(value: unknown): ConstType {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

function defaultForConstType(type: ConstType): unknown {
  if (type === 'number') return 0
  if (type === 'boolean') return false
  return ''
}

export interface NodeOption {
  id: string
  label: string
}

export function ValueExprEditor({
  value,
  onChange,
  workflowParams,
  nodeOptions,
  allowUnset = true,
  placeholder = 'Not set',
}: {
  value: ValueExpr | undefined
  onChange(next: ValueExpr | undefined): void
  workflowParams: readonly WorkflowParam[]
  /** Earlier nodes this binding may legitimately read from — the caller decides eligibility (plan 99 §3.6's forward-ref rule is enforced server-side by `checkWorkflow`; the picker here is a convenience, not the source of truth). */
  nodeOptions: readonly NodeOption[]
  allowUnset?: boolean
  placeholder?: string
}) {
  const kind = kindOfValueExpr(value)

  const setKind = (next: ValueExprKind) => {
    if (next === 'unset') {
      onChange(undefined)
    } else if (next === 'const') {
      onChange({ const: '' })
    } else if (next === 'param') {
      onChange({ param: workflowParams[0]?.name ?? '' })
    } else if (next === 'from') {
      onChange({ from: nodeOptions[0]?.id ?? '', optional: false })
    } else {
      onChange({ run: 'summary' })
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-1.5">
      <Select value={kind} onValueChange={(v) => setKind(v as ValueExprKind)}>
        <SelectTrigger className="h-8 w-[9.5rem] shrink-0 text-[12px]" aria-label="Value source">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowUnset && <SelectItem value="unset">Not set</SelectItem>}
          <SelectItem value="const">Constant</SelectItem>
          <SelectItem value="param">Workflow parameter</SelectItem>
          <SelectItem value="from">Earlier node's output</SelectItem>
          <SelectItem value="run">The whole run summary</SelectItem>
        </SelectContent>
      </Select>

      {kind === 'const' && value && 'const' in value && (
        <ConstEditor value={value.const} onChange={(next) => onChange({ const: next })} />
      )}

      {kind === 'param' && value && 'param' in value && (
        <Select value={value.param} onValueChange={(name) => onChange({ param: name })}>
          <SelectTrigger className="h-8 w-44 text-[12px]" aria-label="Workflow parameter">
            <SelectValue placeholder={workflowParams.length === 0 ? 'No parameters declared' : 'Pick a parameter'} />
          </SelectTrigger>
          <SelectContent>
            {workflowParams.length === 0 ? (
              <SelectItem value="" disabled>
                No workflow parameters yet
              </SelectItem>
            ) : (
              workflowParams.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.title || p.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      )}

      {kind === 'from' && value && 'from' in value && (
        <FromEditor value={value} onChange={onChange} nodeOptions={nodeOptions} />
      )}

      {kind === 'run' && <span className="mt-1.5 text-[11.5px] text-fg-muted">one entry per completed node</span>}
    </div>
  )
}

function ConstEditor({ value, onChange }: { value: unknown; onChange(next: unknown): void }) {
  const type = constTypeOf(value)
  return (
    <div className="flex items-center gap-1.5">
      <Select value={type} onValueChange={(t) => onChange(defaultForConstType(t as ConstType))}>
        <SelectTrigger className="h-8 w-20 text-[12px]" aria-label="Constant type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="string">Text</SelectItem>
          <SelectItem value="number">Number</SelectItem>
          <SelectItem value="boolean">Yes/No</SelectItem>
        </SelectContent>
      </Select>
      {type === 'boolean' ? (
        <Switch checked={Boolean(value)} onCheckedChange={onChange} aria-label="Constant value" />
      ) : type === 'number' ? (
        <Input
          type="number"
          className="h-8 w-28 text-[12.5px]"
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => onChange(e.target.valueAsNumber || 0)}
          aria-label="Constant value"
        />
      ) : (
        <Input
          type="text"
          className="h-8 w-40 text-[12.5px]"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Constant value"
        />
      )}
    </div>
  )
}

function FromEditor({
  value,
  onChange,
  nodeOptions,
}: {
  value: Extract<ValueExpr, { from: string }>
  onChange(next: ValueExpr): void
  nodeOptions: readonly NodeOption[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={value.from} onValueChange={(id) => onChange({ ...value, from: id })}>
        <SelectTrigger className="h-8 w-40 text-[12px]" aria-label="Source node">
          <SelectValue placeholder={nodeOptions.length === 0 ? 'No earlier node' : 'Pick a node'} />
        </SelectTrigger>
        <SelectContent>
          {nodeOptions.length === 0 ? (
            <SelectItem value="" disabled>
              No earlier node
            </SelectItem>
          ) : (
            nodeOptions.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <Input
        type="text"
        placeholder="path (optional)"
        className="h-8 w-32 text-[12.5px]"
        value={value.path ?? ''}
        onChange={(e) => onChange({ ...value, path: e.target.value || undefined })}
        aria-label="Path into the output"
      />
      <label className="flex items-center gap-1.5 text-[11.5px] text-fg-muted">
        <Switch
          size="sm"
          checked={value.optional}
          onCheckedChange={(optional) => onChange({ ...value, optional, default: optional ? (value.default ?? '') : undefined })}
          aria-label="Optional, with a default"
        />
        optional
      </label>
      {value.optional && (
        <Input
          type="text"
          placeholder="default"
          className="h-8 w-24 text-[12.5px]"
          value={typeof value.default === 'string' || typeof value.default === 'number' ? String(value.default) : ''}
          onChange={(e) => onChange({ ...value, default: e.target.value })}
          aria-label="Default value"
        />
      )}
    </div>
  )
}
