import {
  NodeToControlSchema,
  ControlToNodeSchema,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type NodeToControl,
  type ControlToNode,
} from '@enkaku/protocol'
import type { NodeState } from './state'

export interface TunnelHandlers {
  onMessage(msg: ControlToNode): void | Promise<void>
  onFrame?(channelId: number, payload: Uint8Array): void
  onConnected?(): void
  onDisconnected?(reason: string): void
}

export interface Tunnel {
  start(): void
  stop(): void
  send(msg: NodeToControl): void
  sendFrame(channelId: number, payload: Uint8Array): void
  isConnected(): boolean
  /** The underlying WS's own outbound backlog (bytes) — the node-side half of backpressure (plan 25 §3.5, §4.4): a shell stream watches this before batching more data. 0 when disconnected. */
  bufferedAmount(): number
}

const PING_INTERVAL_MS = 20_000
const BACKOFF_CAP_MS = 60_000
/** A connection counts as stable after surviving this long → reset the backoff. */
const STABLE_AFTER_MS = 60_000

/**
 * Tunnel outbound node → control plane (plan 11 §4.2).
 *
 * Outbound means no port forwarding and no trouble with NAT: the node
 * dials the control plane, never the other way round. Auth uses the credential from
 * enrollment; an auth failure does NOT trigger a fast retry (it takes the full
 * backoff) so a dead credential cannot flood the server.
 */
export function createTunnel(state: NodeState, handlers: TunnelHandlers, log: (msg: string) => void): Tunnel {
  let ws: WebSocket | null = null
  let stopped = true
  let attempt = 0
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let connectedAt = 0

  const wsUrl = `${state.controlPlaneUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/node/ws`

  function scheduleReconnect(reason: string, authFailure = false): void {
    if (stopped) return
    handlers.onDisconnected?.(reason)
    if (authFailure) attempt = Math.max(attempt, 5) // jump straight to a long backoff
    // Full jitter: avoids a thundering herd when the control plane recovers.
    const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt)
    const delay = Math.random() * base
    attempt += 1
    log(`tunnel dropped (${reason}) — reconnecting in ${Math.round(delay / 1000)}s`)
    setTimeout(connect, delay)
  }

  function connect(): void {
    if (stopped) return
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${state.nodeId}.${state.credential}` },
    } as unknown as string[])
    ws = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      connectedAt = Date.now()
      log('tunnel connected')
      handlers.onConnected?.()
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'tunnel.ping', payload: { t: Date.now() } }))
        }
      }, PING_INTERVAL_MS)
    }

    socket.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        try {
          const { channelId, payload } = decodeTunnelFrame(new Uint8Array(ev.data))
          handlers.onFrame?.(channelId, payload)
        } catch {
          // a corrupt frame — ignore it, do not drop the tunnel
        }
        return
      }
      let json: unknown
      try {
        json = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const parsed = ControlToNodeSchema.safeParse(json)
      if (!parsed.success) return // unknown message → ignore it (forward-compatible)
      if (parsed.data.type === 'tunnel.ping') {
        socket.send(JSON.stringify({ type: 'tunnel.pong', payload: parsed.data.payload }))
        return
      }
      void handlers.onMessage(parsed.data)
    }

    socket.onclose = (ev) => {
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      ws = null
      // A connection that had gone stable → start the backoff over.
      if (Date.now() - connectedAt > STABLE_AFTER_MS) attempt = 0
      scheduleReconnect(`close ${ev.code}`, ev.code === 4401)
    }

    socket.onerror = () => {
      try {
        socket.close()
      } catch {
        // already closed
      }
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      connect()
    },
    stop() {
      stopped = true
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      ws?.close()
      ws = null
    },
    send(msg) {
      const parsed = NodeToControlSchema.safeParse(msg)
      if (!parsed.success || ws?.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(parsed.data))
    },
    sendFrame(channelId, payload) {
      if (ws?.readyState !== WebSocket.OPEN) return
      ws.send(encodeTunnelFrame(channelId, payload))
    },
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    bufferedAmount: () => ws?.bufferedAmount ?? 0,
  }
}
