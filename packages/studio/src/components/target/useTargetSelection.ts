'use client'

import { useEffect, useState } from 'react'
import type { GroupInfo } from '@enkaku/protocol'

/**
 * Plan 104 (M69) §3.1, §4 — the target model `RunScriptDialog` already had,
 * pulled out so every action dialog can share it instead of re-inventing a
 * `deviceIds`/`groupId` pair per file (G1/G2). Three shapes, unchanged from
 * `RunScriptDialog`'s own `Target`: one device, a saved group (renamed from
 * `cluster` by plan 207 — MVP 15 §0.1 item 3), or an ad-hoc device list.
 */
export type Target = 'single' | 'group' | 'devices'

/**
 * What a caller knows when it opens a picker — plan 104 §3.2's own table: a
 * device popup with nothing else selected targets that device; the same
 * popup with N devices selected arrives pre-filled with those N; a group
 * screen defaults to that group. `reset()` (below) turns this into a
 * concrete `target`/`deviceId`/`deviceIds`/`groupId`, and it is always the
 * OPERATOR who can still change it afterward — this context is a starting
 * point, never a lock (§3.2's own words).
 */
export interface TargetDefaultContext {
  /** The pool a single-device fallback may land on — usually the caller's own notion of "usable" (RunScriptDialog: not quarantined). */
  devices: Array<{ id: string }>
  /** The subset of `devices` that could start RIGHT NOW — preferred for the single-device fallback so a picker never defaults to a phone that cannot act for hours. Defaults to `devices` itself when omitted. */
  readyNow?: Array<{ id: string }>
  /** Which modes this action allows, in priority order for defaulting (plan 104 §3.4 — each action declares its own set). */
  allow: Target[]
  /** An explicit single device the caller already knows about (a locked page, a popup's own focus device). */
  initialDeviceId?: string | null
  /**
   * A LIVE multi-selection (the Wall/List `selectedIds`, or a device
   * popup's own candidate set) — wins over `initialDeviceId` whenever it is
   * non-empty and `devices` is an allowed mode (§3.2's "device popup while N
   * devices are selected" / "the fleet toolbar with a selection" rows).
   */
  initialSelectedIds?: readonly string[]
  /** A group screen's own id (§3.2's "a group screen defaults to that group" row). */
  initialGroupId?: string | null
}

interface ResolvedDefault {
  mode: Target
  deviceId?: string
  deviceIds?: string[]
  groupId?: string
}

/** Plan 104 §3.2's table, as a pure function — probed directly by `useTargetSelection.test.ts` without having to mount a component. */
export function computeDefaultTarget(ctx: TargetDefaultContext): ResolvedDefault {
  const { devices, readyNow = devices, allow, initialDeviceId, initialSelectedIds, initialGroupId } = ctx

  if (initialSelectedIds && initialSelectedIds.length > 0 && allow.includes('devices')) {
    return { mode: 'devices', deviceIds: [...new Set(initialSelectedIds)] }
  }
  if (initialGroupId && allow.includes('group')) {
    return { mode: 'group', groupId: initialGroupId }
  }
  if (allow.includes('single')) {
    const deviceId =
      initialDeviceId && devices.some((d) => d.id === initialDeviceId)
        ? initialDeviceId
        : (readyNow[0]?.id ?? devices[0]?.id ?? '')
    return { mode: 'single', deviceId }
  }
  // No allowed mode matched a context clue — land on whichever mode the
  // caller listed first, empty, rather than crash on an action that (for
  // now) never allows `single` at all.
  const fallback = allow[0] ?? 'single'
  if (fallback === 'devices') return { mode: 'devices', deviceIds: [] }
  if (fallback === 'group') return { mode: 'group', groupId: '' }
  return { mode: 'single', deviceId: '' }
}

export interface UseTargetSelectionOptions {
  /**
   * How many devices count as "usable" for THIS action — the fleet-wide
   * gate's denominator (plan 94 §9 Q4, carried over unchanged). A
   * caller-specific notion (RunScriptDialog: every non-quarantined device);
   * most callers can just pass their own `devices.length`.
   */
  usableCount: number
  /** Needed only when `group` is an allowed mode — `resolvedCount` reads a chosen group's own `usableCount` off this list. */
  groups?: GroupInfo[]
}

export interface TargetSelection {
  target: Target
  setTarget: (t: Target) => void
  deviceId: string
  setDeviceId: (id: string) => void
  deviceIds: string[]
  setDeviceIds: (ids: string[]) => void
  groupId: string
  setGroupId: (id: string) => void
  /**
   * The one true count for whatever `target` currently resolves to — a
   * chosen group's own `usableCount`, the picked device-id list's length,
   * or 1/0 for `single` depending on whether a device is actually chosen.
   * Plan 104 §4: "the resolved count is rendered by the picker itself, not
   * by each dialog, so no dialog can show a number that disagrees with what
   * it will submit" — every caller reads this instead of re-deriving it.
   */
  resolvedCount: number
  /** Whether a real target is currently chosen at all — the generic half of every dialog's own submit gate. */
  hasTarget: boolean
  /** Plan 94 §9 Q4 — every currently-usable device in the farm, matched by count, not merely "more than one device". */
  fleetWide: boolean
  fleetConfirm: string
  setFleetConfirm: (v: string) => void
  fleetConfirmed: boolean
  /**
   * Re-derives target/deviceId/deviceIds/groupId from a fresh context
   * (plan 104 §3.2) — call this explicitly whenever the THING the picker
   * targets changes (a different script picked, a different popup opened).
   * Never wired to fire on every render: the operator's own edits must
   * survive until the caller has an actual reason to re-default.
   */
  reset: (ctx: TargetDefaultContext) => void
}

/**
 * Plan 104 (M69) §3.1, §4 — the reusable half of what used to be
 * `RunScriptDialog`'s own local state. `TargetPicker` (`./TargetPicker.tsx`)
 * is the reusable half of its JSX; this hook is the reusable half of its
 * `useState`/derived-value block.
 */
export function useTargetSelection(opts: UseTargetSelectionOptions): TargetSelection {
  const { usableCount, groups = [] } = opts
  const [target, setTarget] = useState<Target>('single')
  const [deviceId, setDeviceId] = useState('')
  const [deviceIds, setDeviceIds] = useState<string[]>([])
  const [groupId, setGroupId] = useState('')
  const [fleetConfirm, setFleetConfirm] = useState('')

  // A typed fleet-wide confirmation belongs to ONE specific selection —
  // switching target, group, or device list must not leave a stale
  // confirmation valid for whatever the operator picks next (plan 94 §9 Q4,
  // carried over unchanged from `RunScriptDialog`).
  useEffect(() => {
    setFleetConfirm('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, groupId, deviceIds.length])

  const resolvedCount =
    target === 'group'
      ? (groups.find((g) => g.id === groupId)?.usableCount ?? 0)
      : target === 'devices'
        ? deviceIds.length
        : deviceId
          ? 1
          : 0

  const hasTarget =
    target === 'single' ? !!deviceId : target === 'group' ? !!groupId && resolvedCount > 0 : deviceIds.length > 0

  const fleetWide = (target === 'group' || target === 'devices') && resolvedCount > 0 && usableCount > 0 && resolvedCount >= usableCount
  const fleetConfirmed = !fleetWide || fleetConfirm.trim() === String(resolvedCount)

  function reset(ctx: TargetDefaultContext): void {
    const d = computeDefaultTarget(ctx)
    setTarget(d.mode)
    setDeviceId(d.deviceId ?? '')
    setDeviceIds(d.deviceIds ?? [])
    setGroupId(d.groupId ?? '')
    setFleetConfirm('')
  }

  return {
    target,
    setTarget,
    deviceId,
    setDeviceId,
    deviceIds,
    setDeviceIds,
    groupId,
    setGroupId,
    resolvedCount,
    hasTarget,
    fleetWide,
    fleetConfirm,
    setFleetConfirm,
    fleetConfirmed,
    reset,
  }
}
