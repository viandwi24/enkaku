'use client'

import { cn } from '@enkaku/ui'
import { GENERIC_ACTIONS, type GenericActionId } from '@/lib/generic-actions'

/**
 * The Actions tab (design handoff README.md:273; plan 215 §4.10): one row
 * per generic action, same order, same icons as the bulk menu. This plan
 * opens no dialog — every row calls `onAction(id)` and stops (plan 216 owns
 * the dialogs).
 */
export function DeviceActions({ onAction }: { onAction: (id: GenericActionId) => void }) {
  return (
    <div className="flex flex-col gap-0.5 p-1">
      {GENERIC_ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <button
            key={a.id}
            type="button"
            className={cn('flex w-full items-center gap-2.5 rounded-button px-2.5 py-[9px] text-row hover:bg-muted', a.danger && 'text-danger')}
            onClick={() => onAction(a.id)}
          >
            <Icon className="size-4" aria-hidden />
            {a.label}
          </button>
        )
      })}
    </div>
  )
}
