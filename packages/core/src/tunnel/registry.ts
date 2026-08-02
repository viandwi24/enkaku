import type { ServerWebSocket } from 'bun'
import type { DeviceInfo } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { agents, devices } from '../db/schema'
import type { Logger } from '../util/logger'

export interface AgentConn {
  agentId: string
  ws: ServerWebSocket<unknown>
  connectedAt: number
  version?: string
  platform?: string
}

export interface TunnelRegistry {
  attach(agentId: string, ws: ServerWebSocket<unknown>): AgentConn
  detach(ws: ServerWebSocket<unknown>): AgentConn | null
  byAgent(agentId: string): AgentConn | null
  /** The agent holding that device (routes browser messages to the right agent). */
  forDevice(deviceId: string): AgentConn | null
  /** Sync the device list an agent reports. */
  syncDevices(agentId: string, list: DeviceInfo[]): void
  onlineAgents(): AgentConn[]
}

/**
 * A registry of agent connections plus a device→agent map (plan 11 §4.3).
 * A dropped tunnel marks all of that agent's devices offline; any running lease
 * or job is resolved by the Plan 04 lease-expiry mechanism — there is no special
 * path that could become a bug source of its own.
 */
export function createTunnelRegistry(deps: {
  db: Db
  log: Logger
  onDevicesChanged?: (agentId: string) => void
  onAgentGone?: (agentId: string) => void
}): TunnelRegistry {
  const byAgentId = new Map<string, AgentConn>()
  const bySocket = new WeakMap<ServerWebSocket<unknown>, AgentConn>()
  const deviceOwner = new Map<string, string>()

  const markAgent = (agentId: string, status: 'online' | 'offline') => {
    deps.db.update(agents).set({ status, lastSeen: new Date() }).where(eq(agents.id, agentId)).run()
  }

  return {
    attach(agentId, ws) {
      // One agent, one connection; the old connection is dropped so a device
      // never has two sources of truth.
      const previous = byAgentId.get(agentId)
      if (previous) {
        deps.log.warn(`agent ${agentId} reconnected — dropping the previous connection`)
        try {
          previous.ws.close(4409, 'replaced by a newer connection')
        } catch {
          // already closed
        }
      }
      const conn: AgentConn = { agentId, ws, connectedAt: Date.now() }
      byAgentId.set(agentId, conn)
      bySocket.set(ws, conn)
      markAgent(agentId, 'online')
      deps.log.info(`agent online: ${agentId}`)
      return conn
    },

    detach(ws) {
      const conn = bySocket.get(ws)
      if (!conn) return null
      bySocket.delete(ws)
      if (byAgentId.get(conn.agentId) === conn) byAgentId.delete(conn.agentId)
      markAgent(conn.agentId, 'offline')
      // This agent's devices are no longer reachable.
      deps.db.update(devices).set({ status: 'offline' }).where(eq(devices.agentId, conn.agentId)).run()
      for (const [deviceId, owner] of [...deviceOwner]) {
        if (owner === conn.agentId) deviceOwner.delete(deviceId)
      }
      deps.log.info(`agent offline: ${conn.agentId}`)
      deps.onAgentGone?.(conn.agentId)
      deps.onDevicesChanged?.(conn.agentId)
      return conn
    },

    byAgent: (agentId) => byAgentId.get(agentId) ?? null,

    forDevice(deviceId) {
      const agentId = deviceOwner.get(deviceId)
      if (agentId) return byAgentId.get(agentId) ?? null
      // Fallback to the DB column (a freshly connected agent, memory map not filled yet).
      const row = deps.db.select().from(devices).where(eq(devices.id, deviceId)).get()
      return row?.agentId ? (byAgentId.get(row.agentId) ?? null) : null
    },

    syncDevices(agentId, list) {
      const seen = new Set<string>()
      for (const info of list) {
        seen.add(info.id)
        deviceOwner.set(info.id, agentId)
        const existing = deps.db.select().from(devices).where(eq(devices.stableId, info.stableId)).get()
        const values = {
          serial: info.serial,
          label: info.label,
          androidVersion: info.androidVersion,
          apiLevel: info.apiLevel,
          screenW: info.screenW,
          screenH: info.screenH,
          status: info.status,
          agentId,
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
      // Devices missing from the agent's report are marked offline.
      for (const row of deps.db.select().from(devices).where(eq(devices.agentId, agentId)).all()) {
        if (!seen.has(row.id) && row.status !== 'offline') {
          deps.db.update(devices).set({ status: 'offline' }).where(eq(devices.id, row.id)).run()
          deviceOwner.delete(row.id)
        }
      }
      deps.onDevicesChanged?.(agentId)
    },

    onlineAgents: () => [...byAgentId.values()],
  }
}
