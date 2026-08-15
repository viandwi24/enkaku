import Link from 'next/link'
import { Briefcase, Hand } from 'lucide-react'
import type { LeaseHolder } from '@enkaku/protocol'
import { AgentAvatar } from '@/components/agent/AgentAvatar'

/**
 * "A device says who holds it" (plan 71 §3.2, §4.5) — one component, three
 * kinds, replacing `AgentHolderBadge` (which only ever knew about agents,
 * because `DeviceInfo` had no holder field at all before this plan) and the
 * client-side polling that used to compose it (`lib/agent-holders.ts`,
 * deleted). Used by `DeviceHeader`, `DeviceCard`, `WallTile`, and the device
 * picker — the same server-published `DeviceInfo.heldBy` / `lease.changed`
 * fact, rendered identically everywhere it appears.
 *
 * `variant: 'assists'` (plan 91 §3.4 item 4, §4.4) renders the SAME shape for
 * `DeviceInfo.assistedBy` — never a takeover candidate (`holder.takeable` is
 * always `false` for an assist grant, plan 91 §3.2), so it is painted in
 * `--color-led-warn` (amber), the one colour `docs/design.md` reserves for a
 * live, self-expiring condition — the same colour `ScreenCard`'s own
 * assisting chrome uses (§3.4 item 2) — instead of the neutral "holds"
 * colours below, and its title names the action correctly ("Assisting", not
 * "Controlled by" — an assist never controls anything).
 *
 * `asLink: false` (plan 91 §3.4 item 4 gap 3) renders a `job`/`agent` holder
 * as a plain, non-interactive `<span>` instead of its own `<Link>` — for a
 * caller whose own root element is ALREADY a `next/link` (`WallTile`'s tile
 * is the whole card). The HTML spec forbids an `<a>` from containing another
 * interactive descendant (a nested `<a>`, and a `<button>` is no better) —
 * nesting this badge's own `Link` inside `WallTile`'s `Link` produced invalid
 * HTML and a React hydration warning, undetected until 91.6's own tests were
 * the first to render a `job`/`agent` holder on the Wall. Defaults to `true`:
 * every OTHER caller (`DeviceCard`, `DeviceHeader`, `DevicePicker`) has no
 * enclosing link of its own, so the badge keeps navigating straight to the
 * job/agent detail page there, unaffected.
 */
export function HolderBadge({
  holder,
  className,
  variant = 'holds',
  asLink = true,
}: {
  holder: LeaseHolder
  className?: string
  variant?: 'holds' | 'assists'
  asLink?: boolean
}) {
  const base = `inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${className ?? ''}`
  const assists = variant === 'assists'
  const assistClasses = 'border-led-warn/35 bg-led-warn/10 text-led-warn hover:bg-led-warn/20'

  if (holder.kind === 'agent') {
    const cls = `${base} ${assists ? assistClasses : 'border-accent/40 bg-accent/10 text-accent-strong hover:bg-accent/20'}`
    const label = assists ? `Assisted by ${holder.label}` : `Driven by ${holder.label}`
    const inner = (
      <>
        <AgentAvatar name={holder.label} size="sm" />
        <span className="truncate">{holder.label}</span>
      </>
    )
    if (!asLink) {
      return (
        <span className={cls} title={label}>
          {inner}
        </span>
      )
    }
    return (
      <Link href={`/agents/detail?id=${encodeURIComponent(holder.id)}`} className={cls} title={`${label} — open the agent`}>
        {inner}
      </Link>
    )
  }

  if (holder.kind === 'job') {
    const cls = `${base} ${assists ? assistClasses : 'border-led-active/35 bg-led-active/10 text-fg hover:bg-led-active/20'}`
    const label = assists ? `Assisted by ${holder.label}` : `Running ${holder.label}`
    const inner = (
      <>
        <Briefcase className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{holder.label}</span>
      </>
    )
    if (!asLink) {
      return (
        <span className={cls} title={label}>
          {inner}
        </span>
      )
    }
    return (
      <Link href={`/jobs/detail?id=${encodeURIComponent(holder.id)}`} className={cls} title={`${label} — open the job`}>
        {inner}
      </Link>
    )
  }

  return (
    <span
      className={`${base} ${assists ? assistClasses : 'border-line bg-surface-2 text-fg-muted'}`}
      title={assists ? `Assisting — ${holder.label}` : `Controlled by ${holder.label}`}
    >
      <Hand className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{holder.label}</span>
    </span>
  )
}
