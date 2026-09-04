'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CaretLeftIcon, CaretRightIcon, PlayIcon, relativeTime, cn } from '@enkaku/ui'
import type { ScriptListItem } from '@enkaku/protocol'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'
import { matchesScript } from '@/app/scripts/matchers'
import { paramCount } from '@/app/plugins/plugin-list'

const PAGE_SIZE = 10

/**
 * The revised Scripts table (MVP 15 §1, plan 217 §3.3 items 1-2): Name ·
 * Plugin · Params · Last run · Run. Column widths follow the handoff's
 * proportion for the old six-column table (`1.6fr 92px 104px 104px 78px
 * 86px`); this table has five columns, so the grid template is
 * `1.6fr 140px 90px 130px 86px` — Name keeps its `1.6fr` weight, Plugin
 * widens to hold `name@version`, Params and Last run are narrow, Run is a
 * fixed action column, matching the handoff's own action-column widths.
 */
export function ScriptsTable({
  items,
  query,
  onReload: _onReload,
}: {
  items: ScriptListItem[] | null
  query: string
  onReload: () => void
}) {
  const [page, setPage] = useState(0)
  const { open } = useActionDialogs()

  if (items === null) {
    return (
      <div className="space-y-2 py-6">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[48px] animate-pulse rounded-input bg-muted" />
        ))}
      </div>
    )
  }

  const filtered = items.filter((s) => matchesScript(s, query))
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const clampedPage = Math.min(page, totalPages - 1)
  const shown = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE)

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <p className="text-row font-medium text-text">No scripts yet</p>
        <p className="max-w-sm text-meta text-dim">
          A script is a member of a plugin. Scaffold one with <code className="font-mono">bunx enkaku init my-pack</code>, then install it above.
        </p>
      </div>
    )
  }
  if (filtered.length === 0) {
    return <p className="py-10 text-center text-body text-dim">No script matches &ldquo;{query}&rdquo;.</p>
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[780px]">
        <div className="grid grid-cols-[1.6fr_140px_90px_130px_86px] border-b border-line px-2 py-2 text-label text-faint">
          <div>Name</div>
          <div>Plugin</div>
          <div>Params</div>
          <div>Last run</div>
          <div className="text-right">Run</div>
        </div>
        {shown.map((s) => {
          const n = paramCount(s.paramsSchema)
          return (
            <div key={s.id} className="grid h-[48px] grid-cols-[1.6fr_140px_90px_130px_86px] items-center border-b border-muted-2 px-2">
              <Link href={`/scripts/detail?id=${encodeURIComponent(s.id)}`} className="truncate font-mono text-[12.5px] text-text hover:text-accent">
                {s.name}
              </Link>
              <Link
                href={`/plugins/detail?name=${encodeURIComponent(s.plugin.name)}`}
                className="w-fit truncate rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11px] text-dim hover:text-accent"
              >
                {s.plugin.name}@{s.plugin.version}
              </Link>
              <div className="text-body text-dim">{n === null ? '—' : n === 0 ? 'none' : `${n} param${n === 1 ? '' : 's'}`}</div>
              <div className="text-meta text-dim">
                {s.lastRun ? (
                  <Link href={`/jobs/detail?id=${s.lastRun.jobId}`} className="hover:text-accent">
                    {relativeTime(s.lastRun.finishedAt ?? s.lastRun.createdAt)}
                  </Link>
                ) : (
                  'never'
                )}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => open('run-script', {}, { scriptId: s.id })}
                  className="flex items-center gap-1 rounded-button px-2 py-1 text-meta text-accent hover:bg-accent-soft"
                >
                  <PlayIcon className="size-3.5" aria-hidden />
                  Run
                </button>
              </div>
            </div>
          )
        })}
        <div className="flex items-center justify-between px-2 py-2">
          <span className="font-mono text-label text-faint">
            {filtered.length === 0
              ? '0 of 0'
              : `${clampedPage * PAGE_SIZE + 1}–${Math.min(filtered.length, (clampedPage + 1) * PAGE_SIZE)} of ${filtered.length}`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={clampedPage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              aria-label="Previous page"
              className={cn(
                'flex size-[26px] items-center justify-center rounded-small border border-border-2',
                clampedPage === 0 ? 'text-faint-2' : 'text-text hover:bg-muted',
              )}
            >
              <CaretLeftIcon className="size-3.5" aria-hidden />
            </button>
            <span className="w-10 text-center text-label text-faint">
              {clampedPage + 1}/{totalPages}
            </span>
            <button
              type="button"
              disabled={clampedPage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              aria-label="Next page"
              className={cn(
                'flex size-[26px] items-center justify-center rounded-small border border-border-2',
                clampedPage >= totalPages - 1 ? 'text-faint-2' : 'text-text hover:bg-muted',
              )}
            >
              <CaretRightIcon className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
