'use client'

import { newId, ws } from './ws'

/**
 * WebRTC client for device video in cloud mode (plan 11 §4.4).
 *
 * Why it exists: the WebSocket tunnel runs over TCP. On the open internet a
 * single lost packet holds up the whole stream until it is retransmitted —
 * during remote control that shows up as frozen video. WebRTC (UDP) avoids it.
 *
 * If negotiation fails (no TURN, no WebRTC backend installed, ICE failure, or
 * no frame within 10 seconds) the player **falls back to the WS + WebCodecs
 * path** that already works — degraded, not dead.
 */
export type PlayerState = 'connecting' | 'webrtc' | 'ws-fallback' | 'failed'

export interface WebRtcPlayer {
  start(): Promise<void>
  stop(): void
  state(): PlayerState
}

const NO_FRAME_TIMEOUT_MS = 10_000

export function createWebRtcPlayer(opts: {
  deviceId: string
  video: HTMLVideoElement
  onState: (state: PlayerState, reason?: string) => void
  /** Fires when WebRTC gives up — the caller switches on the WS path. */
  onFallback: (reason: string) => void
}): WebRtcPlayer {
  let pc: RTCPeerConnection | null = null
  let state: PlayerState = 'connecting'
  let frameTimer: ReturnType<typeof setTimeout> | null = null
  let offMessage: (() => void) | null = null

  const setState = (next: PlayerState, reason?: string) => {
    state = next
    opts.onState(next, reason)
  }

  const fallback = (reason: string) => {
    if (state === 'ws-fallback') return
    setState('ws-fallback', reason)
    cleanup()
    opts.onFallback(reason)
  }

  function cleanup() {
    if (frameTimer) clearTimeout(frameTimer)
    frameTimer = null
    offMessage?.()
    offMessage = null
    pc?.close()
    pc = null
  }

  return {
    state: () => state,

    async start() {
      setState('connecting')
      let iceServers: RTCIceServer[] = []
      try {
        const res = await fetch('/api/nodes/ice-config')
        iceServers = ((await res.json()) as { iceServers: RTCIceServer[] }).iceServers
      } catch {
        // Without STUN/TURN the connection only succeeds on the same network.
      }

      pc = new RTCPeerConnection({ iceServers })
      pc.ontrack = (ev) => {
        opts.video.srcObject = ev.streams[0] ?? new MediaStream([ev.track])
        setState('webrtc')
        if (frameTimer) clearTimeout(frameTimer)
      }
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          ws.send({
            type: 'video.webrtc.ice',
            payload: { deviceId: opts.deviceId, candidate: ev.candidate.toJSON() },
          } as never)
        }
      }
      pc.onconnectionstatechange = () => {
        if (pc?.connectionState === 'failed') fallback('the ICE connection failed')
      }

      offMessage = ws.on((msg) => {
        if (msg.type === 'video.webrtc.offer' && msg.payload.deviceId === opts.deviceId) {
          void (async () => {
            if (!pc) return
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp })
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            ws.send({
              type: 'video.webrtc.answer',
              payload: { deviceId: opts.deviceId, sdp: answer.sdp ?? '' },
            } as never)
          })()
        } else if (msg.type === 'video.webrtc.ice' && msg.payload.deviceId === opts.deviceId) {
          void pc?.addIceCandidate(msg.payload.candidate as RTCIceCandidateInit).catch(() => undefined)
        } else if (msg.type === 'video.webrtc.failed' && msg.payload.deviceId === opts.deviceId) {
          fallback(msg.payload.reason)
        }
      })

      ws.send({ type: 'video.webrtc.request', id: newId(), payload: { deviceId: opts.deviceId } } as never)
      frameTimer = setTimeout(() => fallback('no frames within 10 seconds'), NO_FRAME_TIMEOUT_MS)
    },

    stop() {
      ws.send({ type: 'video.webrtc.stop', payload: { deviceId: opts.deviceId } } as never)
      cleanup()
    },
  }
}
