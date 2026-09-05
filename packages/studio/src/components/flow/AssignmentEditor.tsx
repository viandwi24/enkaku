'use client'

import { useState, type DragEvent } from 'react'
import type { ValueExpr, WorkflowParam } from '@enkaku/protocol'
import { assignmentsToJson, jsonToAssignments, type SetAssignment } from '@enkaku/protocol'
import { Button, DotsSixVerticalIcon, Label, PlusIcon, Switch, Tabs, TabsList, TabsTrigger, Textarea, TrashIcon, cn } from '@enkaku/ui'
import { ExprField, type ActiveField } from './ExprField'
import { DATA_TREE_DRAG_MIME, type DataTreeDragPayload } from './DataTree'
import type { PreviewScope } from './usePreview'
import type { NodeOption } from './ValueExprEditor'

/**
 * The `set` node's own editor (plan 312 §4.4) — one row per assignment,
 * `[⠿] [name][fx] = [value][fx] [🗑]`, plus `keepOnlySet` and a Fields/JSON
 * tab switch (§4.5). Both tabs edit the SAME `assignments[]` — the JSON tab
 * is a projection, never a second source of truth: it renders through
 * `assignmentsToJson` and commits back only through `jsonToAssignments`,
 * both pure and tested in `@enkaku/protocol` (G11/G12), never re-implemented
 * here.
 */

const EMPTY_ASSIGNMENT = (): SetAssignment => ({ name: { const: '' }, value: { const: '' } })

export function AssignmentEditor({
  assignments,
  keepOnlySet,
  onChange,
  onChangeKeepOnlySet,
  workflowParams,
  nodeOptions,
  previewScope,
  predecessorId,
  onRegisterActive,
}: {
  assignments: readonly SetAssignment[]
  keepOnlySet: boolean
  onChange(next: SetAssignment[]): void
  onChangeKeepOnlySet(next: boolean): void
  workflowParams: readonly WorkflowParam[]
  nodeOptions: readonly NodeOption[]
  previewScope: PreviewScope
  predecessorId: string | null
  onRegisterActive(active: ActiveField | null): void
}) {
  const [tab, setTab] = useState<'fields' | 'json'>('fields')
  const [dragOver, setDragOver] = useState(false)

  const updateRow = (index: number, patch: Partial<SetAssignment>) => {
    onChange(assignments.map((a, i) => (i === index ? { ...a, ...patch } : a)))
  }
  const removeRow = (index: number) => {
    onChange(assignments.filter((_, i) => i !== index))
  }
  const addRow = () => {
    onChange([...assignments, EMPTY_ASSIGNMENT()])
  }
  const moveRow = (from: number, to: number) => {
    if (to < 0 || to >= assignments.length || from === to) return
    const next = [...assignments]
    const [moved] = next.splice(from, 1)
    if (moved) next.splice(to, 0, moved)
    onChange(next)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData(DATA_TREE_DRAG_MIME)
    if (!raw) return
    try {
      const payload = JSON.parse(raw) as DataTreeDragPayload
      // n8n's own documented default (plan 312 §3.1, R1/R4): the leaf's own
      // key becomes the field NAME as a literal, and the field VALUE becomes
      // a reference expression to it — one drag, one complete row (G5).
      onChange([...assignments, { name: { const: payload.leafName }, value: { expr: payload.ref } }])
    } catch {
      // Not a data-tree payload — ignore the drop.
    }
  }

  return (
    <div className="space-y-3">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'fields' | 'json')}>
        <TabsList variant="compact">
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
      </Tabs>

      <Label className="flex items-center gap-2 text-[12px]">
        <Switch checked={keepOnlySet} onCheckedChange={onChangeKeepOnlySet} />
        Keep only the fields set here
      </Label>

      {tab === 'fields' ? (
        <div
          className={cn('space-y-2 rounded-md border border-dashed p-2', dragOver && 'border-accent bg-accent/5')}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DATA_TREE_DRAG_MIME)) {
              e.preventDefault()
              setDragOver(true)
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {assignments.length === 0 && <p className="px-1 py-2 text-[11.5px] text-fg-subtle">No fields yet — drag a value from the input pane, or add one below.</p>}
          {assignments.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 rounded-md border p-1.5">
              <button
                type="button"
                className="mt-1.5 shrink-0 cursor-grab text-fg-subtle hover:text-fg"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', String(i))
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = Number(e.dataTransfer.getData('text/plain'))
                  if (Number.isInteger(from)) moveRow(from, i)
                }}
                aria-label={`Reorder assignment ${i + 1}`}
                title="Drag to reorder"
              >
                <DotsSixVerticalIcon className="size-3.5" aria-hidden />
              </button>
              <div className="min-w-0 flex-1 space-y-1">
                <ExprField
                  value={a.name}
                  onChange={(next) => updateRow(i, { name: next ?? { const: '' } })}
                  workflowParams={workflowParams}
                  nodeOptions={nodeOptions}
                  previewScope={previewScope}
                  predecessorId={predecessorId}
                  onRegisterActive={onRegisterActive}
                />
              </div>
              <span className="mt-1.5 shrink-0 text-[12px] text-fg-subtle">=</span>
              <div className="min-w-0 flex-[1.4] space-y-1">
                <ExprField
                  value={a.value}
                  onChange={(next) => updateRow(i, { value: next ?? { const: '' } })}
                  workflowParams={workflowParams}
                  nodeOptions={nodeOptions}
                  previewScope={previewScope}
                  predecessorId={predecessorId}
                  onRegisterActive={onRegisterActive}
                />
              </div>
              <Button type="button" variant="ghost" size="icon-sm" className="mt-1" aria-label={`Remove assignment ${i + 1}`} onClick={() => removeRow(i)}>
                <TrashIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <PlusIcon className="size-3.5" aria-hidden />
            Add field
          </Button>
        </div>
      ) : (
        <JsonTab assignments={assignments} onChange={onChange} />
      )}
    </div>
  )
}

/**
 * The JSON tab (plan 312 §4.5) — a controlled textarea seeded from
 * `assignmentsToJson`, and committed back through `jsonToAssignments` only
 * on a successful parse; an invalid or unrepresentable document shows its
 * reason and does NOT commit (rule 3: never stored raw). Local text state so
 * a user can type invalid JSON mid-edit without losing keystrokes.
 */
function JsonTab({ assignments, onChange }: { assignments: readonly SetAssignment[]; onChange(next: SetAssignment[]): void }) {
  const encoded = assignmentsToJson(assignments)
  const [text, setText] = useState(() => (encoded.ok ? encoded.json : '{}'))
  const [error, setError] = useState<string | null>(encoded.ok ? null : encoded.message)

  const commit = (next: string) => {
    setText(next)
    const result = jsonToAssignments(next)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(null)
    onChange(result.assignments)
  }

  return (
    <div className="space-y-1.5">
      {!encoded.ok && (
        <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2 py-1 text-[11.5px] text-led-warn">
          Some fields cannot be shown as JSON: {encoded.message}. Edit them on the Fields tab first.
        </p>
      )}
      <Textarea className="min-h-40 font-mono text-[12px]" value={text} onChange={(e) => commit(e.target.value)} aria-label="Assignments as JSON" spellCheck={false} />
      {error && <p className="text-[11px] text-led-danger">{error}</p>}
    </div>
  )
}
