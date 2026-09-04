'use client'

import { useState } from 'react'
import { Inbox, RefreshCw, X } from 'lucide-react'
import { z } from 'zod'
import { ReconcileReportSchema, type GroupInfo, type DeviceLabelMode, type ReconcileReport } from '@enkaku/protocol'
import { AdmitDeviceDialog } from '@/components/AdmitDeviceDialog'
import { EmptyState, Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, api, useAction, relativeTime } from '@enkaku/ui'
import type { DiscoveredDevice } from '@/lib/api'

/**
 * One line, matching the plan's own example verbatim: "Scanned 5 devices ·
 * adopted 1 · nothing else changed" (plan 85 §5 step 85.2, §4.6). Every
 * named category that actually changed is listed; "nothing else changed"
 * always closes the line, reading as "nothing changed" on its own when
 * nothing did.
 */
function summariseReconcileReport(report: ReconcileReport): string {
  const parts: string[] = []
  if (report.adopted.length > 0) parts.push(`adopted ${report.adopted.length}`)
  if (report.dropped.length > 0) parts.push(`dropped ${report.dropped.length}`)
  if (report.offline.length > 0) parts.push(`${report.offline.length} still offline${report.reconnectIssued ? ' — reconnect attempted' : ''}`)
  if (report.unauthorized.length > 0) parts.push(`${report.unauthorized.length} unauthorized`)
  const scanned = `Scanned ${report.seen} device${report.seen === 1 ? '' : 's'}`
  if (parts.length === 0) return `${scanned} · nothing changed`
  return `${scanned} · ${parts.join(' · ')} · nothing else changed`
}

/**
 * The Discovered tray (plan 56 §3.5, §4.5): phones adb has seen that nobody
 * has admitted to the farm yet. Not a third view competing with List/Wall —
 * the caller only renders the trigger that opens this sheet when there is
 * something in it, so an empty tray costs nothing visually.
 *
 * A row is a queue entry, not a live device view: it still shows here while
 * the phone is disconnected, and `lastSeen`/`firstSeen` are what tell the
 * operator how stale it is (plan 56 §3.4's "queue of decisions").
 *
 * **Rescan** (plan 85 §3.3, §4.6, §5 step 85.2) runs the discovery
 * reconciler's pass right now instead of waiting for the next automatic
 * one — the plan's own reasoning: "the first thing a human does when a
 * phone is missing is look for that button."
 */
export function DiscoveredTray({
  discovered,
  groups,
  farmLabellingMode,
  open,
  onOpenChange,
  onChanged,
}: {
  discovered: DiscoveredDevice[]
  groups: GroupInfo[]
  /** The farm's default `labelling.mode` (plan 89 §3.8, §5 step 89.8) — passed straight through to `AdmitDeviceDialog`'s own checkbox. */
  farmLabellingMode: DeviceLabelMode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called whenever a row leaves the tray (admitted or dismissed), so the caller can refetch. */
  onChanged: () => void
}) {
  const [target, setTarget] = useState<DiscoveredDevice | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [lastReport, setLastReport] = useState<ReconcileReport | null>(null)
  const { run, isPending } = useAction()

  // Dismiss straight from the row (plan 56 §6 risk table: "one click"), for
  // when there is nothing to decide beyond "not this one" — the wizard's own
  // Dismiss covers the case where the operator opened it first.
  const dismiss = (d: DiscoveredDevice) =>
    run(
      'dismiss-' + d.stableId,
      () => api(`/api/devices/discovered/${encodeURIComponent(d.stableId)}`, z.object({ ok: z.literal(true) }), { method: 'DELETE' }),
      {
        success: `${d.label ?? d.stableId} dismissed — it reappears here if it connects again`,
        failure: 'Could not dismiss the phone',
        onSuccess: onChanged,
      },
    )

  // Runs the discovery reconciler's pass right now (plan 85 §3.3, §4.6) —
  // may pull a newly-adopted device straight into the farm and out of this
  // tray, or add a brand-new one to it, so `onChanged` refetches either way.
  const rescan = () =>
    run('rescan', () => api('/api/devices/rescan', ReconcileReportSchema, { method: 'POST' }), {
      failure: 'Could not rescan for devices',
      onSuccess: (report) => {
        setLastReport(report)
        onChanged()
      },
    })

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex w-full flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Discovered</SheetTitle>
            <SheetDescription>
              Phones adb can see that are not part of the farm. Add one to make it schedulable, or dismiss it — a
              dismissed phone is not blocked, it just comes back here the next time it connects.
            </SheetDescription>
          </SheetHeader>

          <div className="flex items-center justify-between gap-2 border-b px-4 pb-3">
            <p className="min-w-0 truncate text-[11.5px] text-fg-subtle">
              {lastReport ? summariseReconcileReport(lastReport) : 'Missing a phone? Rescan checks adb directly, right now.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1.5 text-[12px]"
              disabled={isPending('rescan')}
              onClick={() => void rescan()}
            >
              <RefreshCw className={`size-3.5 ${isPending('rescan') ? 'animate-spin' : ''}`} aria-hidden />
              {isPending('rescan') ? 'Scanning…' : 'Rescan'}
            </Button>
          </div>

          <div className="flex-1 overflow-auto px-4 pb-4">
            {discovered.length === 0 ? (
              <EmptyState
                icon={<Inbox className="size-4" aria-hidden />}
                title="Nothing waiting"
                description="Every phone adb can see is either already in the farm or blocked."
              />
            ) : (
              <ul className="space-y-2">
                {discovered.map((d) => (
                  <li key={d.stableId} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{d.label ?? 'Unknown model'}</p>
                        <p className="readout mt-0.5 text-[11px] text-fg-subtle">{d.serial}</p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Dismiss ${d.label ?? d.stableId}`}
                        title="Dismiss — it reappears here if it connects again"
                        disabled={isPending('dismiss-' + d.stableId)}
                        onClick={() => void dismiss(d)}
                        className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg-muted disabled:opacity-50"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="text-[11.5px] text-fg-subtle">
                        {d.androidVersion ? `Android ${d.androidVersion} · ` : ''}waiting since {relativeTime(d.firstSeen)}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 text-[12px]"
                        onClick={() => {
                          setTarget(d)
                          setWizardOpen(true)
                        }}
                      >
                        Add to farm
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AdmitDeviceDialog
        entry={target}
        groups={groups}
        farmLabellingMode={farmLabellingMode}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onDone={onChanged}
      />
    </>
  )
}
