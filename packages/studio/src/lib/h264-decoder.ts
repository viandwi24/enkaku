'use client'

/**
 * Decoder H.264 untuk stream scrcpy (plan 08 §4).
 *
 * WebCodecs `VideoDecoder` (Chromium) adalah jalur utama: hardware-accelerated,
 * latency rendah. Browser tanpa WebCodecs → `isSupported()` false dan caller
 * menampilkan pesan jelas (fallback wasm = Open question plan 08).
 *
 * Init decoder butuh SPS/PPS: core mengirim config packet lebih dulu, dan
 * mengirimnya ulang saat rotasi (dimensi berubah → decoder di-reset).
 */
export interface H264Renderer {
  decode(data: Uint8Array, isConfig: boolean, width: number, height: number): void
  close(): void
}

export function isWebCodecsSupported(): boolean {
  return typeof window !== 'undefined' && 'VideoDecoder' in window
}

/** Ekstrak profile/level dari SPS untuk codec string avc1.PPCCLL. */
function codecStringFromSps(config: Uint8Array): string {
  // Cari NAL unit SPS (type 7) dalam Annex-B.
  for (let i = 0; i + 4 < config.length; i++) {
    const startCode3 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1
    const startCode4 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 0 && config[i + 3] === 1
    if (!startCode3 && !startCode4) continue
    const nalStart = i + (startCode4 ? 4 : 3)
    const nalType = (config[nalStart] ?? 0) & 0x1f
    if (nalType !== 7) continue
    const profile = config[nalStart + 1] ?? 0x42
    const constraints = config[nalStart + 2] ?? 0
    const level = config[nalStart + 3] ?? 0x28
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
  }
  return 'avc1.42e01e' // baseline 3.0 — fallback aman
}

export function createH264Renderer(
  canvas: HTMLCanvasElement,
  onError: (msg: string) => void,
): H264Renderer | null {
  if (!isWebCodecsSupported()) return null

  const ctx = canvas.getContext('2d')
  let decoder: VideoDecoder | null = null
  let configured = false
  let lastCodec = ''
  let pending: { width: number; height: number } = { width: 0, height: 0 }

  const makeDecoder = () =>
    new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        ctx?.drawImage(frame, 0, 0)
        frame.close()
      },
      error: (err) => onError(String(err)),
    })

  return {
    decode(data, isConfig, width, height) {
      try {
        if (isConfig) {
          const codec = codecStringFromSps(data)
          // Rotasi/ganti resolusi → decoder harus di-reset dengan config baru.
          const dimensionChanged = pending.width !== width || pending.height !== height
          if (!decoder || codec !== lastCodec || dimensionChanged) {
            decoder?.close()
            decoder = makeDecoder()
            lastCodec = codec
            pending = { width, height }
            decoder.configure({
              codec,
              // Annex-B: tanpa description, decoder membaca SPS/PPS in-band.
              optimizeForLatency: true,
            })
            configured = true
          }
          decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }))
          return
        }
        if (!decoder || !configured) return // menunggu config packet
        decoder.decode(
          new EncodedVideoChunk({
            // Keyframe vs delta ditentukan core lewat urutan paket; kirim
            // sebagai delta kecuali decoder belum pernah menerima key.
            type: 'delta',
            timestamp: performance.now() * 1000,
            data,
          }),
        )
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      }
    },
    close() {
      try {
        decoder?.close()
      } catch {
        // sudah tertutup
      }
      decoder = null
      configured = false
    },
  }
}
