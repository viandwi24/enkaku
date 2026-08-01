import type { RtpPacket } from './rtp-h264'

/**
 * Abstraksi peer WebRTC sisi server (plan 11 §4.4).
 *
 * Library WebRTC server-side sengaja TIDAK di-hardcode: rekomendasi awal
 * adalah `werift` (pure TypeScript, selaras dengan prinsip self-contained),
 * dengan sidecar GStreamer sebagai rencana cadangan bila verifikasi di Bun
 * gagal. Interface ini menjaga biaya penggantian tetap murah.
 */
export interface RtcPeer {
  createOffer(): Promise<string>
  setRemoteAnswer(sdp: string): Promise<void>
  addIceCandidate(candidate: unknown): Promise<void>
  /** Kirim paket RTP hasil packetizer H.264. */
  sendRtp(packet: RtpPacket): void
  /** RTCP PLI/NACK dari browser → relay minta IDR baru ke device. */
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
 * Factory default: belum ada backend WebRTC yang terpasang.
 *
 * Ini bukan kegagalan diam-diam — `available: false` membuat control plane
 * langsung menjawab `video.webrtc.failed`, dan Studio jatuh ke jalur
 * WS+WebCodecs yang sudah bekerja (dengan badge "degraded", karena TCP
 * rentan head-of-line blocking di internet).
 */
export const unavailableRtcFactory: RtcPeerFactory = {
  available: false,
  reason:
    'backend WebRTC belum dipasang di build ini — pilih library (rekomendasi: werift) dan implement RtcPeerFactory',
  create() {
    return Promise.reject(new Error(unavailableRtcFactory.reason))
  },
}

/** Konfigurasi ICE untuk browser & peer server (coturn self-host di deployment cloud). */
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
