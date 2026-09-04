'use client'

import type { DeviceInfo, DeviceStatus } from '@enkaku/protocol'
import { DevicePicker as BaseDevicePicker, type DevicePickerSlots } from '@enkaku/ui'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { ActivityBadge } from '@/components/ActivityBadge'

/**
 * Why a device cannot take a job right now (plan 19 §4.4; plan 205 §4.9 —
 * `DeviceStatus` shrank to `offline`/`online`/`quarantined`, so a device with
 * a live job is still `online` and still pickable — a job just queues behind
 * it (plan 71 §3.7) — and there is nothing left in this table for `online`
 * at all).
 */
export const UNAVAILABLE_REASON: Partial<Record<DeviceStatus, string>> = {
  offline: 'The device is not connected to this farm',
  quarantined: 'The device was pulled from the queue — return it from the Devices page first',
}

/**
 * Studio's device picker — the shared one from `@enkaku/ui`, plus the three
 * pieces of richness that are Studio's own.
 *
 * The component itself moved out on 2026-08-26 (see its doc comment there).
 * The reason is worth restating at this end: its rule has always been "every
 * place that chooses a device uses this component", and the MikroTik routing
 * plugin could not obey it, because a plugin UI may only import `@enkaku/ui`
 * and this file is not in `@enkaku/ui`. The plugin fell back to a
 * one-at-a-time `<Combobox>`, which is exactly the "bare `Select`" the rule
 * forbids. Moving the component and injecting the Studio-only parts is what
 * closes that gap without splitting the picker in two.
 *
 * What is injected, and why it could not simply travel with the component:
 * `ActivityBadge` reaches `next/link`, which does not belong in a
 * framework-agnostic UI package. `DeviceStatusBadge` and
 * `UNAVAILABLE_REASON` are cheaper, but they are Studio's vocabulary for
 * Studio's screens; a plugin has no use for them and should not inherit
 * them by accident.
 */
const SLOTS: DevicePickerSlots<DeviceInfo> = {
  renderStatus: (d: DeviceInfo) => <DeviceStatusBadge status={d.status} />,
  renderActivities: (d: DeviceInfo) => <ActivityBadge activities={d.activities} lastControl={d.lastControl} />,
  unavailableReason: (d: DeviceInfo) => UNAVAILABLE_REASON[d.status] ?? 'This device is unavailable',
}

type Props =
  | { devices: DeviceInfo[]; value: string; onChange: (id: string) => void; multiple?: false }
  | { devices: DeviceInfo[]; value: string[]; onChange: (ids: string[]) => void; multiple: true }

export function DevicePicker(props: Props) {
  return <BaseDevicePicker<DeviceInfo> {...props} {...SLOTS} />
}
