'use client'

import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@enkaku/ui'
import { DevicePicker } from '@/components/target/DevicePicker'
import { useTarget } from '@/components/target/useTarget'
import { fetchDevices } from '@/lib/api'

/**
 * `DevicePickerDialog` (plan 216 §4.10), replacing `DeviceWallWithPicker`
 * (plan 129 §3.5) — the same `DevicePicker` MVP 07 §2.1 gives every action
 * dialog, offered to a plugin through `@enkaku/host` (§3.7). One component,
 * one hook, one place: the Screens view is where a device is chosen by
 * looking at its screen; this dialog is where one is chosen by name.
 */
export interface DevicePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Ids already chosen, shown selected and returned unchanged unless deselected. */
  value: string[]
  onConfirm: (ids: string[]) => void
  /** Optional filter, e.g. the plugin's own "not already assigned" rule. */
  filter?: (device: DeviceInfo) => boolean
  title?: string
}

export function DevicePickerDialog({ open, onOpenChange, value, onConfirm, filter, title = 'Choose devices' }: DevicePickerDialogProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchDevices()
      .then((rows) => {
        if (!cancelled) setDevices(filter ? rows.filter(filter) : rows)
      })
      .catch(() => {
        if (!cancelled) setDevices([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const target = useTarget({ devices, groups: [], initial: { deviceIds: value } })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="px-[14px] pt-[14px] pb-[10px]">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DevicePicker state={target} forceExpanded className="border-b-0" />
        <DialogFooter className="border-t border-line px-[14px] py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm(target.resolvedIds)
              onOpenChange(false)
            }}
          >
            Add {target.resolvedIds.length} device{target.resolvedIds.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
