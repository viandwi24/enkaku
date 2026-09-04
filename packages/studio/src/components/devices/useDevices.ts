'use client'

import { useCallback, useEffect, useState } from 'react'
import { GroupInfoSchema, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import { applyActivityEvent } from '@/lib/activity'
import { fetchAllPages, fetchDevices, fetchDiscoveredDevices, type DiscoveredDevice } from '@/lib/api'
import { ws } from '@/lib/ws'

export interface DevicesState {
  devices: DeviceInfo[] | null
  groups: GroupInfo[]
  discovered: DiscoveredDevice[]
  error: string | null
  /** For the discovery sheet and the group strip after a mutation. */
  reload: () => void
}

/**
 * The device list: one seed, then pushes (plan 214 §4.14) — replaces the old
 * fleet screen's `load()` plus ten WS branches. Nothing else on this screen
 * fetches a device.
 */
export function useDevices(): DevicesState {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([])
  const [error, setError] = useState<string | null>(null)

  const seed = useCallback(() => {
    fetchDevices()
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    fetchAllPages('/api/groups', undefined, GroupInfoSchema)
      .then(setGroups)
      .catch(() => {
        // A failed read leaves the group strip where it was, not blank.
      })
    fetchDiscoveredDevices()
      .then(setDiscovered)
      .catch(() => {
        // Same rule: leave the discovery sheet's last known list standing.
      })
  }, [])

  useEffect(() => {
    seed()
    const offReconnect = ws.onReconnected(seed)
    const off = ws.on((msg) => {
      switch (msg.type) {
        case 'device.added':
          setDevices((prev) => [...(prev ?? []).filter((d) => d.id !== msg.payload.id), msg.payload])
          setDiscovered((prev) => prev.filter((d) => d.stableId !== msg.payload.stableId))
          break
        case 'device.updated':
          // In place, by id — NOT the filter-and-append `device.added` uses,
          // which would jump a moved device to the end of the wall. The whole
          // row is replaced, so anything the server changed (group today,
          // label or tags tomorrow) lands without a new message type.
          setDevices((prev) => (prev ?? []).map((d) => (d.id === msg.payload.id ? msg.payload : d)))
          break
        case 'device.removed':
          setDevices((prev) => (prev ?? []).filter((d) => d.id !== msg.payload.id))
          break
        case 'device.status':
          setDevices((prev) =>
            (prev ?? []).map((d) => (d.id === msg.payload.id ? { ...d, status: msg.payload.status } : d)),
          )
          break
        case 'device.activity':
          setDevices((prev) =>
            (prev ?? []).map((d) => (d.id === msg.payload.deviceId ? applyActivityEvent(d, msg.payload) : d)),
          )
          break
        case 'device.battery':
          setDevices((prev) =>
            (prev ?? []).map((d) => (d.id === msg.payload.deviceId ? { ...d, battery: msg.payload.battery } : d)),
          )
          break
        case 'device.metrics':
          setDevices((prev) =>
            (prev ?? []).map((d) => (d.id === msg.payload.deviceId ? { ...d, metrics: msg.payload.metrics } : d)),
          )
          break
        case 'device.discovered':
          // No `firstSeen` on this payload (same reason the old screen
          // refetched, `app/page.tsx:549-553` before this plan) — reload
          // the discovered slice only.
          fetchDiscoveredDevices()
            .then(setDiscovered)
            .catch(() => {})
          break
        default:
          break
      }
    })
    return () => {
      offReconnect()
      off()
    }
  }, [seed])

  return { devices, groups, discovered, error, reload: seed }
}
