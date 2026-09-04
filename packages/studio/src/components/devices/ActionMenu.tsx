'use client'

import type { Target } from '@enkaku/protocol'
import { ConfirmDialog, cn } from '@enkaku/ui'
import { useActionDialogs, type ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import { GENERIC_ACTION_SET } from './action-set'

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors'
const ROW_IDLE = 'text-text hover:bg-muted'
const ROW_DANGER = 'text-danger hover:bg-muted'

/**
 * The generic action set, rendered from `action-set.ts` (design handoff,
 * "Generic action set"; plan 214 §4.12). Every row opens `ActionDialog`
 * with the picker row first (plan 216 §3.6) — a verb with no fields still
 * gets the row, so the container is identical in every dialog. The three
 * overflow entries (Prepare, Label, Network) render below a `border-t`
 * separator (MVP 15 §1).
 */
export function ActionMenu({
  target,
  onDone,
}: {
  target: Target
  /** Closes the bulk menu. */
  onDone: (verb: ActionDialogVerb) => void
}) {
  const { open } = useActionDialogs()

  const openDialog = (verb: ActionDialogVerb) => {
    const ctx = 'deviceIds' in target ? { deviceIds: target.deviceIds } : 'groupId' in target ? { groupId: target.groupId } : { tags: target.tags }
    open(verb, ctx)
    onDone(verb)
  }

  const main = GENERIC_ACTION_SET.filter((item) => !item.overflow)
  const overflow = GENERIC_ACTION_SET.filter((item) => item.overflow)

  const row = (item: (typeof GENERIC_ACTION_SET)[number]) => {
    const Icon = item.icon
    if (item.verb === 'forget') {
      return (
        <ConfirmDialog
          key={item.verb}
          title="Forget these devices?"
          description="Their history stays. A phone that reconnects appears in Discovered again."
          confirmLabel="Forget"
          onConfirm={() => openDialog(item.verb)}
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
      <button key={item.verb} type="button" className={cn(ROW, ROW_IDLE)} onClick={() => openDialog(item.verb)}>
        <Icon className="size-4" aria-hidden />
        {item.label}
      </button>
    )
  }

  return (
    <div className="p-1">
      {main.map(row)}
      {overflow.length > 0 && (
        <>
          <div className="my-1 border-t border-line" />
          {overflow.map(row)}
        </>
      )}
    </div>
  )
}
