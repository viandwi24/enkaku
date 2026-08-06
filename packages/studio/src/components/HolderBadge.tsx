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
 */
export function HolderBadge({ holder, className }: { holder: LeaseHolder; className?: string }) {
  const base = `inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${className ?? ''}`

  if (holder.kind === 'agent') {
    return (
      <Link
        href={`/agents/detail?id=${encodeURIComponent(holder.id)}`}
        className={`${base} border-accent/40 bg-accent/10 text-accent-strong hover:bg-accent/20`}
        title={`Driven by ${holder.label} — open the agent`}
      >
        <AgentAvatar name={holder.label} size="sm" />
        <span className="truncate">{holder.label}</span>
      </Link>
    )
  }

  if (holder.kind === 'job') {
    return (
      <Link
        href={`/jobs/detail?id=${encodeURIComponent(holder.id)}`}
        className={`${base} border-led-active/35 bg-led-active/10 text-fg hover:bg-led-active/20`}
        title={`Running ${holder.label} — open the job`}
      >
        <Briefcase className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{holder.label}</span>
      </Link>
    )
  }

  return (
    <span
      className={`${base} border-line bg-surface-2 text-fg-muted`}
      title={`Controlled by ${holder.label}`}
    >
      <Hand className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{holder.label}</span>
    </span>
  )
}
