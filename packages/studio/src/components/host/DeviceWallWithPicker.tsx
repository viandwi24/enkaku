'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@enkaku/ui'
import { Wall } from '@/components/wall/Wall'
import { fetchDevices } from '@/lib/api'

/**
 * `DeviceWallWithPicker` (plan 129 §3.5, §4.5, step 129.6) — the picker the
 * owner actually asked for, verbatim: *"saya minta device selector nya pas
 * add device ada popup untuk device list kaya walls gitu, jadi user bisa
 * pilih mau add device sambil lihat screen castnya"* — a wall of LIVE tiles,
 * chosen by looking at the screen, not the list-style `DevicePicker` (which
 * stays, unchanged, for a dialog choosing by name — plan §2 non-goals).
 *
 * Built entirely on the existing `Wall`/`WallTile` (plan §3.5's whole
 * point): this file owns none of the live-tile budget, the sleeping/
 * offline/quarantined placeholders, or the number/name/stableId identity —
 * `Wall` already has all of that, and reusing it means a wall of 20 tiles in
 * this dialog obeys the identical `wall.maxTiles` cap as 20 tiles on the
 * Devices page (plan §8 R3). This component's own job is exactly three
 * things `Wall` does not do: fetch `/api/devices` itself (so a plugin
 * passes no device list at all), apply an optional caller filter, and hold
 * the selection across a Confirm/Cancel pair.
 */
export interface DeviceWallPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Ids already in the group — shown selected and returned unchanged unless deselected. */
  value: string[]
  onConfirm: (ids: string[]) => void
  /** Optional filter, e.g. the plugin's own "not already assigned" rule. */
  filter?: (device: DeviceInfo) => boolean
  title?: string
}

export function DeviceWallWithPicker({ open, onOpenChange, value, onConfirm, filter, title = 'Choose devices' }: DeviceWallPickerProps) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [selected, setSelected] = useState<string[]>(value)

  // The dialog's own state stays mounted while closed (the same convention
  // `ScanNetworkDialog`/`GroupEditorDialog` already follow), so both the
  // device fetch and the starting selection are refreshed explicitly on
  // each open rather than relying on a fresh mount. Deliberately keyed on
  // `open` alone: re-syncing `selected` from `value` on every render while
  // the dialog is already open would fight the operator's own clicks.
  useEffect(() => {
    if (!open) return
    setSelected(value)
    let cancelled = false
    void fetchDevices()
      .then((list) => {
        if (!cancelled) setDevices(list)
      })
      .catch(() => {
        if (!cancelled) setDevices([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // `null` propagates through unchanged so `Wall` renders its own loading
  // skeleton (Plan 92 §4.7) while the fetch above is still in flight —
  // filtering `null` would turn "still loading" into "loaded, zero
  // devices" and show the empty state instead.
  const filtered = useMemo(() => (devices === null ? null : filter ? devices.filter(filter) : devices), [devices, filter])

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Pick devices by looking at their live screen, not just their name.</DialogDescription>
        </DialogHeader>
        {/* `min-w-0`: this div is a direct child of `DialogContent`'s own CSS
            Grid, and without it a grid item's default auto minimum width
            lets the tile grid's intrinsic width push the dialog itself past
            `max-w-5xl` instead of scrolling inside this container (the same
            fix `ScanNetworkDialog` already documents for its own wide
            table). Vertical only — `TileGrid` wraps within its own width,
            so there is nothing here that ever needs to scroll sideways. */}
        <div className="min-w-0 max-h-[65vh] overflow-y-auto">
          <Wall devices={filtered} jobs={[]} selectedIds={selected} onToggleSelect={toggle} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* The count in the label IS the set `onConfirm` submits — never a
              number that could disagree with what actually gets added
              (`docs/design.md`'s "no dialog can show a number that
              disagrees with what it will actually submit"). */}
          <Button
            onClick={() => {
              onConfirm(selected)
              onOpenChange(false)
            }}
          >
            Add {selected.length} device{selected.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
