'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { PlayIcon, TrashIcon, ConfirmDialog, relativeTime } from '@enkaku/ui'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'
import { matchesWorkflow } from '@/app/scripts/matchers'
import { deleteWorkflow, type WorkflowInfo } from '@/lib/api'

/**
 * The Workflows card grid (design handoff, "Screen: Scripts & workflows",
 * quoted in full in plan 217 §4.3). The state badge described there is NOT
 * built (§3.3 item 4: the `workflows` table has no status column); the
 * footer's step-chain is built verbatim, but the "N devices · schedule"
 * summary is not literal — a workflow document carries no target and no
 * schedule of its own (a schedule names a workflow, not the reverse), so the
 * footer instead shows the step chain plus a last-updated readout in the
 * position the handoff's target/schedule summary occupied.
 */
export function WorkflowsGrid({
  items,
  query,
  onReload,
}: {
  items: WorkflowInfo[] | null
  query: string
  onReload: () => void
}) {
  const { open } = useActionDialogs()

  if (items === null) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(276px,1fr))] gap-[10px] py-6">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-[160px] animate-pulse rounded-card border border-line-2" />
        ))}
      </div>
    )
  }

  const filtered = items.filter((w) => matchesWorkflow(w, query))

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <p className="text-row font-medium text-text">No workflows yet</p>
        <p className="max-w-sm text-meta text-dim">A workflow is a pipeline of scripts on one device — build one in the editor.</p>
      </div>
    )
  }
  if (filtered.length === 0) {
    return <p className="py-10 text-center text-body text-dim">No workflow matches &ldquo;{query}&rdquo;.</p>
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(276px,1fr))] gap-[10px] py-2">
      {filtered.map((w) => {
        const steps = w.doc.nodes.map((n) => (n.kind === 'script' ? (n.script.split('@')[0]?.split('/').pop() ?? n.script) : n.title || 'gate'))
        return (
          <div key={w.id} className="flex flex-col gap-2 rounded-card border border-line-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <Link href={`/scripts/editor?name=${encodeURIComponent(w.name)}`} className="text-row font-semibold text-text hover:text-accent">
                {w.doc.title || w.name}
              </Link>
              <ConfirmDialog
                trigger={
                  <button type="button" aria-label={`Delete ${w.name}`} className="text-faint hover:text-danger">
                    <TrashIcon className="size-3.5" aria-hidden />
                  </button>
                }
                title={`Delete ${w.name}?`}
                description="This cannot be undone. Any schedule that names it will start failing its next fire."
                onConfirm={() =>
                  void deleteWorkflow(w.name).then(() => {
                    toast.success(`${w.name} deleted`)
                    onReload()
                  })
                }
              />
            </div>
            {w.doc.description && (
              <p className="text-meta text-dim" style={{ lineHeight: 1.55 }}>
                {w.doc.description}
              </p>
            )}
            <div className="flex flex-wrap gap-1">
              {steps.map((label, i) => (
                <span key={i} className="rounded-chip bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-dim">
                  {label}
                </span>
              ))}
            </div>
            <div className="mt-auto flex items-center justify-between border-t border-line pt-2">
              <span className="text-meta text-faint">
                {w.doc.nodes.length} step{w.doc.nodes.length === 1 ? '' : 's'} · updated {relativeTime(w.updatedAt)}
              </span>
              <button
                type="button"
                onClick={() => open('run-workflow', {}, { workflowName: w.name })}
                className="flex items-center gap-1 text-meta text-accent hover:underline"
              >
                <PlayIcon className="size-3" aria-hidden />
                Run
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
