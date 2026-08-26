'use client'

import type { DeviceInfo } from '@enkaku/protocol'
import { DevicePicker as BaseDevicePicker, type DevicePickerSlots } from '@enkaku/ui'
import { DeviceStatusBadge } from '@/components/StatusBadge'
import { HolderBadge } from '@/components/HolderBadge'
import { UNAVAILABLE_REASON } from '@/components/device-popup/ControlState'

/**
 * Why a device cannot take control or a job right now (plan 19 §4.4) — the
 * text itself now lives in `./device-popup/ControlState.tsx` (plan 105 §5
 * step 105.1's own `free` state reads it too, for the identical reason: one
 * place, not three drifting apart the way each screen's own copy used to).
 * Re-exported here because `DeviceHeader.tsx`/`app/device/page.tsx` already
 * import it from this module, and moving THEIR import instead of leaving one
 * re-export would touch two more files for no behavioural change.
 */
export { UNAVAILABLE_REASON }

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
 * `HolderBadge` reaches `next/link` and `AgentAvatar`, neither of which
 * belongs in a framework-agnostic UI package. `DeviceStatusBadge` and
 * `UNAVAILABLE_REASON` are cheaper, but they are Studio's vocabulary for
 * Studio's screens; a plugin has no use for them and should not inherit
 * them by accident.
 */
const SLOTS: DevicePickerSlots<DeviceInfo> = {
  renderStatus: (d: DeviceInfo) => <DeviceStatusBadge status={d.status} />,
  renderHolders: (d: DeviceInfo) => (
    <>
      {/* A `manual`/`busy` device is still pickable — a job just waits for it
          to go quiet (plan 71 §3.7) — so who holds it now is worth showing
          here rather than only a status word. */}
      {d.heldBy && <HolderBadge holder={d.heldBy} />}
      {/* Who is ASSISTING this device (plan 91 §3.4 item 4, §4.4, F25) — a
          narrow, subordinate grant beside `heldBy` above, never a takeover.
          `?? []` covers a caller that predates the field, the same guard
          `DeviceCard`/`WallTile` use. Plan 105 §3.2/§4 — the "assisting" vs
          "may assist" split lives in `HolderBadge` (`deriveAssistActivity`),
          shared with every other caller. */}
      {(d.assistedBy ?? []).map((a) => (
        <HolderBadge key={a.id} holder={a} variant="assists" />
      ))}
    </>
  ),
  unavailableReason: (d: DeviceInfo) => UNAVAILABLE_REASON[d.status] ?? 'This device is unavailable',
}

type Props =
  | { devices: DeviceInfo[]; value: string; onChange: (id: string) => void; multiple?: false }
  | { devices: DeviceInfo[]; value: string[]; onChange: (ids: string[]) => void; multiple: true }

export function DevicePicker(props: Props) {
  return <BaseDevicePicker<DeviceInfo> {...props} {...SLOTS} />
}
