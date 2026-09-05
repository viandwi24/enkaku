'use client'

import { useMemo, useState } from 'react'
import type { ScriptListItem, WorkflowDoc, WorkflowParam } from '@enkaku/protocol'
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, useAction } from '@enkaku/ui'
import { simulateWorkflow } from '@/lib/api'

/**
 * Plan 309 §4.5 — the workflow's own `params[]` form, plus a list of the
 * `script` nodes whose value will come from a SAMPLE rather than a pin, so
 * an author sees what is being invented before they trust the result. No
 * device picker (G1): there is nothing here to pick a device for.
 */

/** The `plugin/script` half of a node's `name@version` reference — matches `ScriptListItem.name`, which carries no version. */
function scriptNameOf(ref: string): string {
  const at = ref.lastIndexOf('@')
  return at > 0 ? ref.slice(0, at) : ref
}

function defaultParamValue(param: WorkflowParam): unknown {
  if (param.default !== undefined) return param.default
  switch (param.type) {
    case 'boolean':
      return false
    case 'number':
    case 'integer':
      return 0
    case 'stringList':
      return []
    case 'numberPair':
      return [0, 0]
    default:
      return ''
  }
}

function ParamField({ param, value, onChange }: { param: WorkflowParam; value: unknown; onChange(v: unknown): void }) {
  const label = (
    <Label className="text-[11.5px] font-normal text-fg-muted">
      {param.title || param.name}
      {param.required && <span className="ml-1 text-led-warn">*</span>}
    </Label>
  )
  if (param.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <Checkbox checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} />
        {label}
      </div>
    )
  }
  if (param.type === 'number' || param.type === 'integer') {
    return (
      <div className="space-y-1">
        {label}
        <Input
          type="number"
          className="h-8 text-[12.5px]"
          value={typeof value === 'number' ? value : 0}
          onChange={(e) => onChange(param.type === 'integer' ? Math.round(e.target.valueAsNumber || 0) : e.target.valueAsNumber || 0)}
        />
      </div>
    )
  }
  // `stringList`/`numberPair` fall back to a plain text input the author can
  // edit as JSON — a full picker for these is the Run dialog's own job, not
  // this preview's.
  return (
    <div className="space-y-1">
      {label}
      <Input
        className="h-8 text-[12.5px]"
        value={typeof value === 'string' ? value : JSON.stringify(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export function SimulateDialog({
  open,
  onOpenChange,
  doc,
  scripts,
  pinnedIds,
  mocks,
  onSimulated,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  doc: WorkflowDoc
  scripts: readonly ScriptListItem[]
  pinnedIds: ReadonlySet<string>
  /** Author-written mocks from "Use as mock" (plan 309 §4.5, §9 Q2) — merged over stored pins by `simulateWorkflow` itself. */
  mocks: Record<string, unknown>
  onSimulated(ref: { jobId: string; runId: string }): void
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(doc.params.map((p) => [p.name, defaultParamValue(p)])))
  const { run, isPending } = useAction()

  const scriptByName = useMemo(() => new Map(scripts.map((s) => [s.name, s])), [scripts])
  const sampledNodes = useMemo(
    () =>
      doc.nodes.filter((n): n is Extract<typeof n, { kind: 'script' }> => {
        if (n.kind !== 'script') return false
        if (pinnedIds.has(n.id)) return false
        if (Object.prototype.hasOwnProperty.call(mocks, n.id)) return false
        return true
      }),
    [doc.nodes, pinnedIds, mocks],
  )

  const handleRun = () => {
    void run('simulate', () => simulateWorkflow(doc, values, Object.keys(mocks).length > 0 ? mocks : undefined), {
      success: 'Simulation stored',
      failure: 'Could not simulate this workflow',
      onSuccess: (ref) => {
        onOpenChange(false)
        onSimulated(ref)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Simulate</DialogTitle>
          <DialogDescription>Runs the whole graph with no device attached — every script node's value comes from a pin, a sample, or a mock.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {doc.params.length > 0 && (
            <div className="space-y-2">
              <p className="rack-label">workflow parameters</p>
              {doc.params.map((p) => (
                <ParamField key={p.name} param={p} value={values[p.name]} onChange={(v) => setValues((prev) => ({ ...prev, [p.name]: v }))} />
              ))}
            </div>
          )}

          {sampledNodes.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-dashed p-2.5">
              <p className="rack-label">will use a sample</p>
              <p className="text-[11.5px] text-fg-subtle">
                These nodes have no pin and no mock — their value is invented from the script&apos;s declared result shape, or the simulation stops there if it declares none.
              </p>
              <ul className="space-y-0.5 text-[12px]">
                {sampledNodes.map((n) => {
                  const entry = scriptByName.get(scriptNameOf(n.script))
                  return (
                    <li key={n.id} className="flex items-center justify-between gap-2">
                      <span>{n.title.trim() || n.id}</span>
                      <span className={entry?.hasResult ? 'text-fg-subtle' : 'text-led-warn'}>{entry?.hasResult ? 'sample' : 'no result shape'}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleRun} disabled={isPending('simulate')}>
            {isPending('simulate') ? 'Simulating…' : 'Run simulation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
