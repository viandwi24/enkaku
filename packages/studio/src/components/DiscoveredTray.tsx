'use client'

import { useState } from 'react'
import { Inbox, X } from 'lucide-react'
import { z } from 'zod'
import type { ClusterInfo } from '@enkaku/protocol'
import { AdmitDeviceDialog } from '@/components/AdmitDeviceDialog'
import { EmptyState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api, useAction } from '@/lib/actions'
import type { DiscoveredDevice } from '@/lib/api'
import { relativeTime } from '@/lib/format'

/**
 * The Discovered tray (plan 56 §3.5, §4.5): phones adb has seen that nobody
 * has admitted to the farm yet. Not a third view competing with List/Wall —
 * the caller only renders the trigger that opens this sheet when there is
 * something in it, so an empty tray costs nothing visually.
 *
 * A row is a queue entry, not a live device view: it still shows here while
 * the phone is disconnected, and `lastSeen`/`firstSeen` are what tell the
 * operator how stale it is (plan 56 §3.4's "queue of decisions").
 */
export function DiscoveredTray({
  discovered,
  clusters,
  open,
  onOpenChange,
  onChanged,
}: {
  discovered: DiscoveredDevice[]
  clusters: ClusterInfo[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called whenever a row leaves the tray (admitted or dismissed), so the caller can refetch. */
  onChanged: () => void
}) {
  const [target, setTarget] = useState<DiscoveredDevice | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
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
        clusters={clusters}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onDone={onChanged}
      />
    </>
  )
}
