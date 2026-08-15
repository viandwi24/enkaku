import type { ReadoutRow } from './video-quality'

/**
 * The effective-profile readout (plan 92 §3.9, §5 step 92.8) — both
 * profiles, the resolved numbers, and where each came from. Purely
 * presentational: every caller (the farm Settings page, the device page)
 * computes its own rows through `profileRows` in `video-quality.ts` and
 * hands them here, so this component never itself decides what "source"
 * means for the two different contexts (this step's own brief, §9 item 1 —
 * render the resolver's output, do not recompute it).
 */
export function VideoQualityReadout({ controlRows, wallRows }: { controlRows: ReadoutRow[]; wallRows: ReadoutRow[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ReadoutCard title="Device page (control)" rows={controlRows} />
      <ReadoutCard title="Wall tile" rows={wallRows} />
    </div>
  )
}

function ReadoutCard({ title, rows }: { title: string; rows: ReadoutRow[] }) {
  return (
    <div className="rounded-lg border bg-surface p-3">
      <h4 className="rack-label mb-2">{title}</h4>
      <dl className="space-y-1.5 text-[12.5px]">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-fg-muted">{r.label}</dt>
            <dd className="flex items-baseline gap-1.5">
              <span className="readout font-medium text-fg">{r.value}</span>
              <span className="text-[11px] text-fg-subtle">{r.sourceLabel}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
