import { cn } from '../lib/utils'
import type { NamedDevice } from '../lib/device-name'

/**
 * A device's name, rendered as two spans: the number, quiet, and the label.
 *
 * Plan 124 §3.2 — there are two contexts and therefore two symbols.
 * `formatDeviceName()` produces a `string` for the places that can only take
 * one (a dialog title, a toast, an `aria-label`, a `.join(', ')`). This
 * component is for everywhere else — table cells, list rows, tiles, headers —
 * where the number should read as a quiet identifier *beside* the name rather
 * than as part of it. Keeping them in separate spans is what allows the
 * number to be dimmed, and it is also the visual grammar the four surfaces
 * that already got this right have used since plan 89: `DevicePicker.tsx:225`,
 * `DeviceCard.tsx:141`, `wall/WallTile.tsx:358`, `device/DeviceHeader.tsx:372`.
 *
 * Three details are deliberate:
 *
 * - **No number renders no span at all**, not an empty one and not a
 *   placeholder. `#null` is plan 124 criterion 7's named failure, and because
 *   the gap between the two spans comes from `gap-1.5` on the flex container
 *   rather than from padding on either child, a device with no number also
 *   costs no leading whitespace and causes no layout shift.
 * - **The number is NOT `aria-hidden`** (plan 124 §4.2, explicitly). The
 *   call site this component generalises marks it `aria-hidden="true"`,
 *   which was right when the row's own `aria-label` carried the identity and
 *   the number would have been read twice. Here it is the opposite: the number
 *   IS the identity — it is the only thing distinguishing three rows that a
 *   screen reader would otherwise announce as "SM-F721U1" three times.
 * - **The label truncates, the number does not.** A number is at most a few
 *   characters and is the part an operator scans for; a label is arbitrary
 *   vendor text. `min-w-0` on the wrapper is what actually lets the inner
 *   `truncate` engage inside a flex or grid parent.
 */
export function DeviceName({
  number,
  label,
  className,
  numberClassName,
}: NamedDevice & {
  /** Applied to the wrapper. The label's own type size and weight belong here. */
  className?: string
  /** Applied to the number span, on top of (and able to override) the defaults. */
  numberClassName?: string
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      {number != null && (
        <span className={cn('readout shrink-0 text-[11px] text-fg-subtle', numberClassName)}>#{number}</span>
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}
