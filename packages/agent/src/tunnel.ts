import {
  AgentToControlSchema,
  ControlToAgentSchema,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type AgentToControl,
  type ControlToAgent,
} from '@enkaku/protocol'
import type { AgentState } from './state'

export interface TunnelHandlers {
  onMessage(msg: ControlToAgent): void | Promise<void>
  onFrame?(channelId: number, payload: Uint8Array): void
  onConnected?(): void
  onDisconnected?(reason: string): void
}

export interface Tunnel {
  start(): void
  stop(): void
  send(msg: AgentToControl): void
  sendFrame(channelId: number, payload: Uint8Array): void
  isConnected(): boolean
}

const PING_INTERVAL_MS = 20_000
const BACKOFF_CAP_MS = 60_000
/** Koneksi dianggap stabil setelah bertahan selama ini → reset backoff. */
const STABLE_AFTER_MS = 60_000

/**
 * Tunnel outbound agent → control plane (plan 11 §4.2).
 *
 * Outbound berarti tidak perlu port-forward dan tembus NAT: agent yang
 * menghubungi control plane, bukan sebaliknya. Auth pakai credential hasil
 * enrollment; auth gagal TIDAK memicu retry cepat (backoff penuh) supaya
 * kredensial mati tidak membanjiri server.
 */
export function createTunnel(state: AgentState, handlers: TunnelHandlers, log: (msg: string) => void): Tunnel {
  let ws: WebSocket | null = null
  let stopped = true
  let attempt = 0
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let connectedAt = 0

  const wsUrl = `${state.controlPlaneUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/agent/ws`

  function scheduleReconnect(reason: string, authFailure = false): void {
    if (stopped) return
    handlers.onDisconnected?.(reason)
    if (authFailure) attempt = Math.max(attempt, 5) // langsung backoff panjang
    // Full jitter: hindari thundering herd saat control plane baru pulih.
    const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt)
    const delay = Math.random() * base
    attempt += 1
    log(`tunnel putus (${reason}) — reconnect dalam ${Math.round(delay / 1000)}s`)
    setTimeout(connect, delay)
  }

  function connect(): void {
    if (stopped) return
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${state.agentId}.${state.credential}` },
    } as unknown as string[])
    ws = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      connectedAt = Date.now()
      log('tunnel tersambung')
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
          // frame rusak — abaikan, jangan jatuhkan tunnel
        }
        return
      }
      let json: unknown
      try {
        json = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const parsed = ControlToAgentSchema.safeParse(json)
      if (!parsed.success) return // message tak dikenal → abaikan (forward-compat)
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
      // Koneksi yang sempat stabil → mulai backoff dari awal lagi.
      if (Date.now() - connectedAt > STABLE_AFTER_MS) attempt = 0
      scheduleReconnect(`close ${ev.code}`, ev.code === 4401)
    }

    socket.onerror = () => {
      try {
        socket.close()
      } catch {
        // sudah tertutup
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
      const parsed = AgentToControlSchema.safeParse(msg)
      if (!parsed.success || ws?.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(parsed.data))
    },
    sendFrame(channelId, payload) {
      if (ws?.readyState !== WebSocket.OPEN) return
      ws.send(encodeTunnelFrame(channelId, payload))
    },
    isConnected: () => ws?.readyState === WebSocket.OPEN,
  }
}
