'use client'

import type { Target } from '@enkaku/protocol'
import { ConfirmDialog, cn } from '@enkaku/ui'
import { useActionDialogs, type ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import { ACTION_GROUPS, GENERIC_ACTIONS } from '@/lib/generic-actions'

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors'
const ROW_IDLE = 'text-text hover:bg-muted'
const ROW_DANGER = 'text-danger hover:bg-muted'

/**
 * The generic action set, rendered from `@/lib/generic-actions.ts` (design handoff,
 * "Generic action set"; plan 214 §4.12). Every row opens `ActionDialog`
 * with the picker row first (plan 216 §3.6) — an id with no fields still
 * gets the row, so the container is identical in every dialog.
 *
 * Rows are grouped rather than listed flat (owner, 2026-09-05). The set grew
 * from twelve to nineteen once every verb with a working dialog was actually
 * given a row, and nineteen undifferentiated rows is a list an operator
 * scans instead of reads. `ACTION_GROUPS` owns the order and the runs; this
 * file only draws a rule between them, and never hardcodes which rows are in
 * which run.
 */
export function ActionMenu({
  target,
  onDone,
}: {
  target: Target
  /** Closes the bulk menu. */
  onDone: (id: ActionDialogVerb) => void
}) {
  const { open } = useActionDialogs()

  const openDialog = (id: ActionDialogVerb) => {
    const ctx = 'deviceIds' in target ? { deviceIds: target.deviceIds } : 'groupId' in target ? { groupId: target.groupId } : { tags: target.tags }
    open(id, ctx)
    onDone(id)
  }

  const runs = ACTION_GROUPS.map((g) => GENERIC_ACTIONS.filter((item) => item.group === g)).filter((rows) => rows.length > 0)

  const row = (item: (typeof GENERIC_ACTIONS)[number]) => {
    const Icon = item.icon
    if (item.id === 'forget') {
      return (
        <ConfirmDialog
          key={item.id}
          title="Forget these devices?"
          description="Their history stays. A phone that reconnects appears in Discovered again."
          confirmLabel="Forget"
          onConfirm={() => openDialog(item.id)}
          trigger={
            <button type="button" className={cn(ROW, ROW_DANGER)}>
              <Icon className="size-4" aria-hidden />
              {item.label}
            </button>
          }
        />
      )
    }
    return (
      <button key={item.id} type="button" className={cn(ROW, ROW_IDLE)} onClick={() => openDialog(item.id)}>
        <Icon className="size-4" aria-hidden />
        {item.label}
      </button>
    )
  }

  return (
    <div className="p-1">
      {runs.map((rows, i) => (
        <div key={rows[0]?.id ?? i}>
          {i > 0 && <div className="my-1 border-t border-line" />}
          {rows.map(row)}
        </div>
      ))}
    </div>
  )
}
