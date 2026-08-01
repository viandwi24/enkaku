import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket as WeriftRtpPacket,
} from 'werift'
import type { RtcPeer, RtcPeerFactory } from './rtc-peer'

/**
 * Backend WebRTC berbasis werift (plan 13 §3.2).
 *
 * werift dipilih karena TypeScript murni — tidak ada binding native yang
 * harus cocok dengan ABI runtime. Kompatibilitasnya dengan Bun sudah diuji:
 * pembuatan offer, fingerprint DTLS, pengumpulan kandidat ICE, dan injeksi
 * RTP mentah semuanya berfungsi.
 *
 * Bila di kemudian hari werift gagal pada beban nyata, penggantiannya murah:
 * seluruh sisa kode hanya mengenal antarmuka `RtcPeer`.
 */
const H264_PAYLOAD_TYPE = 96

function h264Codec(): RTCRtpCodecParameters {
  return new RTCRtpCodecParameters({
    mimeType: 'video/H264',
    clockRate: 90_000,
    payloadType: H264_PAYLOAD_TYPE,
    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
    // packetization-mode=1 wajib: kita mengirim FU-A untuk NAL besar.
    parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  })
}

export function createWeriftFactory(): RtcPeerFactory {
  return {
    available: true,

    async create({ iceServers }) {
      const pc = new RTCPeerConnection({
        iceServers: iceServers as never,
        codecs: { video: [h264Codec()] },
      })
      const track = new MediaStreamTrack({ kind: 'video' })
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' })

      let sequenceNumber = Math.floor(Math.random() * 0xffff)
      const ssrc = Math.floor(Math.random() * 0xffffffff)
      const keyframeHandlers = new Set<() => void>()
      const iceHandlers = new Set<(candidate: unknown) => void>()
      const stateHandlers = new Set<(s: 'connecting' | 'connected' | 'failed' | 'closed') => void>()

      pc.onIceCandidate.subscribe((candidate) => {
        for (const cb of iceHandlers) cb(candidate)
      })
      pc.connectionStateChange.subscribe((state) => {
        const mapped =
          state === 'connected'
            ? 'connected'
            : state === 'failed'
              ? 'failed'
              : state === 'closed'
                ? 'closed'
                : 'connecting'
        for (const cb of stateHandlers) cb(mapped)
      })
      // PLI/NACK dari browser = permintaan keyframe baru.
      transceiver.sender.onRtcp.subscribe(() => {
        for (const cb of keyframeHandlers) cb()
      })

      const peer: RtcPeer = {
        async createOffer() {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          return pc.localDescription?.sdp ?? offer.sdp
        },

        async setRemoteAnswer(sdp) {
          await pc.setRemoteDescription({ type: 'answer', sdp })
        },

        async addIceCandidate(candidate) {
          await pc.addIceCandidate(candidate as never)
        },

        sendRtp(packet) {
          // Nomor urut dipegang peer: satu koneksi = satu ruang nomor urut.
          const header = new RtpHeader({
            payloadType: H264_PAYLOAD_TYPE,
            sequenceNumber: sequenceNumber++ & 0xffff,
            timestamp: packet.timestamp,
            marker: packet.marker,
            ssrc,
          })
          track.writeRtp(new WeriftRtpPacket(header, Buffer.from(packet.payload)))
        },

        onKeyframeRequest(cb) {
          keyframeHandlers.add(cb)
        },
        onIceCandidate(cb) {
          iceHandlers.add(cb)
        },
        onStateChange(cb) {
          stateHandlers.add(cb)
        },

        async close() {
          await pc.close().catch(() => undefined)
        },
      }

      return peer
    },
  }
}
