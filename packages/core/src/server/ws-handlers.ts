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

/** Backpressure limit: past this, frames are dropped (only the newest one matters). */
const MAX_BUFFERED = 4 * 1024 * 1024

/** Normalised 0..1 → device pixels, using the LATEST frame dimensions (rotation). */
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

/** Per-connection WS state: the clientId and the streams this connection owns. */
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

export interface WebRtcSignaling {
  request(ws: ServerWebSocket<unknown>, deviceId: string): Promise<void>
  answer(deviceId: string, sdp: string): Promise<void>
  ice(deviceId: string, candidate: unknown): Promise<void>
  stop(deviceId: string): Promise<void>
}

export interface WsHandlerDeps {
  /** The WebRTC video path (cloud mode); unused on a LAN. */
  webrtc?: WebRtcSignaling
  /** null under the orchestrator: the control plane holds no local devices. */
  sessions: SessionManager | null
  /** Sessions for agent-owned devices (cloud mode); null in pure local mode. */
  remote?: RemoteSessions
  pairing: PairingService
  leases: LeaseManager
  jobs: JobService
  /** Fan a message out to every connected client, not just the sender. */
  broadcast: (msg: ServerMessage) => void
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
        sendError(ws, 'E_BAD_MESSAGE', 'the payload is not JSON')
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
            // Video keeps running even while a device is `busy` (spec §10.1) —
            // only input is rejected.
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
              // The device belongs to no agent AND there is no local session.
              sendError(
                ws,
                'device_not_reachable',
                'the device is connected neither to this control plane nor to any agent',
                msg.id,
              )
              return
            }
            // Recorded AFTER acquire succeeds: if acquire throws, no binding is
            // left behind with no session under it. Without this line,
            // stream.stop and the disconnect cleanup do nothing at all — the
            // capture loop keeps running on the device forever.
            state.streams.set(streamId, binding)
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
            // A new viewer needs SPS/PPS to configure its decoder, and then a
            // keyframe to actually paint something. Sending only the config
            // leaves the canvas black until the encoder's next IDR — seconds
            // later — and the browser rejects the deltas that arrive meanwhile
            // ("a key frame is required after configure()").
            const localSession = remoteAgent ? null : (deps.sessions?.get(msg.payload.deviceId) ?? null)
            const primer: FrameMeta = {
              width: frameSize.width,
              height: frameSize.height,
              codec: 'h264',
              seq: 0,
              capturedAt: Date.now(),
              keyframe: true,
            }
            const config = localSession?.videoConfig?.()
            if (config) ws.send(encodeVideoFrame(streamId, primer, config))
            const keyframe = localSession?.videoKeyframe?.()
            if (keyframe) ws.send(encodeVideoFrame(streamId, primer, keyframe))
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
            // Everyone else watching this device needs to know it is being
            // driven now, so their page stops offering control it cannot get.
            deps.broadcast({
              type: 'lease.changed',
              payload: { deviceId: lease.deviceId, held: true, expiresAt: lease.expiresAt },
            })
            return
          }

          case 'lease.release': {
            const released = deps.leases.releaseManual(msg.payload.deviceId, state.clientId)
            send(ws, {
              type: 'lease.released',
              ...(msgId ? { id: msgId } : {}),
              payload: { deviceId: msg.payload.deviceId },
            })
            if (released) {
              deps.broadcast({
                type: 'lease.changed',
                payload: { deviceId: msg.payload.deviceId, held: false, expiresAt: null },
              })
            }
            return
          }

          case 'input.tap':
          case 'input.swipe':
          case 'input.key':
          case 'input.text': {
            // Server-authoritative: the lease and status are validated here,
            // not merely disabled in the UI (spec §10.1).
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
                  ? 'the device belongs to an agent that is currently disconnected'
                  : 'no active session for this device (start the stream first)',
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

          case 'video.webrtc.request': {
            if (!deps.webrtc) {
              send(ws, {
                type: 'video.webrtc.failed',
                payload: { deviceId: msg.payload.deviceId, reason: 'the WebRTC path is not active in this mode' },
              })
              return
            }
            await deps.webrtc.request(ws, msg.payload.deviceId)
            return
          }

          case 'video.webrtc.answer': {
            await deps.webrtc?.answer(msg.payload.deviceId, msg.payload.sdp)
            return
          }

          case 'video.webrtc.ice': {
            await deps.webrtc?.ice(msg.payload.deviceId, msg.payload.candidate)
            return
          }

          case 'video.webrtc.stop': {
            await deps.webrtc?.stop(msg.payload.deviceId)
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
        deps.log.warn(`handler ${msg.type} failed: ${message}`)
        sendError(ws, code, message, msgId)
      }
    },

    /** WS dropped → this connection's streams and manual leases auto-release. */
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
