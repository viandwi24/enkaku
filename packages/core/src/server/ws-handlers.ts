import type { ServerWebSocket } from 'bun'
import {
  ClientMessageSchema,
  encodeVideoFrame,
  type FrameMeta,
  type Point,
  type ServerMessage,
} from '@enkaku/protocol'
import type { PairingService } from '../enroll/pairing'
import type { SessionManager } from '../session/manager'
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
  onFrame: (chunk: Uint8Array, meta: FrameMeta) => void
  lastSize: { width: number; height: number }
}

/** State per koneksi WS: stream yang dimiliki koneksi ini. */
interface ConnState {
  streams: Map<number, StreamBinding>
  nextStreamId: number
}

export interface WsHandlerDeps {
  sessions: SessionManager
  pairing: PairingService
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
      s = { streams: new Map(), nextStreamId: 1 }
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
                  send(ws, {
                    type: 'stream.meta',
                    payload: { streamId, width: meta.width, height: meta.height },
                  })
                }
                ws.send(encodeVideoFrame(streamId, meta, chunk))
              },
            }
            const session = await deps.sessions.acquire(msg.payload.deviceId, binding.onFrame)
            state.streams.set(streamId, binding)
            send(ws, {
              type: 'stream.started',
              id: msg.id,
              payload: {
                deviceId: msg.payload.deviceId,
                streamId,
                codec: 'png',
                width: session.frameSize.width,
                height: session.frameSize.height,
              },
            })
            return
          }

          case 'stream.stop': {
            const binding = state.streams.get(msg.payload.streamId)
            if (!binding) return
            state.streams.delete(binding.streamId)
            deps.sessions.release(binding.deviceId, binding.onFrame)
            return
          }

          case 'input.tap':
          case 'input.swipe':
          case 'input.key':
          case 'input.text': {
            const session = deps.sessions.get(msg.payload.deviceId)
            if (!session) {
              sendError(ws, 'E_DEVICE_NOT_READY', 'tidak ada sesi aktif untuk device ini (mulai stream dulu)')
              return
            }
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
        sendError(ws, code, message, 'id' in msg ? msg.id : undefined)
      }
    },

    /** WS putus → semua stream milik koneksi itu auto-release. */
    handleClose(ws: ServerWebSocket<unknown>): void {
      const state = conns.get(ws)
      if (!state) return
      for (const binding of state.streams.values()) {
        deps.sessions.release(binding.deviceId, binding.onFrame)
      }
      state.streams.clear()
    },
  }
}
