'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Boxes, ChevronDown, ChevronUp, Download, FileTerminal, ListChecks, Upload, Wrench, type LucideIcon } from 'lucide-react'
import { OutcomeSummary } from '@/components/bulk/OutcomeSummary'
import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn, duration } from '@enkaku/ui'
import { useOperations, type Operation, type OperationKind } from '@/lib/operations'
import { useNow } from '@/lib/useNow'
import { TransferProgressBar } from './TransferProgressBar'

/**
 * Plan 107 (M72) §1–§4, step 107.3/107.4 — the floating, farm-wide tray the
 * owner asked for: *"ada component atau ui khusus yang floating di devices
 * atau global app, jadi pas modal popup install apk di close progressnya
 * masih bisa dilihat gitu."* One vocabulary for every long operation
 * (§1.3), reading `useOperations()` (`lib/operations.ts`), which itself
 * reads `GET /api/transfers|jobs|batches|command-runs` on mount and then
 * follows WS events (§3.1, §3.3) rather than each operation kind growing
 * its own bespoke indicator.
 *
 * **§9 Q3 (recorded, not settled by this pass — the owner's own open
 * question): mounted at the SHELL, not (also) inside the device popup.**
 * `AppShell.tsx` renders this once, so it is visible from every screen,
 * including while looking at a device OTHER than the one an operation
 * targets — the "floating di devices" reading of the owner's ask is left
 * to whichever later pass answers Q3 permanently; a per-popup rendering
 * would need to filter this SAME `useOperations()` state down to the
 * popup's own device (cheap, since the shared store already carries every
 * device's operations) and was left out here to keep this pass to one
 * surface, per Q3's own framing in the plan as a proposal, not a ruling.
 *
 * A per-tile/per-device count is deliberately NOT added to `DeviceCard`/
 * `WallTile` in this pass either, for the identical reason.
 *
 * §3.2's rule — durable and ephemeral must not render identically — is why
 * every row carries `EphemeralBadge` only for `kind: 'transfer'`, tooltipped
 * with the restart caveat 107.2 recorded in the registry's own doc comment,
 * rather than a bare, unexplained tag (`docs/design.md`'s quality floor: a
 * control or a badge that is not self-explanatory needs a tooltip).
 *
 * No `backdrop-filter` here (`docs/design.md`'s "nothing that scales with
 * device count" rule) — this is one fixed element regardless of fleet size,
 * so it would have been PERMITTED, but a solid `bg-surface` reads more
 * legibly over the Wall's own moving video tiles and costs strictly less.
 */
export function OperationTray() {
  const { operations, deviceLabel, loading } = useOperations()
  const [collapsed, setCollapsed] = useState(false)
  const now = useNow(1000)

  if (loading && operations.length === 0) return null
  if (operations.length === 0) return null

  return (
    // A LOCAL provider, same reasoning `AppShell.tsx`'s own top-level one
    // gives: nesting inside the app-wide provider is harmless (radix
    // resolves to the nearest ancestor), and it means this component still
    // renders correctly on its own in a test that does not supply one.
    <TooltipProvider delayDuration={200}>
    <div
      className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
      data-testid="operation-tray"
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left hover:bg-surface-2/60"
      >
        <span className="flex-1 text-[12.5px] font-medium">Operations</span>
        <Badge variant="outline" className="readout">
          {operations.length}
        </Badge>
        {collapsed ? <ChevronUp className="size-3.5 shrink-0" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0" aria-hidden />}
      </button>
      {!collapsed && (
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
          {operations.map((op) => (
            <OperationRow key={op.key} op={op} deviceLabel={deviceLabel} now={now} />
          ))}
        </ul>
      )}
    </div>
    </TooltipProvider>
  )
}

const KIND_ICON: Record<OperationKind, LucideIcon> = {
  transfer: Download,
  job: ListChecks,
  batch: Boxes,
  'command-run': FileTerminal,
  preparation: Wrench,
}

function OperationRow({ op, deviceLabel, now }: { op: Operation; deviceLabel: (id: string) => string; now: number }) {
  const Icon = op.kind === 'transfer' && op.transfer?.kind === 'push' ? Upload : KIND_ICON[op.kind]
  // Plan 124 §4.4, step 124.3 — `deviceLabel` comes from `useOperations()`
  // and already composes `#7 Galaxy A15` (see its doc comment in
  // `lib/operations.ts`), so nothing is re-composed here. It stays a joined
  // STRING rather than `<DeviceName>` because this line truncates to one row
  // and elides the tail as `+N`: a per-name element would break both.
  const names = op.deviceIds.map(deviceLabel)
  const namesText = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
  const content = (
    <div className="rounded-md border border-line px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium">{op.label}</span>
            {!op.durable && <EphemeralBadge />}
          </div>
          <p className="truncate text-[11px] text-fg-subtle">
            {namesText || 'no device'} · {op.status} · {duration(op.startedAt || null, op.finishedAt, now)}
          </p>
          <div className="mt-1.5">
            {op.transfer ? (
              <TransferProgressBar transfer={op.transfer} label={op.status === 'running' ? 'In progress' : op.status === 'success' ? 'Done' : 'Failed'} />
            ) : op.counts ? (
              <OutcomeSummary counts={op.counts} label={`${op.label} progress`} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
  return <li>{op.href ? <Link href={op.href}>{content}</Link> : content}</li>
}

function EphemeralBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn('text-[10px] font-normal text-fg-subtle')}>
          not saved
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        Tracked in this core process&apos;s memory only (plan 107 §3.4) — a core restart forgets this row, even if the transfer is still running on the
        device. Jobs, batches, and command runs above do not have this limit.
      </TooltipContent>
    </Tooltip>
  )
}
