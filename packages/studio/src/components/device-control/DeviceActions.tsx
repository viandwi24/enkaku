'use client'

import { cn } from '@enkaku/ui'
import { ACTION_GROUPS, GENERIC_ACTIONS, type GenericActionId } from '@/lib/generic-actions'

/**
 * The Actions tab (design handoff README.md:273; plan 215 §4.10): the same
 * rows, order and icons as the bulk menu — the handoff's rule is that
 * selecting one device and selecting twenty behave identically.
 *
 * Same GROUPS too, but drawn differently on purpose. The bulk menu nests
 * them behind six rows because it is a floating popover in the corner of the
 * panel and nineteen rows reached nearly to the top of the window (owner,
 * 2026-09-05). This is a scrolling side panel with no such ceiling, and a
 * submenu inside a 274px column would open over the phone the operator is
 * watching. So here the groups are headings and every action stays one click
 * away. `ACTION_GROUPS` still owns the order and the membership; neither
 * screen hardcodes a row.
 */
export function DeviceActions({ onAction }: { onAction: (id: GenericActionId) => void }) {
  return (
    <div className="flex flex-col p-1 pb-2">
      {ACTION_GROUPS.map((group) => {
        const rows = GENERIC_ACTIONS.filter((a) => a.group === group.id)
        if (rows.length === 0) return null
        return (
          <div key={group.id} className="flex flex-col gap-0.5">
            {group.label === '' ? (
              <div className="my-1 border-t border-line" />
            ) : (
              <p className="mt-2 px-2.5 pb-1 text-label tracking-wide text-faint uppercase">{group.label}</p>
            )}
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
        )
      })}
    </div>
  )
}
