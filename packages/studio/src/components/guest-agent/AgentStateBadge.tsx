import type { GuestAgentState } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The one place a guest-agent state turns into a colour and a word — the
 * same pattern `DeviceStatusBadge` uses (`components/StatusBadge.tsx`), kept
 * as its own component here because the state enum belongs to a different
 * subject (the on-device agent, not the device itself).
 *
 * `installed` gets its own warning tone, distinct from `ready`'s ok tone —
 * this is a requirement, not a preference (plan 44 §4.6): a package being
 * present on the device says nothing about whether its control socket
 * actually answers, and collapsing the two would report a broken device as
 * healthy.
 */
const LABEL: Record<GuestAgentState, string> = {
  'not-installed': 'not installed',
  installed: 'installed, not verified',
  ready: 'ready',
  unreachable: 'unreachable',
  unsupported: 'unsupported',
}

const TONE: Record<GuestAgentState, string> = {
  'not-installed': 'text-fg-subtle border-line bg-transparent',
  installed: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  ready: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  unreachable: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  unsupported: 'text-fg-subtle border-line bg-transparent',
}

const base =
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap'

export function AgentStateBadge({ state, className }: { state: GuestAgentState; className?: string }) {
  return (
    <span className={cn(base, TONE[state], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {LABEL[state]}
    </span>
  )
}
