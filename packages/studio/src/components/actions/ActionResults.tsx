import type { ActionResult, ActionResultStatus } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'

/**
 * A minimal per-device outcome list for the old bulk/single-device dialogs
 * (plan 207 §4.9) — one row per `ActionResult`, a status chip and the
 * message when present. No design investment here on purpose: plan 216
 * replaces this with the design handoff's own chips once the dialogs
 * themselves are rebuilt; this only has to make the actions API's answer
 * legible today.
 */

const STATUS_LABEL: Record<ActionResultStatus, string> = {
  accepted: 'accepted',
  skipped: 'skipped',
  forbidden: 'forbidden',
  warned: 'warned',
  done: 'done',
  failed: 'failed',
}

const STATUS_TONE: Record<ActionResultStatus, string> = {
  done: 'text-ok border-ok/35 bg-ok/10',
  accepted: 'text-accent border-accent/35 bg-accent/10',
  failed: 'text-danger border-danger/40 bg-danger/10',
  forbidden: 'text-danger border-danger/40 bg-danger/10',
  warned: 'text-warn border-warn/35 bg-warn/10',
  skipped: 'text-faint border-line bg-transparent',
}

const badgeBase = 'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap shrink-0'

export function ActionResults({ results, nameOf }: { results: ActionResult[]; nameOf: (deviceId: string) => string }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {results.map((result) => (
        <li key={result.deviceId} className="flex items-start justify-between gap-2 text-[12.5px]">
          <span className="text-dim truncate">{nameOf(result.deviceId)}</span>
          <span className="flex flex-col items-end gap-0.5 text-right">
            <span className={cn(badgeBase, STATUS_TONE[result.status])}>
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {STATUS_LABEL[result.status]}
            </span>
            {result.message && <span className="text-faint wrap-anywhere">{result.message}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
