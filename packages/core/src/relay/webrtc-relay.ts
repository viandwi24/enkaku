import type { ServerWebSocket } from 'bun'
import { createH264Packetizer } from './rtp-h264'
import { iceConfigFromEnv, type RtcPeer, type RtcPeerFactory } from './rtc-peer'
import type { Logger } from '../util/logger'

export interface WebRtcRelay {
  /** The browser requests a WebRTC path for a device. */
  request(ws: ServerWebSocket<unknown>, deviceId: string): Promise<void>
  answer(deviceId: string, sdp: string): Promise<void>
  ice(deviceId: string, candidate: unknown): Promise<void>
  stop(deviceId: string): Promise<void>
  /** Feeds H.264 frames from the source (agent or local) into the active peer. */
  push(deviceId: string, annexB: Uint8Array, ptsUs: bigint): void
  hasPeer(deviceId: string): boolean
  closeAll(): Promise<void>
}

interface PeerEntry {
  peer: RtcPeer
  ws: ServerWebSocket<unknown>
  packetizer: ReturnType<typeof createH264Packetizer>
  releaseSource: () => void
}

/**
 * Relay video WebRTC di control plane (plan 13 §4.3).
 *
 * The flow: H.264 from the device → packetizer (RFC 6184) → peer → SRTP/UDP to
 * the browser. If anything fails the control plane sends `video.webrtc.failed`
 * and Studio returns to the WebSocket path — people keep working, just with the
 * freeze risk already described.
 */
export function createWebRtcRelay(deps: {
  factory: RtcPeerFactory
  log: Logger
  /** Subscribe to a device's frames (from an agent or a local session). */
  subscribeVideo: (deviceId: string, cb: (chunk: Uint8Array, ptsUs: bigint) => void) => () => void
  /** Ask the device for a fresh keyframe (a PLI from the browser). */
  requestKeyframe: (deviceId: string) => void
}): WebRtcRelay {
  const peers = new Map<string, PeerEntry>()

  const send = (ws: ServerWebSocket<unknown>, msg: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  }

  const fail = (ws: ServerWebSocket<unknown>, deviceId: string, reason: string) => {
    deps.log.warn(`webrtc failed for ${deviceId}: ${reason}`)
    send(ws, { type: 'video.webrtc.failed', payload: { deviceId, reason } })
  }

  async function teardown(deviceId: string): Promise<void> {
    const entry = peers.get(deviceId)
    if (!entry) return
    peers.delete(deviceId)
    entry.releaseSource()
    await entry.peer.close().catch(() => undefined)
  }

  return {
    hasPeer: (deviceId) => peers.has(deviceId),

    async request(ws, deviceId) {
      if (!deps.factory.available) {
        fail(ws, deviceId, deps.factory.reason ?? 'no WebRTC backend available')
        return
      }
      await teardown(deviceId)

      try {
        const peer = await deps.factory.create(iceConfigFromEnv())
        const packetizer = createH264Packetizer()

        peer.onIceCandidate((candidate) =>
          send(ws, { type: 'video.webrtc.ice', payload: { deviceId, candidate } }),
        )
        peer.onStateChange((state) => {
          if (state === 'failed') {
            fail(ws, deviceId, 'ICE negotiation failed')
            void teardown(deviceId)
          }
        })
        // The browser lost frames → ask the device for a fresh IDR.
        peer.onKeyframeRequest(() => deps.requestKeyframe(deviceId))

        const releaseSource = deps.subscribeVideo(deviceId, (chunk, ptsUs) => {
          for (const packet of packetizer.push(chunk, ptsUs)) peer.sendRtp(packet)
        })

        peers.set(deviceId, { peer, ws, packetizer, releaseSource })
        const sdp = await peer.createOffer()
        send(ws, { type: 'video.webrtc.offer', payload: { deviceId, sdp } })
      } catch (err) {
        fail(ws, deviceId, err instanceof Error ? err.message : String(err))
        await teardown(deviceId)
      }
    },

    async answer(deviceId, sdp) {
      const entry = peers.get(deviceId)
      if (!entry) return
      try {
        await entry.peer.setRemoteAnswer(sdp)
      } catch (err) {
        fail(entry.ws, deviceId, `the answer was rejected: ${String(err)}`)
        await teardown(deviceId)
      }
    },

    async ice(deviceId, candidate) {
      await peers.get(deviceId)?.peer.addIceCandidate(candidate).catch(() => undefined)
    },

    stop: teardown,

    push(deviceId, annexB, ptsUs) {
      const entry = peers.get(deviceId)
      if (!entry) return
      for (const packet of entry.packetizer.push(annexB, ptsUs)) entry.peer.sendRtp(packet)
    },

    async closeAll() {
      for (const deviceId of [...peers.keys()]) await teardown(deviceId)
    },
  }
}
