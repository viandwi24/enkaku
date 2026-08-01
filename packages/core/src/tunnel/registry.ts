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
  /** Agent yang memegang device tsb (routing pesan browser → agent). */
  forDevice(deviceId: string): AgentConn | null
  /** Sinkronkan daftar device yang dilaporkan agent. */
  syncDevices(agentId: string, list: DeviceInfo[]): void
  onlineAgents(): AgentConn[]
}

/**
 * Registry koneksi agent + peta device→agent (plan 11 §4.3).
 * Tunnel putus = semua device agent itu ditandai offline; lease/job yang
 * sedang jalan diselesaikan oleh mekanisme lease-expiry Plan 04 — tidak ada
 * jalur khusus yang bisa jadi sumber bug tersendiri.
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
      // Satu agent = satu koneksi; koneksi lama diputus supaya tidak ada
      // dua sumber kebenaran untuk device yang sama.
      const previous = byAgentId.get(agentId)
      if (previous) {
        deps.log.warn(`agent ${agentId} connect ulang — koneksi lama diputus`)
        try {
          previous.ws.close(4409, 'digantikan koneksi baru')
        } catch {
          // sudah tertutup
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
      // Device milik agent ini tidak lagi terjangkau.
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
      // Fallback: kolom DB (agent baru connect, peta memori belum terisi).
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
      // Device yang hilang dari laporan agent → offline.
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
