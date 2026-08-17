import type { AgentUsage } from '@enkaku/protocol'
import { formatTokens, formatUsd } from '@enkaku/ui'

/**
 * A run's token/cost footer (plan 69 §3.4, §4.2). Cache read tokens get
 * their OWN figure rather than folding into input — Plan 65 §3.4 designed
 * for prompt caching and Plan 66 §6.13 tests it; a number that regresses
 * silently would waste that design, and this is how anyone would notice
 * (criterion 8).
 */
export function UsageBadge({ usage, compact }: { usage: AgentUsage; compact?: boolean }) {
  if (compact) {
    return (
      <span className="readout inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-fg-muted">
        <span title="Input tokens">in {formatTokens(usage.inputTokens)}</span>
        <span title="Output tokens">out {formatTokens(usage.outputTokens)}</span>
        <span title="Cache read tokens — shown separately from input, not folded into it">cache-read {formatTokens(usage.cacheReadTokens)}</span>
        <span title="Cache write tokens">cache-write {formatTokens(usage.cacheWriteTokens)}</span>
        <span className="font-medium text-fg" title="Estimated cost">
          {formatUsd(usage.costUsd)}
        </span>
      </span>
    )
  }
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-5">
      <Stat label="input" value={formatTokens(usage.inputTokens)} />
      <Stat label="output" value={formatTokens(usage.outputTokens)} />
      <Stat label="cache read" value={formatTokens(usage.cacheReadTokens)} />
      <Stat label="cache write" value={formatTokens(usage.cacheWriteTokens)} />
      <Stat label="cost" value={formatUsd(usage.costUsd)} emphasize />
    </dl>
  )
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <dt className="text-[10.5px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={`readout ${emphasize ? 'font-semibold text-fg' : 'text-fg-muted'}`}>{value}</dd>
    </div>
  )
}
