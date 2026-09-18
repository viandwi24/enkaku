'use client'

import { useCallback, useMemo, useState } from 'react'
import type { ActionResult, DeviceInfo, GroupInfo, Target } from '@enkaku/protocol'

/**
 * MVP 07 §2.1: "Three modes, one control: devices (chips with search over
 * label, number, tag, group), group (one select), tags (multi-select)." The
 * third mode is labels since plan 225 retired free-form tags for them.
 */
export type TargetMode = 'devices' | 'group' | 'labels'

/**
 * What the entry point knows (MVP 07 §2.1): "Pre-filled from context. Opened
 * from one device, it shows that one device selected. Opened from a
 * selection, it shows the selection. Opened from a group chip, it shows the
 * group with its resolved member count. Opened from the Jobs page 'Run
 * again', it shows the batch's original target." It is a starting point and
 * never a lock: every field stays editable in place.
 */
export interface TargetContext {
  deviceIds?: readonly string[]
  groupId?: string | null
  /** Label IDS, never names — a renamed label must keep resolving (see `TargetSchema`). */
  labelIds?: readonly string[]
}

export interface TargetChip {
  device: DeviceInfo
  /** The device's row from the last `ActionResponse`, or null before the first request. */
  result: ActionResult | null
}

export interface TargetState {
  mode: TargetMode
  setMode: (m: TargetMode) => void
  /** The whole pool, unfiltered: an unusable device stays visible with its reason, never silently removed. */
  devices: DeviceInfo[]
  groups: GroupInfo[]
  deviceIds: string[]
  toggleDevice: (id: string) => void
  groupId: string | null
  setGroupId: (id: string | null) => void
  labelIds: string[]
  toggleLabel: (labelId: string) => void
  /** MVP 07 §1.1's body, or null when nothing is chosen. */
  target: Target | null
  /** The ids this target resolves to right now, by §3.11's two rules. */
  resolvedIds: string[]
  /**
   * How many of `resolvedIds` this target's verb will actually act on.
   *
   * For nearly every verb that is the USABLE count — neither offline nor
   * quarantined — because a phone that is not answering cannot be woken,
   * typed at or installed onto. For a verb the protocol marks
   * `ACTION_OFFLINE_REACH: 'allow'` it is every resolved device, because the
   * work is on the farm's side of the wire (`set-group`, `settings`) or the
   * unreachable device IS the point (`reconnect`, `unquarantine`). See
   * `reachesOffline` on this hook's options.
   */
  count: number
  /** The collapsed line: `3 devices`, `Team A · 12 devices`, `Smoke Pool · 7 devices`, `No devices chosen`. */
  summary: string
  /** One chip per resolved device, with its last result. */
  chips: TargetChip[]
  /** `maxTargets: 1`: the picker still renders, one chip only, switchable. */
  locked: boolean
  warnedIds: string[]
  forbiddenIds: string[]
  /** True when at least one device came back `warned` and none has been forced yet: the primary button becomes "Continue for N devices". */
  needsForce: boolean
  /** True when every resolved device came back `forbidden`: the primary button is disabled. */
  allForbidden: boolean
  /** Stores one response's rows against their devices. */
  applyResults: (results: readonly ActionResult[]) => void
  /** Drops every stored row. Called whenever the target itself changes, so a stale sentence can never survive a retarget. */
  clearResults: () => void
  reset: (ctx: TargetContext) => void
}

function usableStatus(d: Pick<DeviceInfo, 'status'>): boolean {
  return d.status !== 'offline' && d.status !== 'quarantined'
}

/**
 * The one target model (MVP 07 §2.1). One component, one hook, one place —
 * see `DevicePicker.tsx` for the rendering half of that same sentence.
 */
export function useTarget(opts: {
  devices: DeviceInfo[]
  groups: GroupInfo[]
  initial: TargetContext
  /** A plugin verb may declare `maxTargets: 1` (MVP 07 §2.1). No MVP verb does. */
  maxTargets?: number
  /**
   * True when the verb this target is for still acts on an offline or
   * quarantined device — `verbReachesOffline` from `@enkaku/protocol`, which
   * is the SAME table the core dispatches by (`actions/run.ts`).
   *
   * It exists because this hook used to answer that question itself, for
   * every verb, with one hard-coded `usableStatus` filter: `count` counted
   * only reachable devices, and `ActionDialog` disables its footer button at
   * `count === 0`. So on a selection of offline phones, Move group, Settings,
   * Network and Forget all came up dead — and Reconnect and Return from
   * quarantine, whose entire purpose is a device in one of those two states,
   * could never be submitted at all from the menus (owner, 2026-09-18).
   * Reconnect's own dialog note said "An offline device is retried, not
   * skipped" above a disabled button.
   *
   * Defaults to false, which is the old behaviour, so a caller that is not
   * about one verb (`DevicePickerDialog`) is unchanged.
   */
  reachesOffline?: boolean
}): TargetState {
  const { devices, groups, maxTargets } = opts
  const reachesOffline = opts.reachesOffline ?? false

  const initialMode: TargetMode = opts.initial.deviceIds?.length
    ? 'devices'
    : opts.initial.groupId
      ? 'group'
      : opts.initial.labelIds?.length
        ? 'labels'
        : 'devices'

  const [mode, setModeRaw] = useState<TargetMode>(initialMode)
  const [deviceIds, setDeviceIds] = useState<string[]>([...(opts.initial.deviceIds ?? [])])
  const [groupId, setGroupIdRaw] = useState<string | null>(opts.initial.groupId ?? null)
  const [labelIds, setLabelIds] = useState<string[]>([...(opts.initial.labelIds ?? [])])
  const [resultsByDevice, setResultsByDevice] = useState<Record<string, ActionResult>>({})

  const locked = maxTargets === 1

  const clearResults = useCallback(() => setResultsByDevice({}), [])

  const setMode = useCallback(
    (m: TargetMode) => {
      clearResults()
      setModeRaw(m)
    },
    [clearResults],
  )

  const toggleDevice = useCallback(
    (id: string) => {
      clearResults()
      setDeviceIds((prev) => {
        if (locked) return prev.includes(id) ? [] : [id]
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      })
    },
    [clearResults, locked],
  )

  const setGroupId = useCallback(
    (id: string | null) => {
      clearResults()
      setGroupIdRaw(id)
    },
    [clearResults],
  )

  const toggleLabel = useCallback(
    (labelId: string) => {
      clearResults()
      setLabelIds((prev) => (prev.includes(labelId) ? prev.filter((t) => t !== labelId) : [...prev, labelId]))
    },
    [clearResults],
  )

  const reset = useCallback(
    (ctx: TargetContext) => {
      clearResults()
      setDeviceIds([...(ctx.deviceIds ?? [])])
      setGroupIdRaw(ctx.groupId ?? null)
      setLabelIds([...(ctx.labelIds ?? [])])
      setModeRaw(ctx.deviceIds?.length ? 'devices' : ctx.groupId ? 'group' : ctx.labelIds?.length ? 'labels' : 'devices')
    },
    [clearResults],
  )

  const resolvedIds = useMemo(() => {
    if (mode === 'devices') {
      const present = new Set(devices.map((d) => d.id))
      return deviceIds.filter((id) => present.has(id))
    }
    if (mode === 'group') {
      return devices.filter((d) => d.group?.id === groupId).map((d) => d.id)
    }
    // AND, the same intersection `resolveTarget` applies server-side: a
    // device must carry EVERY chosen label.
    return devices
      .filter((d) => {
        const carried = new Set(d.labels.map((l) => l.id))
        return labelIds.every((id) => carried.has(id))
      })
      .map((d) => d.id)
  }, [mode, devices, deviceIds, groupId, labelIds])

  const resolvedDevices = useMemo(() => {
    const byId = new Map(devices.map((d) => [d.id, d] as const))
    return resolvedIds.map((id) => byId.get(id)).filter((d): d is DeviceInfo => d !== undefined)
  }, [resolvedIds, devices])

  const usableCount = useMemo(
    () => (reachesOffline ? resolvedDevices.length : resolvedDevices.filter(usableStatus).length),
    [resolvedDevices, reachesOffline],
  )
  const unavailableCount = resolvedDevices.length - usableCount

  const summary = useMemo(() => {
    if (mode === 'devices') {
      if (resolvedIds.length === 0) return 'No devices chosen'
      return `${usableCount} device${usableCount === 1 ? '' : 's'}${unavailableCount > 0 ? ` · ${unavailableCount} unavailable` : ''}`
    }
    if (mode === 'group') {
      const group = groups.find((g) => g.id === groupId)
      if (!group) return 'No devices chosen'
      return `${group.name} · ${usableCount} device${usableCount === 1 ? '' : 's'}`
    }
    if (labelIds.length === 0) return 'No devices chosen'
    // Named, not id'd: an id in a summary line tells an operator nothing.
    const names = labelIds.map((id) => devices.flatMap((d) => d.labels).find((l) => l.id === id)?.name ?? id)
    return `${names.join(' + ')} · ${usableCount} device${usableCount === 1 ? '' : 's'}`
  }, [mode, resolvedIds.length, usableCount, unavailableCount, groups, groupId, labelIds, devices])

  const target: Target | null = useMemo(() => {
    if (mode === 'devices') return resolvedIds.length > 0 ? { deviceIds: resolvedIds } : null
    if (mode === 'group') return groupId ? { groupId } : null
    return labelIds.length > 0 ? { labelIds } : null
  }, [mode, resolvedIds, groupId, labelIds])

  const chips: TargetChip[] = useMemo(
    () => resolvedDevices.map((device) => ({ device, result: resultsByDevice[device.id] ?? null })),
    [resolvedDevices, resultsByDevice],
  )

  const warnedIds = useMemo(() => resolvedIds.filter((id) => resultsByDevice[id]?.status === 'warned'), [resolvedIds, resultsByDevice])
  const forbiddenIds = useMemo(() => resolvedIds.filter((id) => resultsByDevice[id]?.status === 'forbidden'), [resolvedIds, resultsByDevice])

  const applyResults = useCallback((results: readonly ActionResult[]) => {
    setResultsByDevice((prev) => {
      const next = { ...prev }
      for (const r of results) {
        if (r.status === 'warned' || r.status === 'forbidden' || r.status === 'skipped' || r.status === 'failed') next[r.deviceId] = r
        else delete next[r.deviceId]
      }
      return next
    })
  }, [])

  return {
    mode,
    setMode,
    devices,
    groups,
    deviceIds,
    toggleDevice,
    groupId,
    setGroupId,
    labelIds,
    toggleLabel,
    target,
    resolvedIds,
    count: usableCount,
    summary,
    chips,
    locked,
    warnedIds,
    forbiddenIds,
    needsForce: warnedIds.length > 0,
    allForbidden: resolvedIds.length > 0 && forbiddenIds.length === resolvedIds.length,
    applyResults,
    clearResults,
    reset,
  }
}
