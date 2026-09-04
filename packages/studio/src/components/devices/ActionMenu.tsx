'use client'

import { useState } from 'react'
import type { ActionVerb, GroupInfo, Target } from '@enkaku/protocol'
import { ConfirmDialog, cn } from '@enkaku/ui'
import { toast } from 'sonner'
import { groupResults, runAction } from '@/lib/actions'
import { GENERIC_ACTION_SET } from './action-set'

const ROW = 'flex w-full items-center gap-2.5 rounded-button px-[10px] py-[9px] text-row transition-colors'
const ROW_IDLE = 'text-text hover:bg-muted'
const ROW_DANGER = 'text-danger hover:bg-muted'
const ROW_OFF = 'cursor-not-allowed text-faint-2'

/**
 * The generic action set, rendered from `action-set.ts` (design handoff,
 * "Generic action set"; plan 214 §4.12). A `needsDialog` row is disabled
 * with the stated title until plan 216 builds it; `set-group` opens a
 * nested submenu of every known group instead of a dialog, because this
 * screen already has the list.
 */
export function ActionMenu({
  target,
  count,
  groups,
  onDone,
}: {
  target: Target
  count: number
  groups: GroupInfo[]
  /** Closes the bulk menu; clearing the selection afterward (Forget only) is the caller's call. */
  onDone: (verb: ActionVerb) => void
}) {
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)

  const run = async (verb: (typeof GENERIC_ACTION_SET)[number]['verb'], params: Record<string, unknown> = {}) => {
    try {
      const res = await runAction(verb, target, params as never)
      const grouped = groupResults(res.results)
      const failed = grouped.failed.length + grouped.forbidden.length
      const done = grouped.done.length
      if (failed > 0) toast.warning(`${done} done, ${failed} refused`)
      else toast.success(`${done} done`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      onDone(verb)
    }
  }

  return (
    <div className="p-1">
      {GENERIC_ACTION_SET.map((item) => {
        const Icon = item.icon
        if (item.submenu === 'group') {
          return (
            <div key={item.verb} className="relative">
              <button type="button" className={cn(ROW, ROW_IDLE)} onClick={() => setGroupMenuOpen((v) => !v)}>
                <Icon className="size-4" aria-hidden />
                {item.label}
              </button>
              {groupMenuOpen && (
                <div
                  data-menu-root="1"
                  className="absolute top-0 right-full z-30 w-[226px] rounded-card border border-border bg-panel p-1 shadow-menu"
                >
                  <button
                    type="button"
                    className={cn(ROW, ROW_IDLE)}
                    onClick={() => {
                      setGroupMenuOpen(false)
                      void run('set-group', { groupId: null })
                    }}
                  >
                    No group
                  </button>
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={cn(ROW, ROW_IDLE)}
                      onClick={() => {
                        setGroupMenuOpen(false)
                        void run('set-group', { groupId: g.id })
                      }}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        }
        if (item.needsDialog) {
          return (
            <button key={item.verb} type="button" aria-disabled className={cn(ROW, ROW_OFF)} title="Opens a dialog (plan 216)">
              <Icon className="size-4" aria-hidden />
              {item.label}
            </button>
          )
        }
        if (item.verb === 'forget') {
          return (
            <ConfirmDialog
              key={item.verb}
              title={`Forget ${count} device${count === 1 ? '' : 's'}?`}
              description="Their history stays. A phone that reconnects appears in Discovered again."
              confirmLabel="Forget"
              onConfirm={() => run('forget', {})}
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
          <button key={item.verb} type="button" className={cn(ROW, ROW_IDLE)} onClick={() => void run(item.verb)}>
            <Icon className="size-4" aria-hidden />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
