import type { ServerWebSocket } from 'bun'
import {
  AgentToControlSchema,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type ControlToAgent,
} from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import type { TunnelRegistry } from './registry'

export interface TunnelRouterHooks {
  onJobProgress?: (payload: {
    jobId: string
    kind: 'phase' | 'log' | 'artifact' | 'result'
    phase?: 'prepare' | 'run' | 'finish'
    attempt?: number
    log?: { level: string; source: string; msg: string; ts: number }
    artifact?: { label: string; kind: string; ext?: string; dataBase64: string }
    result?: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
  }) => void
}

export interface TunnelRouter {
  handleAgentMessage(ws: ServerWebSocket<unknown>, agentId: string, raw: string): void
  handleAgentFrame(agentId: string, buf: Uint8Array): void
  /** Send a control-plane command to the agent that owns the device. */
  sendToDevice(deviceId: string, msg: ControlToAgent): boolean
  /** The viewers receiving video frames for a given device. */
  subscribeVideo(deviceId: string, cb: (payload: Uint8Array) => void): () => void
  openChannel(deviceId: string, kind: 'video' | 'audio' | 'control-raw'): number | null
}

/**
 * Router tunnel di control plane (plan 11 §4.3).
 *
 * Authoritative decisions (leases, busy rejection, lock validation) stay in the
 * control plane BEFORE a message is forwarded to an agent — the agent's local
 * re-validation is defence in depth, nothing more.
 */
export function createTunnelRouter(deps: {
  registry: TunnelRegistry
  log: Logger
  /** Diisi setelah remote session manager & job bridge dibuat (siklus wiring). */
  onSessionStarted?: (deviceId: string, info: { codec: 'png' | 'h264'; width: number; height: number }) => void
  onSessionFailed?: (deviceId: string, code: string, message: string) => void
  onJobProgress?: (payload: Parameters<NonNullable<TunnelRouterHooks['onJobProgress']>>[0]) => void
}): TunnelRouter {
  let nextChannelId = 1
  /** channelId → { deviceId, subscribers } */
  const channels = new Map<number, { deviceId: string; kind: string; subscribers: Set<(p: Uint8Array) => void> }>()
  const deviceVideoChannel = new Map<string, number>()

  return {
    handleAgentMessage(ws, agentId, raw) {
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return
      }
      const parsed = AgentToControlSchema.safeParse(json)
      if (!parsed.success) return // unknown message → ignore it (forward-compatible)
      const msg = parsed.data

      if (msg.type === 'agent.hello') {
        const conn = deps.registry.byAgent(agentId)
        if (conn) {
          conn.version = msg.payload.agentVersion
          conn.platform = msg.payload.platform
        }
        ws.send(
          JSON.stringify({
            type: 'agent.hello.ack',
            payload: { agentId, serverTime: Date.now(), pinnedScrcpyVersion: '3.3.1' },
          }),
        )
      } else if (msg.type === 'agent.devices') {
        deps.registry.syncDevices(agentId, msg.payload.devices)
      } else if (msg.type === 'session.started') {
        deps.onSessionStarted?.(msg.payload.deviceId, {
          codec: msg.payload.codec,
          width: msg.payload.width,
          height: msg.payload.height,
        })
      } else if (msg.type === 'session.failed') {
        deps.onSessionFailed?.(msg.payload.deviceId, msg.payload.code, msg.payload.message)
      } else if (msg.type === 'job.progress') {
        deps.onJobProgress?.(msg.payload)
      } else if (msg.type === 'tunnel.ping') {
        ws.send(JSON.stringify({ type: 'tunnel.pong', payload: msg.payload }))
      } else if (msg.type === 'tunnel.channel.close') {
        channels.delete(msg.payload.channelId)
      }
    },

    handleAgentFrame(agentId, buf) {
      let frame
      try {
        frame = decodeTunnelFrame(buf)
      } catch {
        return
      }
      const channel = channels.get(frame.channelId)
      if (!channel) return
      for (const cb of channel.subscribers) cb(frame.payload)
    },

    sendToDevice(deviceId, msg) {
      const conn = deps.registry.forDevice(deviceId)
      if (!conn) {
        deps.log.warn(`no agent online for device ${deviceId}`)
        return false
      }
      conn.ws.send(JSON.stringify(msg))
      return true
    },

    openChannel(deviceId, kind) {
      const conn = deps.registry.forDevice(deviceId)
      if (!conn) return null
      const channelId = nextChannelId++ & 0xffff
      channels.set(channelId, { deviceId, kind, subscribers: new Set() })
      if (kind === 'video') deviceVideoChannel.set(deviceId, channelId)
      conn.ws.send(JSON.stringify({ type: 'tunnel.channel.open', payload: { channelId, deviceId, kind } }))
      return channelId
    },

    subscribeVideo(deviceId, cb) {
      let channelId = deviceVideoChannel.get(deviceId)
      if (channelId === undefined) {
        const opened = this.openChannel(deviceId, 'video')
        if (opened === null) return () => {}
        channelId = opened
      }
      const channel = channels.get(channelId)
      channel?.subscribers.add(cb)
      return () => {
        const ch = channels.get(channelId!)
        ch?.subscribers.delete(cb)
        // A channel with no viewers is closed on the agent (saves encoder and bandwidth).
        if (ch && ch.subscribers.size === 0) {
          const conn = deps.registry.forDevice(deviceId)
          conn?.ws.send(JSON.stringify({ type: 'tunnel.channel.close', payload: { channelId } }))
          channels.delete(channelId!)
          deviceVideoChannel.delete(deviceId)
        }
      }
    },
  }
}

export { encodeTunnelFrame }
