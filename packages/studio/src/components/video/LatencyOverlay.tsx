'use client'

import type { LatencySummary, LegSummary } from '@enkaku/protocol'

/**
 * The Device Control latency instrument (plan 203 §4.10). Presentational
 * only — it takes a `LatencySummary` and renders it, never fetches, never
 * subscribes to the WS, never imports `LiveView`. Reuses today's `readout`/
 * `rack-label` classes and Tailwind v4 token classes rather than waiting for
 * plan 204's restyle (§3.2 D5).
 *
 * Studio has zero tests (plan 200 §8.3); this component is verified by
 * `bun run typecheck` and an owner smoke on the lab device (plan 203 §12).
 */

function formatLeg(leg: LegSummary | null, offsetSamples: number, unit = ' ms'): string {
  if (leg === null) return `estimating (${offsetSamples}/60)`
  return `${Math.round(leg.median)} / ${Math.round(leg.p95)}${unit}`
}

function formatAbsoluteLeg(leg: LegSummary, unit = ' ms'): string {
  if (leg.n === 0) return '–'
  return `${Math.round(leg.median)} / ${Math.round(leg.p95)}${unit}`
}

export function LatencyOverlay({ summary }: { summary: LatencySummary }) {
  return (
    <dl
      data-testid="latency-overlay"
      className="absolute left-2 top-2 z-10 rounded-md bg-surface/90 px-2 py-1.5 text-[11px] leading-tight text-fg-muted shadow"
    >
      <div className="flex justify-between gap-3">
        <dt className="rack-label">device→host</dt>
        <dd className="readout">{formatLeg(summary.deviceToHost, summary.offsetSamples)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">host→browser</dt>
        <dd className="readout">{formatLeg(summary.hostToBrowser, summary.offsetSamples)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">decode</dt>
        <dd className="readout">{formatAbsoluteLeg(summary.decode)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">decode→paint</dt>
        <dd className="readout">{formatAbsoluteLeg(summary.decodeToPaint)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">queue</dt>
        <dd className="readout">{formatAbsoluteLeg(summary.queue, '')}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">fps</dt>
        <dd className="readout">{summary.fps.toFixed(1)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">dropped</dt>
        <dd className="readout">{summary.dropped}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="rack-label">keyframe requests</dt>
        <dd className="readout">{summary.keyframeRequests}</dd>
      </div>
      <div className="mt-1 text-[10px] text-fg-subtle">
        device→host and host→browser are relative to the fastest frame seen, not absolute. Glass-to-glass needs a
        camera.
      </div>
    </dl>
  )
}
