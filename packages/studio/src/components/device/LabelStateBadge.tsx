import type { DeviceLabelState } from '@enkaku/protocol'
import { cn } from '@/lib/utils'

/**
 * The one place `DeviceLabelState.state` turns into a colour and a word
 * (plan 89 §3.5, §5 step 89.8) — `DeviceHeader` and `PhysicalLabellingPanel`
 * both use this instead of styling their own, the same discipline
 * `StatusBadge.tsx`'s own doc comment states for device/job status.
 *
 * This is the one surface plan 89 §3.5 exists to protect: tier 1 (the
 * wallpaper) and tier 0 (lock-screen text) can produce genuinely different
 * results, and an operator who cannot tell "labelled the way tier 1 labels
 * it" apart from "labelled tier 0 only, because tier 1 was unavailable" has
 * been misled. So the five non-`off` states each get their OWN word — never
 * collapsed into a single green "Labelled" tick — and `partial`/`unavailable`
 * never render in the tone `applied` uses. `off` and `unknown` render
 * nothing: `off` is not a failure (labelling was never asked for), and
 * `unknown` means "never asked" (offline, or before the first reconcile) —
 * neither is a claim this component can honestly make one way or the other.
 */
const TONE: Record<'applied' | 'stale' | 'partial' | 'unavailable', string> = {
  applied: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  stale: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  // Never the `applied` tone: only SOME of what was asked for actually
  // showed up on the phone (plan 89 §0.2 H5 — an OEM skin refusing one
  // surface). Sharing `stale`'s amber, not `applied`'s green, is the point.
  partial: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  unavailable: 'text-led-danger border-led-danger/40 bg-led-danger/10',
}

const WORD: Record<'applied' | 'stale' | 'partial' | 'unavailable', string> = {
  applied: 'Labelled',
  stale: 'Stale',
  partial: 'Partial',
  unavailable: 'Unavailable',
}

export function LabelStateBadge({
  state,
  className,
}: {
  /** `null` before the first status fetch resolves — renders nothing, same as `unknown`. */
  state: Pick<DeviceLabelState, 'mode' | 'state' | 'reason'> | null
  className?: string
}) {
  if (!state || state.mode === 'off' || state.state === 'off' || state.state === 'unknown') return null
  const kind = state.state
  if (kind !== 'applied' && kind !== 'stale' && kind !== 'partial' && kind !== 'unavailable') return null

  // "Partial — lock screen refused" / "Unavailable — no guest agent" (the
  // step's own checklist wording): the reason rides the SAME badge rather
  // than a separate tooltip, since it is exactly the fact an operator who
  // sees anything other than green needs first, not on hover.
  const label = state.reason ? `${WORD[kind]} — ${state.reason}` : WORD[kind]

  return (
    <span
      className={cn(
        'inline-flex max-w-sm items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
        TONE[kind],
        className,
      )}
      title={label}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  )
}
