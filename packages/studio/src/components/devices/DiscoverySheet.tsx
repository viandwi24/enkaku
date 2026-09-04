'use client'

import { useState } from 'react'
import type { DiscoveredDeviceInfo } from '@enkaku/protocol'
import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  XIcon,
  api,
  relativeTime,
  z,
} from '@enkaku/ui'

/**
 * The discovery sheet (design handoff, "Discovery sheet (right sheet)"; plan
 * 214 §4.13). The product rule in the operator's own words: a phone adb can
 * see is not on the farm until someone adds it.
 *
 * Three routes, G8: `GET /api/devices/discovered` seeds the `discovered` prop
 * (`useDevices.ts`, so both the pill and this sheet read one list), `POST
 * /api/devices/discovered/:stableId/admit` is `add`, `DELETE
 * /api/devices/discovered/:stableId` is `dismiss`.
 */
export function DiscoverySheet({
  open,
  onOpenChange,
  discovered,
  onMutated,
  spinning,
  onRescan,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  discovered: DiscoveredDeviceInfo[]
  onMutated: () => void
  spinning: boolean
  onRescan: () => void
}) {
  const [added, setAdded] = useState<Set<string>>(new Set())

  const add = async (d: DiscoveredDeviceInfo) => {
    await api(`/api/devices/discovered/${encodeURIComponent(d.stableId)}/admit`, z.unknown(), { method: 'POST', json: {} })
    setAdded((prev) => new Set(prev).add(d.stableId))
    onMutated()
  }

  const dismiss = async (d: DiscoveredDeviceInfo) => {
    await api(`/api/devices/discovered/${encodeURIComponent(d.stableId)}`, z.void(), { method: 'DELETE' })
    onMutated()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Discovered</SheetTitle>
          <SheetDescription>
            Phones adb can see that are not part of the farm. Add one to make it schedulable, or dismiss it — a
            dismissed phone is not blocked, it just comes back here the next time it connects.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center justify-between border-b border-line px-4 pb-3">
          <p className="text-meta text-faint">Missing a phone? Rescan checks adb directly, right now.</p>
          <Button variant="outline" size="sm" onClick={onRescan} disabled={spinning}>
            Rescan
          </Button>
        </div>

        <div className="flex flex-1 flex-col gap-2 overflow-auto px-4 pb-4">
          {discovered.length === 0 ? (
            <p className="py-8 text-center text-body text-faint">
              Nothing waiting — every phone adb can see is already on the farm.
            </p>
          ) : (
            discovered.map((d) => (
              <div key={d.stableId} className="relative rounded-card border border-border-2 px-[13px] pt-3 pb-[13px]">
                <p className="text-row font-semibold text-text">{d.label ?? d.stableId}</p>
                <p className="mt-0.5 font-mono text-meta text-dim">{d.serial}</p>
                <p className="mt-1 text-meta text-faint">
                  {d.androidVersion ? `Android ${d.androidVersion} · ` : ''}waiting since {relativeTime(d.firstSeen)}
                </p>
                <button
                  type="button"
                  onClick={() => void dismiss(d)}
                  aria-label="Dismiss"
                  className="absolute top-2 right-2 text-faint hover:text-text"
                >
                  <XIcon className="size-4" aria-hidden />
                </button>
                <div className="mt-2 flex justify-end">
                  {added.has(d.stableId) ? (
                    <span className="rounded-button bg-accent-soft px-[13px] py-2 text-body text-accent">Added</span>
                  ) : (
                    <Button variant="outline" size="default" onClick={() => void add(d)}>
                      Add to farm
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
