'use client'

import { Badge, cn } from '@enkaku/ui'
import type { PluginStatus } from '@enkaku/protocol'

/**
 * The six-state pill (plan 219 §3.3.2). The handoff draws two — `active` and
 * `staged` — with a dot-plus-Badge shape; the other four extend the same
 * two-tone system rather than inventing a third: `verifying` reuses the
 * `staged` tone with a pulsing dot (mid-transaction, not yet resolved);
 * `failed` is danger-soft/danger with a danger dot; `superseded` is the
 * version-chip tone (the `outline` Badge variant) with a faint-2 dot — a fact
 * about history, not a warning; `disabled` is faint-2 text with no fill and
 * no dot (the `ghost` Badge variant), because it is inert rather than
 * in-progress. `PluginRowView` (`app/plugins/page.tsx`) is the only caller.
 */
const TONE: Record<PluginStatus, { badge: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost'; dot: string; pulse?: boolean; label: string }> = {
  active: { badge: 'default', dot: 'bg-ok', label: 'active' },
  staged: { badge: 'secondary', dot: 'bg-faint-2', label: 'staged' },
  verifying: { badge: 'secondary', dot: 'bg-faint-2', pulse: true, label: 'verifying' },
  superseded: { badge: 'outline', dot: 'bg-faint-2', label: 'superseded' },
  failed: { badge: 'destructive', dot: 'bg-danger', label: 'failed' },
  disabled: { badge: 'ghost', dot: '', label: 'disabled' },
}

export function PluginStatusPill({ status }: { status: PluginStatus }) {
  const t = TONE[status]
  return (
    <Badge variant={t.badge} className="gap-1.5">
      {t.dot && <span aria-hidden className={cn('size-[6px] rounded-pill', t.dot, t.pulse && 'animate-enkaku-pulse')} />}
      {t.label}
    </Badge>
  )
}
