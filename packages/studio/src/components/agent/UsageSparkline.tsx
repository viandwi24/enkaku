import type { DailyUsage } from '@/lib/agent-usage'
import { formatUsd } from '@/lib/format'

/**
 * A fourteen-day cost sparkline (plan 69 §3.4) — one bar per day, height
 * proportional to that day's cost, using the same accent token every other
 * "this matters" element in Studio uses rather than a separate chart
 * palette. Bars, not a line: this is a small enough surface that a line
 * chart's axes would cost more room than the shape earns.
 */
export function UsageSparkline({ days }: { days: DailyUsage[] }) {
  const max = Math.max(...days.map((d) => d.usage.costUsd ?? 0), 0.0001)
  return (
    <div className="flex h-10 items-end gap-[3px]" role="img" aria-label="Daily cost over the last 14 days">
      {days.map((d) => {
        const cost = d.usage.costUsd ?? 0
        const pct = Math.max(2, Math.round((cost / max) * 100))
        return (
          <div
            key={d.day}
            title={`${d.day} — ${formatUsd(cost)}`}
            className="flex-1 rounded-sm bg-accent/70"
            style={{ height: `${pct}%` }}
          />
        )
      })}
    </div>
  )
}
