import type { LabelColor } from '@enkaku/protocol'
import { cn } from '../lib/utils'

/**
 * The ONE place a label's colour name becomes classes (plan 225 §3.2).
 *
 * Written out in full rather than composed as `bg-label-${color}-bg`: a
 * Tailwind v4 class assembled from a template literal is invisible to the
 * compiler and emits nothing, silently — the same failure mode the v3
 * bracket colour form has in v4 (`docs/design.md`, and CLAUDE.md's own rule
 * that a colour utility is written as a plain name). A chip that renders
 * with no colour is exactly the bug that would ship unnoticed, because every
 * OTHER part of the chip still looks right.
 */
const CHIP_COLORS: Record<LabelColor, string> = {
  slate: 'bg-label-slate-bg text-label-slate-fg',
  blue: 'bg-label-blue-bg text-label-blue-fg',
  green: 'bg-label-green-bg text-label-green-fg',
  amber: 'bg-label-amber-bg text-label-amber-fg',
  red: 'bg-label-red-bg text-label-red-fg',
  purple: 'bg-label-purple-bg text-label-purple-fg',
  pink: 'bg-label-pink-bg text-label-pink-fg',
  teal: 'bg-label-teal-bg text-label-teal-fg',
}

/** The swatch a colour picker draws — the chip's background, on its own. */
export const LABEL_SWATCH: Record<LabelColor, string> = {
  slate: 'bg-label-slate-fg',
  blue: 'bg-label-blue-fg',
  green: 'bg-label-green-fg',
  amber: 'bg-label-amber-fg',
  red: 'bg-label-red-fg',
  purple: 'bg-label-purple-fg',
  pink: 'bg-label-pink-fg',
  teal: 'bg-label-teal-fg',
}

/**
 * One label, rendered as a chip. Used by the device table, the Screens
 * cards, the device picker, the label editor and the label manager — so a
 * label looks the same everywhere it appears, which is what makes it
 * scannable down a column of fifty rows.
 */
export function LabelChip({
  name,
  color,
  className,
  onRemove,
  title,
}: {
  name: string
  color: LabelColor
  className?: string
  /** Renders a × that calls this. Omitted, the chip is not removable — which is what every read-only surface wants. */
  onRemove?: () => void
  title?: string
}) {
  return (
    <span
      title={title ?? name}
      className={cn(
        'inline-flex max-w-[160px] flex-none items-center gap-1 rounded-chip px-1.5 py-0.5 text-badge leading-[15px] font-medium',
        CHIP_COLORS[color],
        className,
      )}
    >
      <span className="truncate">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${name}`}
          className="-mr-0.5 flex size-3 flex-none items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
        >
          <svg viewBox="0 0 8 8" className="size-2" aria-hidden>
            <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      )}
    </span>
  )
}
