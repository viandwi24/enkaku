import Link from 'next/link'
import { Briefcase, Hand } from 'lucide-react'
import type { LeaseHolder } from '@enkaku/protocol'
import { AgentAvatar } from '@/components/agent/AgentAvatar'
import { ASSIST_ACTIVITY_TICK_MS, DEFAULT_ASSIST_GRANT_TTL_SEC, deriveAssistActivity } from '@/components/device-popup/ControlState'
import { useNow } from '@/lib/useNow'

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
 * colours below.
 *
 * **Plan 105 §3.2 (the badge split)**: this variant used to word EVERY grant
 * as "Assisting", regardless of whether the grantee had touched the device
 * in the last five minutes or the last five seconds — an authorization
 * (`assistedBy`'s TTL, `coControl.grantTtlSec`) rendered as an activity. It
 * now reads `deriveAssistActivity` (`./device-popup/ControlState.tsx`, the
 * one place this split is computed, so no caller of this component invents
 * its own definition of "assisting" — plan 105 §4) and words the badge
 * accordingly: **"Assisting"** while the grant was touched within the last
 * `ASSIST_ACTIVITY_WINDOW_SEC` — present tense, because it is — or
 * **"May assist"**, quieter, while the grant is merely held, idle. Ticks its
 * own short-lived clock (`useNow(ASSIST_ACTIVITY_TICK_MS)`, only inside
 * `AssistHolderBadge` below, so a "holds" badge — the overwhelmingly common
 * case on any list of devices — never pays for a timer it has no use for.
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
  grantTtlSec = DEFAULT_ASSIST_GRANT_TTL_SEC,
}: {
  holder: LeaseHolder
  className?: string
  variant?: 'holds' | 'assists'
  asLink?: boolean
  /**
   * `coControl.grantTtlSec`, the farm's real assist-idle-timeout setting —
   * only meaningful for `variant: 'assists'`. Callers that already fetch
   * `/api/settings` for another reason (`DevicePopup`, the legacy device
   * page's `DeviceHeader`) pass the real value; ones that do not
   * (`WallTile`, `DeviceCard`, `DevicePicker` — none of them fetch farm
   * settings today, and adding that fetch to every list row for this alone
   * was judged not worth it) fall back to the shipped default, which is
   * correct unless the farm changed the setting.
   */
  grantTtlSec?: number
}) {
  if (variant === 'assists') return <AssistHolderBadge holder={holder} className={className} asLink={asLink} grantTtlSec={grantTtlSec} />
  return <HolderBadgeBody holder={holder} className={className} asLink={asLink} activity={null} />
}

/**
 * The only part of this file that ticks a clock — and only while actually
 * rendering an assist grant, which by the shipped default
 * (`coControl.maxConcurrentPerDevice: 1`) is at most one badge farm-wide at
 * any moment, not one per device row.
 */
function AssistHolderBadge({
  holder,
  className,
  asLink,
  grantTtlSec,
}: {
  holder: LeaseHolder
  className?: string
  asLink: boolean
  grantTtlSec: number
}) {
  const now = useNow(ASSIST_ACTIVITY_TICK_MS)
  const activity = deriveAssistActivity(holder, grantTtlSec, now)
  return <HolderBadgeBody holder={holder} className={className} asLink={asLink} activity={activity} />
}

function HolderBadgeBody({
  holder,
  className,
  asLink,
  activity,
}: {
  holder: LeaseHolder
  className?: string
  asLink: boolean
  /** `null` for the plain "holds" variant; the derived activity for "assists". */
  activity: 'assisting' | 'may-assist' | null
}) {
  const base = `inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${className ?? ''}`
  const assists = activity !== null
  const assistClasses = 'border-led-warn/35 bg-led-warn/10 text-led-warn hover:bg-led-warn/20'
  // "Assisting" (present tense, active) vs "May assist" (quieter, idle) —
  // plan 105 §3.2. Applied uniformly across all three holder kinds below: a
  // real assist grant is always `kind: 'user'` (`co-control.ts`'s own
  // `assistedBy()` — "no reverse, agent-assists-human facility exists"), so
  // the job/agent branches only exercise this for a defensive/generic
  // caller, and there is no reason for their wording to disagree with the
  // user branch's.
  const assistVerb = activity === 'assisting' ? 'Assisting' : 'May assist'

  if (holder.kind === 'agent') {
    const cls = `${base} ${assists ? assistClasses : 'border-accent/40 bg-accent/10 text-accent-strong hover:bg-accent/20'}`
    const label = assists ? `${assistVerb} — ${holder.label}` : `Driven by ${holder.label}`
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
    const label = assists ? `${assistVerb} — ${holder.label}` : `Running ${holder.label}`
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
      title={assists ? `${assistVerb} — ${holder.label}` : `Controlled by ${holder.label}`}
    >
      <Hand className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{holder.label}</span>
    </span>
  )
}
