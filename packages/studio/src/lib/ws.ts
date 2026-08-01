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
 * WS client tunggal: auto-reconnect exponential backoff + resubscribe,
 * request/reply berkorelasi `id`, semua message masuk di-safeParse.
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
      if (!parsed.success) return
      const msg = parsed.data
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

  /** Dipanggil tiap koneksi (re)established — untuk resubscribe stream. */
  onReconnected(cb: () => void): () => void {
    this.onReconnect.add(cb)
    return () => this.onReconnect.delete(cb)
  }
}

export const ws = new WsClient()
export const newId = (): string => crypto.randomUUID()
