'use client'

import { useCallback, useEffect, useState } from 'react'
import { DoctorResponseSchema, type DoctorCheckResult } from '@enkaku/protocol'
import { Popover, PopoverContent, PopoverTrigger, StatusDot, api, cn } from '@enkaku/ui'

/**
 * The status bar's health dot, made interactive (plan 224 §4.7, resolving
 * plan 213 §9 Q2's own open question with the popover option it named).
 * Fetches `GET /api/doctor` — the same checks and the same three fields
 * (`status`/`observed`/`remedy`) `enkaku doctor --json` already prints on the
 * terminal, so the browser and the terminal never disagree about what is
 * wrong (MVP 09 §4: "`bun run doctor` becomes the first screen, not a CLI").
 */
function statusDot(status: DoctorCheckResult['status']): 'free' | 'unauthorized' | 'job' {
  if (status === 'ok') return 'free'
  if (status === 'warn' || status === 'skip') return 'unauthorized'
  return 'job'
}

export function DoctorPopover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<DoctorCheckResult[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api('/api/doctor', DoctorResponseSchema)
      setResults(res.results)
      setError(false)
    } catch {
      setResults(null)
      setError(true)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex flex-none items-center gap-2 pr-[14px]">{children}</PopoverTrigger>
      <PopoverContent className="w-96 p-0">
        <div className="border-b border-line px-3 py-2">
          <p className="text-row font-medium">Doctor checks</p>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {error && <p className="px-3 py-6 text-center text-body text-faint">Could not reach the core.</p>}
          {!error && results === null && <p className="px-3 py-6 text-center text-body text-faint">Loading…</p>}
          {!error &&
            results?.map((r) => (
              <div key={r.id} className="flex flex-col gap-0.5 border-b border-line px-3 py-2 last:border-b-0">
                <div className="flex w-full items-center gap-1.5">
                  <StatusDot state={statusDot(r.status)} pulse={false} className="size-[7px]" />
                  <span className="flex-1 truncate text-body font-medium">{r.title}</span>
                  <span className={cn('shrink-0 text-badge text-faint-2', r.status === 'fail' && 'text-danger')}>{r.status}</span>
                </div>
                <p className="pl-3 text-meta text-faint">{r.observed}</p>
                {r.remedy && <p className="pl-3 text-meta text-faint-2">{r.remedy}</p>}
              </div>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
