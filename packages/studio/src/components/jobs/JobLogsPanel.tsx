'use client'

import { useEffect, useRef, useState } from 'react'
import { Switch } from '@enkaku/ui'
import type { LogLine, LogsPhase } from '@/lib/use-job-detail'

/**
 * The Logs tab (plan 26, extracted from `app/jobs/detail/page.tsx`
 * 2026-08-16, closing plan 103 step 103.11's audit row 4). Owns its own
 * "Follow latest" state and scroll container — self-contained, so it drops
 * into the device popup's Jobs tab exactly as it drops into the page.
 */
export function JobLogsPanel({ logs, truncated, phase }: { logs: LogLine[]; truncated: boolean; phase: LogsPhase }) {
  const [followLog, setFollowLog] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (followLog) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, followLog])

  return (
    <div>
      <div className="overflow-hidden rounded-lg border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <h2 className="rack-label">{phase === 'live' ? 'live' : phase === 'loading' ? 'loading' : 'saved to job.log'}</h2>
          {/* A long-running job's oldest retained lines are dropped rather
              than growing without bound. Saying so beats quietly starting
              the story in the middle. */}
          {truncated && <span className="text-[11px] text-fg-subtle">earlier lines dropped — the full log is kept as an artifact</span>}
          <label className="flex items-center gap-2 text-[11.5px] text-fg-muted">
            Follow latest
            <Switch checked={followLog} onCheckedChange={setFollowLog} aria-label="Follow latest lines" />
          </label>
        </div>
        <pre ref={logRef} className="readout max-h-[32rem] overflow-auto whitespace-pre-wrap p-3 text-[11.5px] leading-relaxed">
          {phase === 'loading'
            ? 'Loading…'
            : logs.length === 0
              ? 'This job produced no log lines.'
              : logs.map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.level.padEnd(5)} ${l.source.padEnd(6)} ${l.msg}`).join('\n')}
        </pre>
      </div>
      <p className="mt-2 text-[11.5px] text-fg-subtle">
        Logs stream live while a job runs and are kept afterwards as the <span className="readout">job.log</span> artifact, so this
        panel works for old jobs too.
      </p>
    </div>
  )
}
