/**
 * Packetizer H.264 → RTP (RFC 6184) untuk jalur WebRTC (plan 11 §4.4).
 *
 * Kode ini murni transformasi byte — bisa diuji tanpa WebRTC stack sama
 * sekali, dan tidak terikat library apa pun (lihat `RtcPeer`).
 */

/** MTU aman untuk payload RTP di internet (1200 = konvensi WebRTC). */
export const MAX_PAYLOAD = 1200
/** Clock RTP untuk video = 90 kHz. */
export const RTP_CLOCK_HZ = 90_000

export interface RtpPacket {
  payload: Uint8Array
  timestamp: number
  /** Marker bit = paket terakhir dalam satu access unit. */
  marker: boolean
}

/** Pecah Annex-B (start code 3/4 byte) menjadi NAL unit tanpa start code. */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = []
  let start = -1
  let i = 0
  while (i + 2 < data.length) {
    const is3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1
    const is4 = i + 3 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1
    if (is3 || is4) {
      if (start >= 0) nals.push(data.subarray(start, i))
      i += is4 ? 4 : 3
      start = i
      continue
    }
    i++
  }
  if (start >= 0 && start < data.length) nals.push(data.subarray(start))
  return nals.filter((n) => n.length > 0)
}

export const nalType = (nal: Uint8Array): number => (nal[0] ?? 0) & 0x1f
export const NAL_TYPE = { SPS: 7, PPS: 8, IDR: 5 } as const

/**
 * Satu access unit H.264 → daftar paket RTP.
 * - NAL ≤ MTU → Single NAL Unit Packet (dikirim apa adanya)
 * - NAL > MTU → FU-A: indicator + header dengan bit S (start) dan E (end)
 */
export function packetizeAccessUnit(nals: Uint8Array[], timestampUs: bigint): RtpPacket[] {
  const timestamp = Number((timestampUs * BigInt(RTP_CLOCK_HZ)) / 1_000_000n) >>> 0
  const packets: RtpPacket[] = []

  for (const nal of nals) {
    if (nal.length <= MAX_PAYLOAD) {
      packets.push({ payload: nal, timestamp, marker: false })
      continue
    }
    const header = nal[0] ?? 0
    const nri = header & 0x60
    const type = header & 0x1f
    const body = nal.subarray(1)
    const chunkSize = MAX_PAYLOAD - 2 // ruang untuk FU indicator + FU header
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const chunk = body.subarray(offset, offset + chunkSize)
      const isFirst = offset === 0
      const isLast = offset + chunkSize >= body.length
      const payload = new Uint8Array(2 + chunk.length)
      payload[0] = nri | 28 // FU-A
      payload[1] = (isFirst ? 0x80 : 0) | (isLast ? 0x40 : 0) | type
      payload.set(chunk, 2)
      packets.push({ payload, timestamp, marker: false })
    }
  }

  // Marker bit hanya di paket terakhir access unit.
  const last = packets[packets.length - 1]
  if (last) last.marker = true
  return packets
}

/**
 * Stream H.264 → RTP dengan penyisipan SPS/PPS sebelum tiap IDR.
 * Decoder yang baru bergabung tidak punya parameter set, jadi mengirimnya
 * in-band membuat keyframe berikutnya selalu bisa di-decode.
 */
export function createH264Packetizer(): {
  push(annexB: Uint8Array, timestampUs: bigint): RtpPacket[]
  parameterSets(): { sps: Uint8Array | null; pps: Uint8Array | null }
} {
  let sps: Uint8Array | null = null
  let pps: Uint8Array | null = null

  return {
    parameterSets: () => ({ sps, pps }),
    push(annexB, timestampUs) {
      const nals = splitAnnexB(annexB)
      const out: Uint8Array[] = []
      let hasIdr = false
      for (const nal of nals) {
        const type = nalType(nal)
        if (type === NAL_TYPE.SPS) sps = nal
        else if (type === NAL_TYPE.PPS) pps = nal
        else if (type === NAL_TYPE.IDR) hasIdr = true
        out.push(nal)
      }
      if (hasIdr && sps && pps) {
        const alreadyHasParams = out.some((n) => nalType(n) === NAL_TYPE.SPS)
        if (!alreadyHasParams) out.unshift(sps, pps)
      }
      return out.length > 0 ? packetizeAccessUnit(out, timestampUs) : []
    },
  }
}
