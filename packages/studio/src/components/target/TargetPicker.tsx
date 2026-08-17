'use client'

import type { ClusterInfo, DeviceInfo } from '@enkaku/protocol'
import { DevicePicker } from '@/components/DevicePicker'
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@enkaku/ui'
import type { Target, TargetSelection } from './useTargetSelection'

const TAB_LABEL: Record<Target, string> = {
  single: 'Single device',
  cluster: 'Cluster',
  devices: 'Multiple devices',
}

// Tailwind v4 needs the full class name written out somewhere it scans —
// `grid-cols-${n}` never generates anything (docs/design.md's own warning
// about the v3 bracket form applies just as much to a template literal).
const GRID_COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' }

/**
 * Plan 104 (M69) §3.1, §4 — extracted from `RunScriptDialog` (the only place
 * this model existed before this plan, G1) so `InstallBatchDialog`,
 * `BulkTransferDialog`, `ForgetDeviceDialog` and the rest can reuse it
 * instead of each acting on whatever device set their caller happened to
 * hand them (G2).
 *
 * Three parts, always in this order: the mode switch (only when the action
 * allows more than one mode — plan §3.4's own per-action table), the
 * device/cluster editor for whichever mode is active, and the resolved
 * count — ALWAYS visible for a multi-device mode, never revealed only at
 * submit (§3.2's own mitigation for the risk a context-filled default
 * creates: an operator acting on a set they never noticed). A single-device
 * mode shows no separate count line — the one device chosen in the picker
 * below already says it, unambiguously.
 *
 * A caller with exactly one allowed mode still renders through this
 * component rather than being handed a bare `DevicePicker` — see
 * `SingleDeviceNotice` in the dialogs that are single-device ONLY (Assist,
 * Take control): they render a short, explicit sentence instead of this
 * component, per §3.4's "a single-device-only action must SAY it is
 * single-device rather than omitting the picker".
 */
export function TargetPicker({
  selection,
  devices,
  clusters = [],
  allow,
  singleLabel = 'Device',
  devicesLabel = 'Devices',
}: {
  selection: TargetSelection
  /** The full pool a picker widget shows — unavailable devices still render, disabled, with a reason (plan 19 §3.2), never silently removed. */
  devices: DeviceInfo[]
  clusters?: ClusterInfo[]
  allow: Target[]
  singleLabel?: string
  devicesLabel?: string
}) {
  const {
    target,
    setTarget,
    deviceId,
    setDeviceId,
    deviceIds,
    setDeviceIds,
    clusterId,
    setClusterId,
    resolvedCount,
    fleetWide,
    fleetConfirm,
    setFleetConfirm,
  } = selection

  return (
    <div className="space-y-3">
      {allow.length > 1 && (
        <Tabs value={target} onValueChange={(v) => setTarget(v as Target)}>
          <TabsList className={`grid w-full ${GRID_COLS[allow.length] ?? 'grid-cols-3'}`}>
            {allow.map((mode) => (
              <TabsTrigger key={mode} value={mode}>
                {TAB_LABEL[mode]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {target === 'single' &&
        (devices.length === 0 ? (
          <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
            No device is enrolled yet. Connect one first.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">{singleLabel}</Label>
            <DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} multiple={false} />
          </div>
        ))}

      {target === 'cluster' &&
        (clusters.length === 0 ? (
          <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
            No cluster is saved yet — create one from the Clusters page, or pick &quot;Multiple devices&quot; instead.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Cluster</Label>
            <Select value={clusterId} onValueChange={setClusterId}>
              <SelectTrigger className="h-8 w-full text-[12.5px]">
                <SelectValue placeholder="Pick a cluster" />
              </SelectTrigger>
              <SelectContent>
                {clusters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="readout text-fg-subtle">· {c.usableCount} now</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}

      {target === 'devices' && (
        <div className="space-y-1.5">
          <Label className="text-[13px] font-normal">{devicesLabel}</Label>
          <DevicePicker devices={devices} value={deviceIds} onChange={setDeviceIds} multiple />
        </div>
      )}

      {/* The resolved count — always visible, never revealed only at submit
          (plan 104 §3.2, §4): the one place a multi-device target's size is
          shown, so no dialog can display a number that disagrees with what
          it will actually send. */}
      {(target === 'cluster' || target === 'devices') && (
        <p className="readout text-[11px] text-fg-muted">
          Targets {resolvedCount} device{resolvedCount === 1 ? '' : 's'}
        </p>
      )}

      {fleetWide && (
        <div className="space-y-1.5 rounded-lg border border-led-warn/30 bg-led-warn/5 p-3">
          <p className="text-[12.5px] font-medium text-led-warn">This targets every usable device on the farm</p>
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            Type <span className="readout">{resolvedCount}</span> to confirm running on all {resolvedCount} device
            {resolvedCount === 1 ? '' : 's'}.
          </p>
          <Input
            value={fleetConfirm}
            onChange={(e) => setFleetConfirm(e.target.value)}
            placeholder={String(resolvedCount)}
            className="readout h-8 w-24 text-[12.5px]"
            aria-label="Type the device count to confirm"
          />
        </div>
      )}
    </div>
  )
}

/**
 * Plan 104 §3.4 — "a single-device-only action must SAY it is single-device
 * rather than omitting the picker". Assist and Take control are leases, one
 * device by definition (plan 91 §3.2); this is the sentence they render in
 * `TargetPicker`'s place, so the operator never has to guess whether a live
 * multi-selection applied to a lease that can only ever hold one phone.
 */
export function SingleDeviceNotice({ deviceLabel }: { deviceLabel: string }) {
  return (
    <p className="rounded-lg border bg-surface-2/40 px-3 py-2 text-[12.5px] text-fg-muted">
      Single device only — <span className="text-fg">{deviceLabel}</span>. A lease can only ever hold one phone, even
      while others are selected.
    </p>
  )
}
