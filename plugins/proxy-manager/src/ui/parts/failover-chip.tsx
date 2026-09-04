import { Button, Popover, PopoverContent, PopoverTrigger, cn, relativeTime } from '@enkaku/ui'
import type { ProxyFailoverSnapshot } from './api'

/**
 * The per-record failover-state chip (plan 121 §4.5, step 121.6) — shown
 * beside a row's state badge only when that record is currently on a
 * backup, following the SAME quiet-by-default, per-item pattern
 * `packages/studio/src/components/guest-agent/AgentAlertChip.tsx` uses for
 * the guest agent: a healthy state (here, dialling primary) renders nothing,
 * because a farm of many proxies must not grow a chip on every row for a
 * state nobody needs to act on.
 *
 * **Adapted, not copied, from `AgentAlertChip`'s own shape** — two things a
 * tier-C plugin genuinely cannot reach the way Studio's own component does:
 *
 * - `lucide-react` is not in `UI_EXTERNALS` (`packages/sdk/src/cli/build-ui.ts`)
 *   and is not a dependency of this pack, so there is no icon here — the
 *   chip is a plain text pill, matching this file's own `ProxyStateBadge`/
 *   `ProbeCell` (`bits.tsx`, `catalogue.tsx`), neither of which uses one
 *   either.
 * - `Popover`/`PopoverTrigger`/`PopoverContent` ARE exported by `@enkaku/ui`
 *   (`packages/ui/src/components/popover.tsx`), so the click-to-open detail
 *   panel genuinely is the same primitive, not a fallback.
 *
 * **Why this reads its data from a poll, not a WS subscription** — the
 * plan's own §4.5 asks for a `proxy.failover` WS message "consumed by the
 * new chip for live updates without a poll". That message exists as a
 * structured runtime-log line (`service/failover.ts`'s `emitFailoverEvent`,
 * `shared.ts`'s `PROXY_FAILOVER_EVENT`) — but there is no WS surface this
 * chip can reach: `@enkaku/ui`'s exports (the only farm-provided API a
 * tier-C plugin's bundle has, via `UI_EXTERNALS`) do not include a WS client,
 * and Studio's own `WsClient` (`packages/studio/src/lib/ws.ts`) is internal
 * to Studio's bundle — importing `@enkaku/protocol` to parse `ServerMessage`
 * from this pack's UI would also pull that package's whole schema catalogue
 * into `ui/index.js` (`ui/parts/api.ts`'s own header explains why that is
 * refused elsewhere in this pack). So this chip is fed by
 * `CatalogueTab`'s existing `GET …/http/proxies` poll instead —
 * `catalogue.tsx`'s `transitional` check now ALSO stays true while any row
 * is on a backup, the same 1500 ms cadence `starting`/`stopping` already use
 * (see that file's own comment). It is a deviation from the plan's literal
 * wording, made explicit here rather than silently claiming a WS
 * subscription that does not exist.
 */
export function FailoverChip({
  label,
  failover,
  resetting,
  onReset,
}: {
  /** The record's own name (or key, when unnamed) — for the popover's sentences. */
  label: string
  failover: ProxyFailoverSnapshot | null
  resetting: boolean
  onReset: () => void
}) {
  // Quiet on primary, and quiet when nothing is known — a record dialling
  // its own primary upstream (or one with no live failover controller at
  // all, i.e. not running) is not news.
  if (!failover || failover.activeIndex === 0) return null

  const latest = failover.history[0] ?? null
  const since = latest ? relativeTime(latest.at) : null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'mt-1 inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium transition-colors',
            'border-led-warn/35 bg-led-warn/10 text-led-warn hover:bg-led-warn/20',
          )}
          title={`On backup #${failover.activeIndex}${since ? `, since ${since}` : ''} — open for the history and a manual reset.`}
        >
          Backup #{failover.activeIndex}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2">
        <div>
          <p className="text-[13px] font-medium">“{label}” is on backup #{failover.activeIndex}</p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
            {latest ? `Switched ${since} — ${latest.reason}.` : 'The primary upstream has not been confirmed healthy recently.'} If this record has auto
            failback on, it switches back to primary on its own once the primary is confirmed healthy again — this button forces it back sooner.
          </p>
        </div>

        <Button size="sm" disabled={resetting} onClick={onReset}>
          Reset to primary
        </Button>

        {failover.history.length > 0 ? (
          <div className="space-y-1 border-t border-border pt-2">
            <p className="text-[11px] font-medium text-fg-muted">History, most recent first</p>
            <ul className="space-y-1">
              {failover.history.map((entry, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-fg-muted">
                  {relativeTime(entry.at)} — {entry.from === entry.to ? `stayed on #${entry.from}` : `#${entry.from} → #${entry.to}`}: {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
