'use client'

import { cn } from '@enkaku/ui'
import { ACTION_GROUPS, GENERIC_ACTIONS, type GenericActionId } from '@/lib/generic-actions'

/**
 * The Actions tab (design handoff README.md:273; plan 215 §4.10): one row
 * per generic action, same order, same icons, SAME GROUPING as the bulk
 * menu — the handoff's own rule is that selecting one device and selecting
 * twenty behave identically, and a tab that grouped its rows differently
 * from the menu beside it would break that in the most confusing way
 * available. Both read `ACTION_GROUPS`; neither owns the order.
 */
export function DeviceActions({ onAction }: { onAction: (id: GenericActionId) => void }) {
  return (
    <div className="flex flex-col p-1">
      {ACTION_GROUPS.map((g) => GENERIC_ACTIONS.filter((a) => a.group === g))
        .filter((rows) => rows.length > 0)
        .map((rows, i) => (
          <div key={rows[0]?.id ?? i} className="flex flex-col gap-0.5">
            {i > 0 && <div className="my-1 border-t border-line" />}
            {rows.map((a) => {
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
        ))}
    </div>
  )
}
