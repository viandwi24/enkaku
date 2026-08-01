import type { ServerWebSocket } from 'bun'
import {
  ClientMessageSchema,
  encodeVideoFrame,
  type FrameMeta,
  type Point,
  type ServerMessage,
} from '@enkaku/protocol'
import type { PairingService } from '../enroll/pairing'
import type { LeaseManager } from '../lease/lease-manager'
import type { SessionManager } from '@enkaku/session'
import type { JobService } from '../services/job-service'
import type { Logger } from '../util/logger'

/** Batas backpressure: lewat ini frame di-skip (frame terbaru saja yang penting). */
const MAX_BUFFERED = 4 * 1024 * 1024

/** Normalisasi 0..1 → pixel device, pakai dimensi frame TERBARU (rotasi). */
export function mapNormToDevice(pos: { x: number; y: number }, frame: { width: number; height: number }): Point {
  const clamp = (v: number, max: number) => Math.min(Math.max(max, 0), Math.max(0, v))
  return {
    x: clamp(Math.round(pos.x * frame.width), frame.width - 1),
    y: clamp(Math.round(pos.y * frame.height), frame.height - 1),
  }
}

interface StreamBinding {
  streamId: number
  deviceId: string
  remote?: boolean
  onFrame: (chunk: Uint8Array, meta: FrameMeta) => void
  lastSize: { width: number; height: number }
}

/** State per koneksi WS: clientId + stream yang dimiliki koneksi ini. */
interface ConnState {
  clientId: string
  streams: Map<number, StreamBinding>
  nextStreamId: number
}

export interface RemoteSessions {
  agentIdFor(deviceId: string): string | null
  acquire(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): Promise<{
    frameSize: { width: number; height: number }
    codec: 'png' | 'h264'
    input: { tap(p: Point): Promise<void>; swipe(f: Point, t: Point, ms: number): Promise<void>; key(c: number): Promise<void>; text(s: string): Promise<void> }
  }>
  release(deviceId: string, onFrame: (chunk: Uint8Array, meta: FrameMeta) => void): void
  get(deviceId: string): { frameSize: { width: number; height: number }; input: { tap(p: Point): Promise<void>; swipe(f: Point, t: Point, ms: number): Promise<void>; key(c: number): Promise<void>; text(s: string): Promise<void> } } | null
}

export interface WsHandlerDeps {
  /** null di mode orchestrator: control plane tidak memegang device lokal. */
  sessions: SessionManager | null
  /** Sesi device milik agent (mode cloud); null di mode lokal murni. */
  remote?: RemoteSessions
  pairing: PairingService
  leases: LeaseManager
  jobs: JobService
  log: Logger
}

export function createWsMessageHandler(deps: WsHandlerDeps) {
  const conns = new WeakMap<ServerWebSocket<unknown>, ConnState>()

  const send = (ws: ServerWebSocket<unknown>, msg: ServerMessage) => ws.send(JSON.stringify(msg))
  const sendError = (ws: ServerWebSocket<unknown>, code: string, message: string, id?: string) =>
    send(ws, { type: 'error', ...(id ? { id } : {}), payload: { code, message } })

  const stateOf = (ws: ServerWebSocket<unknown>): ConnState => {
    let s = conns.get(ws)
    if (!s) {
      s = { clientId: crypto.randomUUID(), streams: new Map(), nextStreamId: 1 }
      conns.set(ws, s)
    }
    return s
  }

  return {
    async handleMessage(ws: ServerWebSocket<unknown>, raw: string): Promise<void> {
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        sendError(ws, 'E_BAD_MESSAGE', 'payload bukan JSON')
        return
      }
      const parsed = ClientMessageSchema.safeParse(json)
      if (!parsed.success) {
        sendError(ws, 'E_BAD_MESSAGE', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
        return
      }
      const msg = parsed.data
      const state = stateOf(ws)
      const msgId = 'id' in msg ? msg.id : undefined

      try {
        switch (msg.type) {
          case 'stream.start': {
            const streamId = state.nextStreamId++ & 0xff
            const binding: StreamBinding = {
              streamId,
              deviceId: msg.payload.deviceId,
              lastSize: { width: 0, height: 0 },
              onFrame: (chunk, meta) => {
                if (ws.readyState !== 1) return
                if (ws.getBufferedAmount() > MAX_BUFFERED) return // backpressure: skip frame
                if (meta.width !== binding.lastSize.width || meta.height !== binding.lastSize.height) {
                  binding.lastSize = { width: meta.width, height: meta.height }
                  send(ws, { type: 'stream.meta', payload: { streamId, width: meta.width, height: meta.height } })
                }
                ws.send(encodeVideoFrame(streamId, meta, chunk))
              },
            }
            // Video tetap jalan walau device `busy` (spec §10.1) — hanya
            // input yang di-reject.
            const remoteAgent = deps.remote?.agentIdFor(msg.payload.deviceId) ?? null
            let codec: 'png' | 'h264'
            let frameSize: { width: number; height: number }
            if (remoteAgent) {
              const remoteSession = await deps.remote!.acquire(msg.payload.deviceId, binding.onFrame)
              codec = remoteSession.codec
              frameSize = remoteSession.frameSize
              binding.remote = true
            } else if (deps.sessions) {
              const session = await deps.sessions.acquire(msg.payload.deviceId, binding.onFrame)
              codec = session.displayEngineId === 'scrcpy' ? 'h264' : 'png'
              frameSize = session.frameSize
            } else {
              // Device tidak dimiliki agent mana pun DAN tidak ada sesi lokal.
              sendError(
                ws,
                'device_not_reachable',
                'device tidak terhubung ke control plane ini maupun ke agent mana pun',
                msg.id,
              )
              return
            }
            send(ws, {
              type: 'stream.started',
              id: msg.id,
              payload: {
                deviceId: msg.payload.deviceId,
                streamId,
                codec,
                width: frameSize.width,
                height: frameSize.height,
              },
            })
            // Viewer baru butuh SPS/PPS sebelum frame pertama bisa di-decode.
            const localSession = remoteAgent ? null : (deps.sessions?.get(msg.payload.deviceId) ?? null)
            const config = localSession?.videoConfig?.()
            if (config) {
              ws.send(
                encodeVideoFrame(
                  streamId,
                  { width: frameSize.width, height: frameSize.height, codec: 'h264', seq: 0, capturedAt: Date.now() },
                  config,
                ),
              )
            }
            return
          }

          case 'stream.stop': {
            const binding = state.streams.get(msg.payload.streamId)
            if (!binding) return
            state.streams.delete(binding.streamId)
            if (binding.remote) deps.remote?.release(binding.deviceId, binding.onFrame)
            else deps.sessions?.release(binding.deviceId, binding.onFrame)
            return
          }

          case 'lease.acquire': {
            const lease = deps.leases.acquireManual(msg.payload.deviceId, state.clientId)
            send(ws, {
              type: 'lease.acquired',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId: lease.deviceId, expiresAt: lease.expiresAt },
            })
            return
          }

          case 'lease.release': {
            deps.leases.releaseManual(msg.payload.deviceId, state.clientId)
            send(ws, {
              type: 'lease.released',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId: msg.payload.deviceId },
            })
            return
          }

          case 'input.tap':
          case 'input.swipe':
          case 'input.key':
          case 'input.text': {
            // Server-authoritative: lease & status divalidasi di sini,
            // bukan sekadar UI di-disable (spec §10.1).
            const allowed = deps.leases.checkInputAllowed(msg.payload.deviceId, state.clientId)
            if (!allowed.ok) {
              sendError(ws, allowed.code, allowed.message, msgId)
              return
            }
            const remoteAgent = deps.remote?.agentIdFor(msg.payload.deviceId) ?? null
            const session = remoteAgent
              ? deps.remote!.get(msg.payload.deviceId)
              : (deps.sessions?.get(msg.payload.deviceId) ?? null)
            if (!session) {
              sendError(
                ws,
                remoteAgent ? 'agent_offline' : 'E_DEVICE_NOT_READY',
                remoteAgent
                  ? 'device dipegang agent yang sedang tidak terhubung'
                  : 'tidak ada sesi aktif untuk device ini (mulai stream dulu)',
                msgId,
              )
              return
            }
            deps.leases.touchManual(msg.payload.deviceId, state.clientId)
            if (msg.type === 'input.tap') {
              await session.input.tap(mapNormToDevice(msg.payload.pos, session.frameSize))
            } else if (msg.type === 'input.swipe') {
              await session.input.swipe(
                mapNormToDevice(msg.payload.from, session.frameSize),
                mapNormToDevice(msg.payload.to, session.frameSize),
                msg.payload.durationMs,
              )
            } else if (msg.type === 'input.key') {
              await session.input.key(msg.payload.keycode)
            } else {
              await session.input.text(msg.payload.text)
            }
            return
          }

          case 'job.enqueue': {
            const info = deps.jobs.enqueue({
              scriptId: msg.payload.scriptId,
              deviceId: msg.payload.deviceId,
              params: msg.payload.params,
              priority: msg.payload.priority,
            })
            send(ws, { type: 'job.status', payload: info })
            return
          }

          case 'job.cancel': {
            const info = deps.jobs.cancel(msg.payload.jobId)
            send(ws, { type: 'job.status', payload: info })
            return
          }

          case 'device.pairing.request': {
            const res = await deps.pairing.request(msg.payload.host, msg.payload.port)
            send(ws, { type: 'device.pairing.request.result', id: msg.id, payload: res })
            return
          }

          case 'device.pairing.code': {
            const res = await deps.pairing.submitCode(msg.payload.pairingId, msg.payload.code, msg.payload.connectPort)
            send(ws, { type: 'device.pairing.code.result', id: msg.id, payload: res })
            return
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'E_INTERNAL'
        deps.log.warn(`handler ${msg.type} gagal: ${message}`)
        sendError(ws, code, message, msgId)
      }
    },

    /** WS putus → stream & lease manual milik koneksi itu auto-release. */
    handleClose(ws: ServerWebSocket<unknown>): void {
      const state = conns.get(ws)
      if (!state) return
      for (const binding of state.streams.values()) {
        if (binding.remote) deps.remote?.release(binding.deviceId, binding.onFrame)
        else deps.sessions?.release(binding.deviceId, binding.onFrame)
      }
      state.streams.clear()
      deps.leases.releaseAllForClient(state.clientId)
    },
  }
}
