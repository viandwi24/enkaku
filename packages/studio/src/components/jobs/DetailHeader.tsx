'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { JobStatus } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'
import { STATE_BADGE, STATE_WORD } from './job-view'

/**
 * The right detail's header (design handoff, "Screen: Jobs", "Right
 * detail"): "`min-height: 58px`, wraps: the script name (`Geist Mono`
 * 15px/500) with the **state badge beside it on the same line** (never a
 * badge to the left of a multi-line block), the meta line beneath
 * ("job_8f21c4 · dev-011 · schedule · 20:40 · running 3m 08s", single line,
 * ellipsized), and a `flex: none` button group pushed right by
 * `margin-left: auto`: **Re-run** (accent tint), **Open device**, **Export**."
 *
 * `min-h-[58px]` and not `h-[58px]`: the handoff says the header wraps, and
 * with three buttons and a long script name it does at 1280px.
 *
 * `meta` is a node, not a string, because its first segment is the run picker
 * (`RunPicker`, plan 218 §4.8) and its second may be a link to a parent
 * workflow job. It is still ONE line: the caller composes segments joined by
 * " · " inside a `truncate` row, so the ellipsis lands where the handoff
 * draws it.
 */
export interface HeaderAction {
  key: string
  label: string
  icon: ReactNode
  /** The first action is the accent-tinted one (Re-run). */
  primary?: boolean
  disabled?: boolean
  /** A stated reason, rendered as `title`, never a control that silently does nothing. */
  disabledReason?: string
  onClick?: () => void
  href?: string
}

export function DetailHeader({
  name,
  state,
  meta,
  actions,
}: {
  name: string
  state: JobStatus
  meta: ReactNode
  actions: readonly HeaderAction[]
}) {
  return (
    <div className="flex min-h-[58px] flex-none flex-wrap items-center gap-x-3 gap-y-[10px] border-b border-line px-[14px] py-[10px]">
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="flex min-w-0 items-center gap-[9px]">
          <span className="truncate font-mono text-title font-medium">{name}</span>
          <span className={cn('flex-none rounded-pill px-[10px] py-1 text-badge font-semibold', STATE_BADGE[state])}>
            {STATE_WORD[state]}
          </span>
        </div>
        <div className="mt-[3px] flex min-w-0 items-center gap-[5px] truncate text-meta text-faint">{meta}</div>
      </div>
      <div className="ml-auto flex flex-none items-center gap-[6px]">
        {actions.map((a) => {
          const cls = cn(
            'flex flex-none items-center gap-[7px] rounded-button px-3 py-2 text-body font-medium transition-colors',
            a.primary ? 'bg-accent-soft text-accent' : 'bg-muted text-text-3',
            a.disabled ? 'cursor-default opacity-50' : 'hover:bg-muted-2',
          )
          if (a.href && !a.disabled) {
            return (
              <Link key={a.key} href={a.href} className={cls}>
                {a.icon}
                {a.label}
              </Link>
            )
          }
          return (
            <button key={a.key} type="button" className={cls} disabled={a.disabled} title={a.disabledReason} onClick={a.onClick}>
              {a.icon}
              {a.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
