import type { RtpPacket } from './rtp-h264'

/**
 * The server-side WebRTC peer abstraction (plan 11 §4.4).
 *
 * The server-side WebRTC library is deliberately NOT hardcoded: the initial recommendation
 * is `werift` (pure TypeScript, in keeping with the self-contained principle),
 * with a GStreamer sidecar as the backup plan should Bun verification fail.
 * This interface keeps the cost of swapping it low.
 */
export interface RtcPeer {
  createOffer(): Promise<string>
  setRemoteAnswer(sdp: string): Promise<void>
  addIceCandidate(candidate: unknown): Promise<void>
  /** Send an RTP packet produced by the H.264 packetizer. */
  sendRtp(packet: RtpPacket): void
  /** RTCP PLI/NACK from the browser → the relay asks the device for a fresh IDR. */
  onKeyframeRequest(cb: () => void): void
  onIceCandidate(cb: (candidate: unknown) => void): void
  onStateChange(cb: (state: 'connecting' | 'connected' | 'failed' | 'closed') => void): void
  close(): Promise<void>
}

export interface RtcPeerFactory {
  readonly available: boolean
  readonly reason?: string
  create(opts: { iceServers: unknown[] }): Promise<RtcPeer>
}

/**
 * The default factory: no WebRTC backend is installed.
 *
 * This is not a silent failure — `available: false` makes the control plane
 * answers `video.webrtc.failed` immediately, and Studio falls back to the
 * WS + WebCodecs path that already works (with a "degraded" badge, because TCP
 * rentan head-of-line blocking di internet).
 */
export const unavailableRtcFactory: RtcPeerFactory = {
  available: false,
  reason:
    'no WebRTC backend is installed in this build — pick a library (werift is recommended) and implement RtcPeerFactory',
  create() {
    return Promise.reject(new Error(unavailableRtcFactory.reason))
  },
}

/** ICE configuration for the browser and the server peer (self-hosted coturn in cloud deployments). */
export function iceConfigFromEnv(): { iceServers: unknown[] } {
  const stun = process.env.ENKAKU_STUN_URL ?? 'stun:stun.l.google.com:19302'
  const turnUrl = process.env.ENKAKU_TURN_URL
  const iceServers: unknown[] = [{ urls: stun }]
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl,
      username: process.env.ENKAKU_TURN_USER,
      credential: process.env.ENKAKU_TURN_PASSWORD,
    })
  }
  return { iceServers }
}
