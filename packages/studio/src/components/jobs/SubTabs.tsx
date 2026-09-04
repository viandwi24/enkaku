'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@enkaku/ui'

/**
 * The five sub-tabs (design handoff, "Screen: Jobs"): "Sub-tabs
 * (`padding: 6px 11px`, `border-radius: 9px`, 12.5px + icon): **Inputs**
 * `ph-sign-in` · **Output** `ph-sign-out` · **Logs** `ph-list-dashes` ·
 * **Timeline** `ph-film-strip` · **Artifacts** `ph-images`."
 *
 * Links, not buttons: the sub-tab is `?view=` (plan 218 §3.3).
 */
export interface SubTab {
  key: string
  label: string
  icon: ReactNode
  href: string
  disabled?: boolean
}

export function SubTabs({ tabs, active }: { tabs: readonly SubTab[]; active: string }) {
  return (
    <div className="flex flex-none items-center gap-[3px] border-b border-line px-3 pt-2 pb-[6px]">
      {tabs.map((t) =>
        t.disabled ? (
          <span
            key={t.key}
            aria-disabled="true"
            className="flex flex-none items-center gap-[7px] rounded-input px-[11px] py-[6px] text-body font-medium text-faint-2"
          >
            {t.icon}
            {t.label}
          </span>
        ) : (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === active ? 'page' : undefined}
            className={cn(
              'flex flex-none items-center gap-[7px] rounded-input px-[11px] py-[6px] text-body transition-colors',
              t.key === active ? 'bg-accent-soft font-semibold text-accent' : 'font-medium text-faint hover:text-text',
            )}
          >
            {t.icon}
            {t.label}
          </Link>
        ),
      )}
    </div>
  )
}
