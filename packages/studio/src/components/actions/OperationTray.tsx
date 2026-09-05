'use client'

import { useState } from 'react'
import { Button, CaretDownIcon, CaretUpIcon, CheckCircleIcon, Progress, Spinner, WarningIcon, XIcon, cn } from '@enkaku/ui'
import { countResults, dismissOperation, useOperations, type TrackedOperation } from '@/lib/operations'

/**
 * The floating indicator for work that outlived its modal (CEO, 2026-09-05).
 *
 * Bottom-LEFT, not bottom-right, and the reason is the `Toaster`: toasts own
 * the right corner, and a card that sits under a stack of transient toasts is
 * a progress indicator you cannot read at the moment you most want to. The
 * left corner is empty — the rail is 60px, the page pads 10px, the status bar
 * is 44px — so `left-[80px] bottom-[64px]` lands it flush above the status bar
 * with nothing to fight.
 */
export function OperationTray(): React.JSX.Element | null {
  const operations = useOperations()
  const visible = operations.filter((op) => op.visible)
  if (visible.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-[64px] left-[80px] z-40 flex w-[300px] flex-col gap-[6px]">
      {visible.map((op) => (
        <OperationCard key={op.id} op={op} />
      ))}
    </div>
  )
}

function OperationCard({ op }: { op: TrackedOperation }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { done, failed, pending, total } = countResults(op.results)
  // Percent of devices that have answered, not of time — the only progress
  // this API can honestly report. A single-device action therefore jumps 0 to
  // 100, which is correct: there is nothing in between to know.
  const settledCount = done + failed
  const percent = total === 0 ? 0 : Math.round((settledCount / total) * 100)
  const finished = op.settled || pending === 0

  const summary = op.error
    ? op.error
    : finished
      ? failed === 0
        ? `${done} of ${total} done`
        : `${done} done, ${failed} failed`
      : `${settledCount} of ${total} devices`

  return (
    <div className="pointer-events-auto rounded-card border border-border bg-panel px-[10px] py-[8px] shadow-lg">
      <div className="flex items-center gap-[8px]">
        <span className="flex-none">
          {!finished ? (
            <Spinner className="size-[14px] text-dim" />
          ) : op.error || failed > 0 ? (
            <WarningIcon className="size-[14px] text-warn" />
          ) : (
            <CheckCircleIcon className="size-[14px] text-ok" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-row text-text">{op.title}</span>
        {total > 1 && (
          <Button variant="ghost" size="icon-sm" aria-label={open ? 'Hide devices' : 'Show devices'} onClick={() => setOpen((v) => !v)}>
            {open ? <CaretDownIcon /> : <CaretUpIcon />}
          </Button>
        )}
        {/* Only once there is nothing left to watch: dismissing a running
            operation would hide work that is still happening, which is the
            problem this tray exists to solve. */}
        {finished && (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => dismissOperation(op.id)}>
            <XIcon />
          </Button>
        )}
      </div>
      <div className="mt-[6px] flex items-center gap-[8px]">
        <Progress value={percent} className="h-[4px] flex-1" />
        <span className="flex-none text-meta text-dim tabular-nums">{summary}</span>
      </div>
      {open && (
        <ul className="mt-[8px] max-h-[160px] space-y-[3px] overflow-y-auto border-t border-line pt-[6px]">
          {op.results.map((r) => (
            <li key={r.deviceId} className="flex items-baseline gap-[6px] text-meta">
              <span
                className={cn(
                  'flex-none',
                  r.status === 'done' ? 'text-ok' : r.status === 'accepted' ? 'text-dim' : 'text-warn',
                )}
              >
                {r.status === 'done' ? 'done' : r.status === 'accepted' ? 'running' : r.status}
              </span>
              <span className="min-w-0 flex-1 truncate text-dim">{r.message ?? r.deviceId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
