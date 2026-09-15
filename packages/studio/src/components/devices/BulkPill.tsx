'use client'

import { useState } from 'react'
import type { DeviceInfo, Target } from '@enkaku/protocol'
import { CaretDownIcon, XIcon, cn } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'
import { useDeviceControl } from '@/components/device-control/DeviceControlHost'
import { DeviceActionMenu } from '@/components/device-actions/DeviceActionList'
import type { DeviceActionContext } from '@/lib/device-actions'

/**
 * The floating pair (design handoff, "Bulk actions (floating, bottom-right of
 * the panel)"; plan 214 §4.12) — click-to-open, never always-expanded.
 *
 * Its list is `DeviceActionMenu`, the same list the right-click menu and
 * Device Control's Actions tab draw (`lib/device-actions.ts`), acting on
 * every visible selected device.
 */
export function BulkPill({
  count,
  hiddenCount = 0,
  target,
  devices,
  onLabelsChanged,
  onClear,
}: {
  /** Selected AND visible under the current tab, filters and search — exactly what `target` holds. */
  count: number
  /** Selected but filtered out of view. Never acted on; shown so the operator knows they are still held. */
  hiddenCount?: number
  target: Target
  /** The selected devices as live rows — `LabelAssign` shows a per-label answer across them, not a boolean. */
  devices: DeviceInfo[]
  /** A label was created or a count moved, so the caller's own list is stale. */
  onLabelsChanged: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  useOverlay('menu', open, () => setOpen(false))
  const deviceControl = useDeviceControl()

  const deviceIds = 'deviceIds' in target ? target.deviceIds : []
  const ctx: DeviceActionContext = {
    deviceIds,
    // A selection has no device under a cursor; Device Control opens on the
    // first one and mirrors the rest.
    subjectId: deviceIds[0] ?? null,
    surface: 'bulk',
    openControl: (hostId, mirror) => deviceControl.open(hostId, mirror),
  }

  const handleDone = (id: string) => {
    setOpen(false)
    if (id === 'forget') onClear()
  }

  return (
    <div className="absolute right-[14px] bottom-[14px] z-30 flex items-center gap-2" data-menu-root="1">
      {open && (
        <div className="absolute right-0 bottom-[52px] w-[226px] rounded-card bg-panel p-1 shadow-menu">
          <div className="flex items-center justify-between px-[10px] py-1.5">
            <span className="text-meta text-faint">{count === 1 ? 'Actions for 1 device' : `Actions for ${count} devices`}</span>
            <button type="button" className="text-meta text-accent" onClick={onClear}>
              Clear
            </button>
          </div>
          {hiddenCount > 0 && (
            <p className="px-[10px] pb-1.5 text-meta text-faint">
              {hiddenCount} more selected {hiddenCount === 1 ? 'device is' : 'devices are'} hidden by the current tab, filter or search, and nothing here acts on {hiddenCount === 1 ? 'it' : 'them'}.
            </p>
          )}
          {count > 0 && <DeviceActionMenu ctx={ctx} devices={devices} onLabelsChanged={onLabelsChanged} onDone={handleDone} />}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-2 rounded-pill bg-accent px-4 text-body font-medium text-on-accent shadow-bulk-pill"
      >
        {count} selected
        {hiddenCount > 0 && <span className="font-normal">({hiddenCount} hidden)</span>}
        <CaretDownIcon className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="flex size-10 items-center justify-center rounded-pill border border-border-2 bg-panel text-faint transition-colors hover:border-danger hover:text-danger"
      >
        <XIcon className="size-4" aria-hidden />
      </button>
    </div>
  )
}
