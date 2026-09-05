'use client'

import { useState } from 'react'
import type { Target } from '@enkaku/protocol'
import { CaretRightIcon, ConfirmDialog, cn } from '@enkaku/ui'
import { useActionDialogs, type ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import { ACTION_GROUPS, GENERIC_ACTIONS, type ActionGroup } from '@/lib/generic-actions'

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors'
const ROW_IDLE = 'text-text hover:bg-muted'
const ROW_DANGER = 'text-danger hover:bg-muted'

/**
 * The generic action set, rendered from `@/lib/generic-actions.ts` (design
 * handoff, "Generic action set"; plan 214 §4.12). Every leaf row opens
 * `ActionDialog` with the picker row first (plan 216 §3.6) — an id with no
 * fields still gets the row, so the container is identical in every dialog.
 *
 * TWO LEVELS, not one flat list (owner, 2026-09-05). The set grew from twelve
 * rows to nineteen once every verb with a working dialog was actually given
 * one, and nineteen rows in the floating bulk menu reached from the bottom
 * corner of the panel almost to the top of the window — the owner's own
 * words, and the reason a first attempt at separator rules was not enough:
 * separators make a long list legible, they do not make it short. So the top
 * level is six group rows plus Forget, and a group opens its own panel
 * beside it.
 *
 * Opens on hover AND on click, closes on leaving the pair. Hover alone would
 * make this unusable on a touchscreen; click alone would make it feel stuck
 * to a mouse user who expects a submenu to follow the pointer.
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
  const [openGroup, setOpenGroup] = useState<ActionGroup | null>(null)

  const openDialog = (id: ActionDialogVerb) => {
    const ctx = 'deviceIds' in target ? { deviceIds: target.deviceIds } : 'groupId' in target ? { groupId: target.groupId } : { tags: target.tags }
    open(id, ctx)
    onDone(id)
  }

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
      <button key={item.id} type="button" className={cn(ROW, item.danger ? ROW_DANGER : ROW_IDLE)} onClick={() => openDialog(item.id)}>
        <Icon className="size-4" aria-hidden />
        {item.label}
      </button>
    )
  }

  return (
    <div className="relative p-1" onMouseLeave={() => setOpenGroup(null)}>
      {ACTION_GROUPS.map((group) => {
        const rows = GENERIC_ACTIONS.filter((a) => a.group === group.id)
        if (rows.length === 0) return null

        // An unlabelled group is drawn inline under a rule — today that is
        // `danger`, and Forget must never need a hover to be found.
        if (group.label === '') {
          return (
            <div key={group.id}>
              <div className="my-1 border-t border-line" />
              {rows.map(row)}
            </div>
          )
        }

        const isOpen = openGroup === group.id
        // The group's own icon is its first action's — a run named "Files &
        // agent" opening on an upload arrow says more than a folder would.
        const GroupIcon = rows[0]!.icon
        return (
          <div key={group.id} className="relative" onMouseEnter={() => setOpenGroup(group.id)}>
            <button
              type="button"
              className={cn(ROW, ROW_IDLE, isOpen && 'bg-muted')}
              onClick={() => setOpenGroup(isOpen ? null : group.id)}
              aria-expanded={isOpen}
            >
              <GroupIcon className="size-4 text-faint" aria-hidden />
              <span className="flex-1 text-left">{group.label}</span>
              <span className="text-label text-faint">{rows.length}</span>
              <CaretRightIcon className="size-3 text-faint" aria-hidden />
            </button>
            {isOpen && (
              /*
               * Right-aligned to this menu's LEFT edge: the bulk pill sits in
               * the bottom-right corner of the panel, so a submenu opening to
               * the right would open off the edge of the window every time.
               * `bottom-0` rather than `top-0` for the same reason the parent
               * opens upward — there is more room above than below.
               */
              <div className="absolute right-full bottom-0 mr-1 w-[212px] rounded-card border border-border bg-panel p-1 shadow-popover">
                {rows.map(row)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
