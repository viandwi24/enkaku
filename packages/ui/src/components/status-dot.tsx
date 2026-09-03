import { cn } from "../lib/utils"

/**
 * A device's status, as a coloured dot (plan 204 §4.6). New: `@enkaku/ui`
 * had no status dot before this plan (G9) — the table's 8px dot, the card's
 * 9px ringed dot, and the status bar's 7px pulsing dot are all this one
 * component with different props.
 */
export type StatusDotState = "free" | "controlled" | "job" | "offline" | "unauthorized"

const STATE_CLASS: Record<StatusDotState, string> = {
  free: "bg-ok",
  controlled: "bg-warn-2",
  job: "bg-danger",
  // The handoff says "disconnected"; `offline` is plan 200 §2.4's word for
  // the stored state.
  offline: "bg-faint-2",
  unauthorized: "bg-warn",
}

function StatusDot({
  state,
  ring,
  pulse,
  className,
  title,
}: {
  state: StatusDotState
  /** The card's 9px dot with a 3px `panel-a` ring, vs. the table's plain 8px dot. */
  ring?: boolean
  /** The status bar's "System OK" dot; pass `className="size-[7px]"` for its size. */
  pulse?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      data-slot="status-dot"
      data-state={state}
      role="img"
      aria-label={title ?? state}
      title={title}
      className={cn(
        "inline-block shrink-0 rounded-pill",
        ring ? "size-[9px] shadow-dot-ring" : "size-2",
        pulse && "animate-enkaku-pulse",
        STATE_CLASS[state],
        className
      )}
    />
  )
}

export { StatusDot }
