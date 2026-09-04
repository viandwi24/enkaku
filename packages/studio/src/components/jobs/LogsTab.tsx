'use client'

import { useMemo, useState } from 'react'
import { EmptyState, LoadingRows, cn } from '@enkaku/ui'
import type { LogLine, LogsPhase } from '@/lib/use-job-detail'

const LEVELS = ['all', 'info', 'debug', 'warn', 'error'] as const
type LevelFilter = (typeof LEVELS)[number]

const LEVEL_TONE: Record<LogLine['level'], string> = {
  error: 'text-danger',
  warn: 'text-warn',
  debug: 'text-faint',
  info: 'text-accent',
}

/**
 * Logs (design handoff, "Screen: Jobs"): "level chips (All/info/debug/warn/
 * error with counts) then a bordered table, `border-radius: 12px`,
 * alternating `var(--panel-2)` rows: time (74px, `Geist Mono` 11px), level
 * (52px, 11px/600, colored), scope (92px, `var(--dim)`), message (`Geist
 * Mono` 11.5px `var(--text-3)`)."
 */
export function LogsTab({ logs, truncated, phase }: { logs: LogLine[]; truncated: boolean; phase: LogsPhase }) {
  const [level, setLevel] = useState<LevelFilter>('all')

  const counts = useMemo(() => {
    const c: Record<LevelFilter, number> = { all: logs.length, info: 0, debug: 0, warn: 0, error: 0 }
    for (const l of logs) c[l.level] += 1
    return c
  }, [logs])

  const shown = level === 'all' ? logs : logs.filter((l) => l.level === level)

  return (
    <div className="px-[14px] pt-3 pb-4">
      <div className="flex items-center gap-[3px] pb-[10px]">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLevel(l)}
            className={cn(
              'flex-none rounded-small px-[10px] py-[5px] text-meta transition-colors',
              l === level ? 'bg-accent-soft font-semibold text-accent' : 'bg-muted font-medium text-dim hover:text-text',
            )}
          >
            {l === 'all' ? 'All' : l}
            <span className="ml-[6px] opacity-65">{counts[l]}</span>
          </button>
        ))}
      </div>

      {truncated && (
        <p className="mb-[10px] text-meta text-warn">Earlier lines were dropped. The full log is kept as the job.log artifact.</p>
      )}

      {phase === 'loading' ? (
        <LoadingRows rows={6} />
      ) : shown.length === 0 ? (
        <EmptyState title="No log lines" description="This run produced none." />
      ) : (
        <div className="overflow-hidden rounded-inner border border-line-2">
          {shown.map((l, i) => (
            <div
              key={`${l.ts}-${i}`}
              className={cn(
                'flex items-center gap-3 px-3 py-[7px]',
                i < shown.length - 1 && 'border-b border-muted-2',
                i % 2 === 1 && 'bg-panel-2',
              )}
            >
              <span className="w-[74px] flex-none font-mono text-label text-faint">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className={cn('w-[52px] flex-none text-label font-semibold', LEVEL_TONE[l.level])}>{l.level}</span>
              <span className="w-[92px] flex-none truncate text-label text-dim">{l.source}</span>
              <span className="min-w-0 flex-1 font-mono text-meta text-text-3" style={{ overflowWrap: 'anywhere' }}>
                {l.msg}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
