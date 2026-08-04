'use client'

import { ServerMessageSchema, type ClientMessage, type ServerMessage } from '@enkaku/protocol'

export function coreBase(): string {
  const env = process.env.NEXT_PUBLIC_ENKAKU_CORE_URL
  if (env) return env.replace(/\/$/, '')
  if (typeof location !== 'undefined') return location.origin
  return 'http://localhost:7700'
}

type MessageHandler = (msg: ServerMessage) => void
type BinaryHandler = (buf: Uint8Array) => void

/**
 * A single WS client: auto-reconnect with exponential backoff plus
 * resubscribe, request/reply correlated by `id`, every inbound message
 * safeParse'd.
 */
class WsClient {
  private ws: WebSocket | null = null
  private handlers = new Set<MessageHandler>()
  private binaryHandlers = new Set<BinaryHandler>()
  private statusHandlers = new Set<(connected: boolean) => void>()
  private pending = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: unknown) => void }>()
  private queue: string[] = []
  private backoffMs = 500
  private onReconnect = new Set<() => void>()
  private connected = false
  /**
   * This tab's WS connection id, from the `hello` message the core sends
   * right after the socket opens (plan 31 §4.1) — cached here (not just
   * re-dispatched to handlers) so a component mounted after the handshake
   * already completed can still ask synchronously, instead of racing it.
   */
  private sessionId: string | null = null

  connect(): void {
    if (typeof window === 'undefined') return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return

    const url = `${coreBase().replace(/^http/, 'ws')}/ws`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.backoffMs = 500
      this.setConnected(true)
      for (const raw of this.queue.splice(0)) ws.send(raw)
      for (const cb of this.onReconnect) cb()
    }
    ws.onclose = () => {
      this.setConnected(false)
      this.ws = null
      setTimeout(() => this.connect(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 10_000)
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(ev.data)
        for (const cb of this.binaryHandlers) cb(buf)
        return
      }
      let json: unknown
      try {
        json = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const parsed = ServerMessageSchema.safeParse(json)
      if (!parsed.success) {
        // Dropping the message is right — an unvalidated payload must never
        // reach a component. Dropping it *silently* is not: a core running
        // older code than this build sends a shape Studio no longer accepts,
        // and the only symptom is a UI that waits forever for a reply that
        // was already thrown away. Say so, so the next person does not spend
        // an afternoon on it.
        if (process.env.NODE_ENV !== 'production') {
          const type = typeof json === 'object' && json !== null && 'type' in json ? String(json.type) : '<unknown>'
          console.warn(`[enkaku] dropped a "${type}" message the schema rejected — is the core running older code?`, parsed.error.issues)
        }
        return
      }
      const msg = parsed.data
      if (msg.type === 'hello') this.sessionId = msg.payload.sessionId
      const id = 'id' in msg ? msg.id : undefined
      if (id) {
        const waiter = this.pending.get(id)
        if (waiter) {
          this.pending.delete(id)
          if (msg.type === 'error') waiter.reject(new Error(msg.payload.message))
          else waiter.resolve(msg)
          return
        }
      }
      for (const cb of this.handlers) cb(msg)
    }
  }

  private setConnected(v: boolean): void {
    this.connected = v
    for (const cb of this.statusHandlers) cb(v)
  }

  isConnected(): boolean {
    return this.connected
  }

  /** This tab's current session id, or null before the first `hello` arrives. */
  getSessionId(): string | null {
    return this.sessionId
  }

  send(msg: ClientMessage): void {
    const raw = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw)
    else {
      this.queue.push(raw)
      this.connect()
    }
  }

  request(msg: ClientMessage & { id: string }, timeoutMs = 25_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id)
        reject(new Error('timeout menunggu balasan core'))
      }, timeoutMs)
      this.pending.set(msg.id, {
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.send(msg)
    })
  }

  on(cb: MessageHandler): () => void {
    this.handlers.add(cb)
    this.connect()
    return () => this.handlers.delete(cb)
  }

  onBinary(cb: BinaryHandler): () => void {
    this.binaryHandlers.add(cb)
    this.connect()
    return () => this.binaryHandlers.delete(cb)
  }

  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusHandlers.add(cb)
    cb(this.connected)
    return () => this.statusHandlers.delete(cb)
  }

  /** Fires whenever the connection is (re)established — used to resubscribe streams. */
  onReconnected(cb: () => void): () => void {
    this.onReconnect.add(cb)
    return () => this.onReconnect.delete(cb)
  }
}

export const ws = new WsClient()
export const newId = (): string => crypto.randomUUID()
