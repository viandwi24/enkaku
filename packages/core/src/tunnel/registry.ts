import type { ServerWebSocket } from 'bun'
import type { DeviceInfo } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { nodes, devices } from '../db/schema'
import type { Logger } from '../util/logger'

export interface NodeConn {
  nodeId: string
  ws: ServerWebSocket<unknown>
  connectedAt: number
  version?: string
  platform?: string
}

export interface TunnelRegistry {
  attach(nodeId: string, ws: ServerWebSocket<unknown>): NodeConn
  detach(ws: ServerWebSocket<unknown>): NodeConn | null
  byNode(nodeId: string): NodeConn | null
  /** The node holding that device (routes browser messages to the right node). */
  forDevice(deviceId: string): NodeConn | null
  /** Sync the device list a node reports. */
  syncDevices(nodeId: string, list: DeviceInfo[]): void
  onlineNodes(): NodeConn[]
}

/**
 * A registry of node connections plus a device→node map (plan 11 §4.3).
 * A dropped tunnel marks all of that node's devices offline; any running lease
 * or job is resolved by the Plan 04 lease-expiry mechanism — there is no special
 * path that could become a bug source of its own.
 */
export function createTunnelRegistry(deps: {
  db: Db
  log: Logger
  onDevicesChanged?: (nodeId: string) => void
  onNodeGone?: (nodeId: string) => void
}): TunnelRegistry {
  const byNodeId = new Map<string, NodeConn>()
  const bySocket = new WeakMap<ServerWebSocket<unknown>, NodeConn>()
  const deviceOwner = new Map<string, string>()

  const markNode = (nodeId: string, status: 'online' | 'offline') => {
    deps.db.update(nodes).set({ status, lastSeen: new Date() }).where(eq(nodes.id, nodeId)).run()
  }

  return {
    attach(nodeId, ws) {
      // One node, one connection; the old connection is dropped so a device
      // never has two sources of truth.
      const previous = byNodeId.get(nodeId)
      if (previous) {
        deps.log.warn(`node ${nodeId} reconnected — dropping the previous connection`)
        try {
          previous.ws.close(4409, 'replaced by a newer connection')
        } catch {
          // already closed
        }
      }
      const conn: NodeConn = { nodeId, ws, connectedAt: Date.now() }
      byNodeId.set(nodeId, conn)
      bySocket.set(ws, conn)
      markNode(nodeId, 'online')
      deps.log.info(`node online: ${nodeId}`)
      return conn
    },

    detach(ws) {
      const conn = bySocket.get(ws)
      if (!conn) return null
      bySocket.delete(ws)
      if (byNodeId.get(conn.nodeId) === conn) byNodeId.delete(conn.nodeId)
      markNode(conn.nodeId, 'offline')
      // This node's devices are no longer reachable.
      deps.db.update(devices).set({ status: 'offline' }).where(eq(devices.nodeId, conn.nodeId)).run()
      for (const [deviceId, owner] of [...deviceOwner]) {
        if (owner === conn.nodeId) deviceOwner.delete(deviceId)
      }
      deps.log.info(`node offline: ${conn.nodeId}`)
      deps.onNodeGone?.(conn.nodeId)
      deps.onDevicesChanged?.(conn.nodeId)
      return conn
    },

    byNode: (nodeId) => byNodeId.get(nodeId) ?? null,

    forDevice(deviceId) {
      const nodeId = deviceOwner.get(deviceId)
      if (nodeId) return byNodeId.get(nodeId) ?? null
      // Fallback to the DB column (a freshly connected node, memory map not filled yet).
      const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
      return row?.nodeId ? (byNodeId.get(row.nodeId) ?? null) : null
    },

    syncDevices(nodeId, list) {
      const seen = new Set<string>()
      for (const info of list) {
        seen.add(info.id)
        deviceOwner.set(info.id, nodeId)
        const existing = deps.db.select().from(devices).where(eq(devices.stableId, info.stableId)).get()
        const values = {
          serial: info.serial,
          label: info.label,
          androidVersion: info.androidVersion,
          apiLevel: info.apiLevel,
          screenW: info.screenW,
          screenH: info.screenH,
          status: info.status,
          nodeId,
          lastSeen: new Date(),
        }
        if (existing) {
          deps.db.update(devices).set(values).where(eq(devices.id, existing.id)).run()
        } else {
          deps.db
            .insert(devices)
            .values({ id: info.id, stableId: info.stableId, ...values })
            .run()
        }
      }
      // Devices missing from the node's report are marked offline.
      for (const row of deps.db.select().from(devices).where(eq(devices.nodeId, nodeId)).all()) {
        if (!seen.has(row.id) && row.status !== 'offline') {
          deps.db.update(devices).set({ status: 'offline' }).where(eq(devices.id, row.id)).run()
          deviceOwner.delete(row.id)
        }
      }
      deps.onDevicesChanged?.(nodeId)
    },

    onlineNodes: () => [...byNodeId.values()],
  }
}
