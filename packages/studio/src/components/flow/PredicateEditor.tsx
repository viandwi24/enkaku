'use client'

import { Plus, X } from 'lucide-react'
import { GATE_OPS, WORKFLOW_LIMITS, type GateOp, type Predicate, type WorkflowParam } from '@enkaku/protocol'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@enkaku/ui'
import { placeholderPredicate } from './doc-edit'
import { type NodeOption, ValueExprEditor } from './ValueExprEditor'

/**
 * The one bespoke control this plan builds (plan 99 §4.11, §5 step 99.9).
 *
 * Every OTHER piece of the editor renders "for free" — a `ValueExpr` is a
 * flat, closed union with no recursion, drawable with ordinary Select/Input
 * controls (`ValueExprEditor.tsx`), and a workflow's own PARAMETERS compile
 * to a real JSON Schema (`compileWorkflowParams`) that the existing
 * `schema-form` resolver already knows how to plan and render. A `Predicate`
 * is different in kind, not just size: it is a SELF-RECURSIVE union —
 * `{ left, op, right? } | { all: Predicate[] } | { any: Predicate[] } | {
 * not: Predicate }` — with no JSON-Schema representation at all (it is
 * declared and validated as a Zod type in `@enkaku/protocol`'s `workflow.ts`,
 * never compiled to `z.toJSONSchema`, because it describes a CONDITION, not
 * a stored value). Even if it were compiled, `schema-form/plan.ts`'s own
 * precedence table (row 15) is explicit that a union with more than one real
 * branch degrades to a raw JSON textarea — exactly the outcome plan 99 §5
 * step 99.9's brief calls out by name as disqualifying ("a JSON textarea is
 * not an editor"). So this recursive tree editor is hand-built, with its own
 * combinator switch (single comparison / all / any / not) and its own
 * recursion, bounded by the SAME limits the protocol schema enforces
 * (`WORKFLOW_LIMITS.maxPredicateDepth`/`maxPredicateLeaves`) so the editor
 * can never construct a document the server would refuse for being too
 * deep. Its own *leaves* still reuse `ValueExprEditor` — the recursion is
 * bespoke, the operands are not.
 */

type Shape = 'leaf' | 'all' | 'any' | 'not'

function shapeOf(pred: Predicate): Shape {
  if ('all' in pred) return 'all'
  if ('any' in pred) return 'any'
  if ('not' in pred) return 'not'
  return 'leaf'
}

const UNARY_OPS = new Set<GateOp>(['exists', 'notExists', 'isEmpty', 'notEmpty'])

const OP_LABELS: Record<GateOp, string> = {
  eq: 'equals',
  ne: 'does not equal',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  exists: 'exists',
  notExists: 'does not exist',
  isEmpty: 'is empty',
  notEmpty: 'is not empty',
  length: 'has a length of',
}

export function PredicateEditor({
  value,
  onChange,
  workflowParams,
  nodeOptions,
  depth = 1,
}: {
  value: Predicate
  onChange(next: Predicate): void
  workflowParams: readonly WorkflowParam[]
  nodeOptions: readonly NodeOption[]
  depth?: number
}) {
  const shape = shapeOf(value)
  const atMaxDepth = depth >= WORKFLOW_LIMITS.maxPredicateDepth

  const setShape = (next: Shape) => {
    if (next === shape) return
    if (next === 'leaf') {
      onChange(placeholderPredicate())
    } else if (next === 'all') {
      onChange({ all: [value] })
    } else if (next === 'any') {
      onChange({ any: [value] })
    } else {
      onChange({ not: value })
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed bg-surface-2/40 p-2.5">
      <Select value={shape} onValueChange={(v) => setShape(v as Shape)}>
        <SelectTrigger className="h-7 w-40 text-[11.5px]" aria-label="Condition shape">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="leaf">Single comparison</SelectItem>
          <SelectItem value="all">All of (AND)</SelectItem>
          <SelectItem value="any">Any of (OR)</SelectItem>
          <SelectItem value="not">Not</SelectItem>
        </SelectContent>
      </Select>

      {shape === 'leaf' && 'left' in value && (
        <LeafEditor value={value} onChange={onChange} workflowParams={workflowParams} nodeOptions={nodeOptions} />
      )}

      {shape === 'all' && 'all' in value && (
        <CombinatorList
          items={value.all}
          setItems={(next) => onChange({ all: next })}
          workflowParams={workflowParams}
          nodeOptions={nodeOptions}
          depth={depth}
          atMaxDepth={atMaxDepth}
        />
      )}

      {shape === 'any' && 'any' in value && (
        <CombinatorList
          items={value.any}
          setItems={(next) => onChange({ any: next })}
          workflowParams={workflowParams}
          nodeOptions={nodeOptions}
          depth={depth}
          atMaxDepth={atMaxDepth}
        />
      )}

      {shape === 'not' && 'not' in value && (
        <div className="border-l-2 pl-2.5">
          {atMaxDepth ? (
            <p className="text-[11px] text-fg-subtle">Nested {WORKFLOW_LIMITS.maxPredicateDepth} levels deep — the limit for one gate.</p>
          ) : (
            <PredicateEditor
              value={value.not}
              onChange={(next) => onChange({ not: next })}
              workflowParams={workflowParams}
              nodeOptions={nodeOptions}
              depth={depth + 1}
            />
          )}
        </div>
      )}
    </div>
  )
}

function CombinatorList({
  items,
  setItems,
  workflowParams,
  nodeOptions,
  depth,
  atMaxDepth,
}: {
  items: Predicate[]
  setItems(next: Predicate[]): void
  workflowParams: readonly WorkflowParam[]
  nodeOptions: readonly NodeOption[]
  depth: number
  atMaxDepth: boolean
}) {
  const atMaxLeaves = items.length >= WORKFLOW_LIMITS.maxPredicateLeaves

  return (
    <div className="space-y-2 border-l-2 pl-2.5">
      {items.map((child, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            {atMaxDepth ? (
              <p className="text-[11px] text-fg-subtle">Nested {WORKFLOW_LIMITS.maxPredicateDepth} levels deep — the limit for one gate.</p>
            ) : (
              <PredicateEditor
                value={child}
                onChange={(next) => setItems(items.map((c, j) => (j === i ? next : c)))}
                workflowParams={workflowParams}
                nodeOptions={nodeOptions}
                depth={depth + 1}
              />
            )}
          </div>
          {items.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-1 size-6 shrink-0"
              aria-label="Remove condition"
              onClick={() => setItems(items.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-[11.5px]"
        disabled={atMaxLeaves}
        onClick={() => setItems([...items, placeholderPredicate()])}
      >
        <Plus className="size-3.5" aria-hidden />
        Add condition
      </Button>
    </div>
  )
}

function LeafEditor({
  value,
  onChange,
  workflowParams,
  nodeOptions,
}: {
  value: Extract<Predicate, { left: unknown }>
  onChange(next: Predicate): void
  workflowParams: readonly WorkflowParam[]
  nodeOptions: readonly NodeOption[]
}) {
  const unary = UNARY_OPS.has(value.op)
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      <ValueExprEditor value={value.left} onChange={(next) => onChange({ ...value, left: next ?? value.left })} workflowParams={workflowParams} nodeOptions={nodeOptions} allowUnset={false} />
      <Select
        value={value.op}
        onValueChange={(op) => {
          const nextOp = op as GateOp
          const next: Predicate = UNARY_OPS.has(nextOp) ? { left: value.left, op: nextOp } : { left: value.left, op: nextOp, right: value.right ?? { const: '' } }
          onChange(next)
        }}
      >
        <SelectTrigger className="h-8 w-36 shrink-0 text-[12px]" aria-label="Comparison">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GATE_OPS.map((op) => (
            <SelectItem key={op} value={op}>
              {OP_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!unary && (
        <ValueExprEditor
          value={value.right}
          onChange={(next) => onChange({ ...value, right: next ?? { const: '' } })}
          workflowParams={workflowParams}
          nodeOptions={nodeOptions}
          allowUnset={false}
        />
      )}
    </div>
  )
}
