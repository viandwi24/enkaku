'use client'

import type { WorkflowDoc, WorkflowParam } from '@enkaku/protocol'
import { ParamsEditor } from './ParamsEditor'

/**
 * The `start` node's own panel (plan 306 §4.2 step 306.8, G7) — the
 * document's `params[]` live in the START node's panel rather than being a
 * second panel of their own, so opening `start` is where an author declares
 * what the workflow itself takes as input. Reuses `ParamsEditor` (plan 305's
 * surviving set) exactly as `FlowEditor.tsx`'s document-level meta form
 * already does — no second params form.
 */
export function StartPanel({ doc, onSetParams }: { doc: WorkflowDoc; onSetParams(params: WorkflowParam[]): void }) {
  return (
    // The panel is 1040px wide; this form is configuration prose and reads
    // badly stretched across all of it — two 1fr columns become ~400px each
    // and the fields stop looking related (owner report, 2026-09-05, image 1).
    // Capped at a column width, left-aligned, so the grid inside `ParamsEditor`
    // keeps the proportions it was drawn for.
    <div className="max-w-3xl space-y-3 p-3.5">
      <div className="space-y-1">
        <p className="rack-label">workflow parameters</p>
        <p className="text-[11.5px] text-fg-subtle">What this workflow takes as input — shown to whoever runs it, in the Run dialog.</p>
      </div>
      <ParamsEditor params={doc.params} onChange={onSetParams} />
    </div>
  )
}
