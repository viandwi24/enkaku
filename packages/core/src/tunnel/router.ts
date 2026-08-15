import type { ServerWebSocket } from 'bun'
import {
  NodeToControlSchema,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type ControlToNode,
  type TunnelChannelKind,
} from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import { createChannelIdAllocator } from './channel-allocator'
import type { TunnelRegistry } from './registry'

export interface TunnelRouterHooks {
  onJobProgress?: (payload: {
    jobId: string
    kind: 'phase' | 'log' | 'artifact' | 'result'
    /** `reset` (plan 35 §3.5) is the pre-job device reset — it always runs before `prepare`. */
    phase?: 'reset' | 'prepare' | 'run' | 'finish'
    attempt?: number
    log?: { level: string; source: string; msg: string; ts: number }
    artifact?: { label: string; kind: string; ext?: string; dataBase64: string }
    result?: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
  }) => void
}

export interface TunnelRouter {
  handleNodeMessage(ws: ServerWebSocket<unknown>, nodeId: string, raw: string): void
  handleNodeFrame(nodeId: string, buf: Uint8Array): void
  /** Send a control-plane command to the node that owns the device. */
  sendToDevice(deviceId: string, msg: ControlToNode): boolean
  /** The viewers receiving video frames for a given device. */
  subscribeVideo(deviceId: string, cb: (payload: Uint8Array) => void): () => void
  openChannel(deviceId: string, kind: TunnelChannelKind): number | null
  /** Generic binary channel subscription (plan 25 §4.3) — `subscribeVideo` above is the video-specific case built on the same map. */
  subscribeChannel(channelId: number, cb: (payload: Uint8Array) => void): () => void
  /**
   * Send a binary tunnel frame TO the node on an already-open channel (plan
   * 28 §4.2 point 3) — the control-plane-to-node counterpart of
   * `handleNodeFrame`/`subscribeChannel`, which only ever carried
   * node-to-control-plane data before the cloud adb endpoint needed the
   * other direction too (a `WRTE`'s payload, forwarded to the node to write
   * downstream). A no-op if the channel or its node is gone.
   */
  sendFrame(channelId: number, payload: Uint8Array): void
  /** Explicitly close a channel: tells the node, drops the local bookkeeping, and returns the id to the allocator. */
  closeChannel(channelId: number): void
}

/**
 * Tunnel router in the control plane (plan 11 §4.3).
 *
 * Authoritative decisions (leases, busy rejection, lock validation) stay in the
 * control plane BEFORE a message is forwarded to a node — the node's local
 * re-validation is defence in depth, nothing more.
 */
export function createTunnelRouter(deps: {
  registry: TunnelRegistry
  log: Logger
  /** Filled in after the remote session manager and job bridge are built (a cyclic-construction wiring). */
  onSessionStarted?: (deviceId: string, info: { codec: 'png' | 'h264'; width: number; height: number }) => void
  onSessionFailed?: (deviceId: string, code: string, message: string) => void
  onJobProgress?: (payload: Parameters<NonNullable<TunnelRouterHooks['onJobProgress']>>[0]) => void
  /**
   * `shell.exec.reply` / `shell.stream.reply` (plan 25 §4.1) — wired to
   * `TunnelRpc.handleReply` once the RPC layer exists. Forward-ref, same
   * cyclic-construction pattern as the hooks above (the RPC layer needs the
   * router; the router needs to call back into it).
   */
  onRpcReply?: (msg: { type: string; id?: string; payload: unknown }) => void
  /** `shell.stream.ended` is a PUSH, not a reply to a pending request — dispatched by the stream's own id (plan 25 §4.2). */
  onShellStreamEnded?: (streamId: string, payload: unknown) => void
  /** `adb.ack` (plan 28 §3.3, §4.1) — a delivery acknowledgement, not a reply to a pending request; dispatched by `channelId` so `createRemoteOpenService` can advance the write it is currently withholding an OKAY for. */
  onAdbAck?: (channelId: number, bytes: number) => void
  /** `adb.close` (plan 28 §4.2 point 5) — either side can end an ADB stream first; dispatched by `channelId`. */
  onAdbClose?: (channelId: number, reason: string) => void
}): TunnelRouter {
  const channelIds = createChannelIdAllocator()
  /** channelId → { deviceId, subscribers } */
  const channels = new Map<number, { deviceId: string; kind: string; subscribers: Set<(p: Uint8Array) => void> }>()
  const deviceVideoChannel = new Map<string, number>()

  /** Shared by the CP-initiated close path (`closeChannel`/`subscribeVideo`'s
   * last-unsubscribe) and the node-initiated one (`tunnel.channel.close`
   * inbound) — every path releases the id back to the allocator (plan 25
   * §4.5, §6.6). */
  function releaseChannel(channelId: number): void {
    const ch = channels.get(channelId)
    channels.delete(channelId)
    if (ch && deviceVideoChannel.get(ch.deviceId) === channelId) deviceVideoChannel.delete(ch.deviceId)
    channelIds.release(channelId)
  }

  return {
    handleNodeMessage(ws, nodeId, raw) {
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return
      }
      const parsed = NodeToControlSchema.safeParse(json)
      if (!parsed.success) return // unknown message → ignore it (forward-compatible)
      const msg = parsed.data

      if (msg.type === 'node.hello') {
        const conn = deps.registry.byNode(nodeId)
        if (conn) {
          conn.version = msg.payload.nodeVersion
          conn.platform = msg.payload.platform
        }
        ws.send(
          JSON.stringify({
            type: 'node.hello.ack',
            payload: { nodeId, serverTime: Date.now(), pinnedScrcpyVersion: '3.3.1' },
          }),
        )
      } else if (msg.type === 'node.devices') {
        deps.registry.syncDevices(nodeId, msg.payload.devices)
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
        // The node closed it from its side — still release the id here,
        // otherwise a channel the node proactively drops (rather than the
        // core) would leak forever (plan 25 §4.5, §8 risks).
        releaseChannel(msg.payload.channelId)
      } else if (
        msg.type === 'shell.exec.reply' ||
        msg.type === 'shell.stream.reply' ||
        msg.type === 'clipboard.get.reply' ||
        msg.type === 'clipboard.set.reply' ||
        msg.type === 'adb.open.reply'
      ) {
        deps.onRpcReply?.(msg)
      } else if (msg.type === 'shell.stream.ended') {
        deps.onShellStreamEnded?.(msg.payload.streamId, msg.payload)
      } else if (msg.type === 'adb.ack') {
        deps.onAdbAck?.(msg.payload.channelId, msg.payload.bytes)
      } else if (msg.type === 'adb.close') {
        deps.onAdbClose?.(msg.payload.channelId, msg.payload.reason)
      }
    },

    handleNodeFrame(nodeId, buf) {
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
        deps.log.warn(`no node online for device ${deviceId}`)
        return false
      }
      conn.ws.send(JSON.stringify(msg))
      return true
    },

    openChannel(deviceId, kind) {
      const conn = deps.registry.forDevice(deviceId)
      if (!conn) return null
      const channelId = channelIds.allocate()
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
        // A channel with no viewers is closed on the node (saves encoder and bandwidth).
        if (ch && ch.subscribers.size === 0) {
          const conn = deps.registry.forDevice(deviceId)
          conn?.ws.send(JSON.stringify({ type: 'tunnel.channel.close', payload: { channelId } }))
          releaseChannel(channelId!)
        }
      }
    },

    subscribeChannel(channelId, cb) {
      const channel = channels.get(channelId)
      if (!channel) return () => {}
      channel.subscribers.add(cb)
      return () => channel.subscribers.delete(cb)
    },

    sendFrame(channelId, payload) {
      const channel = channels.get(channelId)
      if (!channel) return
      const conn = deps.registry.forDevice(channel.deviceId)
      conn?.ws.send(encodeTunnelFrame(channelId, payload))
    },

    closeChannel(channelId) {
      const ch = channels.get(channelId)
      if (!ch) return
      const conn = deps.registry.forDevice(ch.deviceId)
      conn?.ws.send(JSON.stringify({ type: 'tunnel.channel.close', payload: { channelId } }))
      releaseChannel(channelId)
    },
  }
}

export { encodeTunnelFrame }
