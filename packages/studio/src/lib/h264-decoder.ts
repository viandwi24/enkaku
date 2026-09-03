'use client'

/**
 * H.264 decoder for the scrcpy stream (plan 08 §4, instrumented by plan 203 §4.8).
 *
 * WebCodecs `VideoDecoder` (Chromium) is the primary path: hardware
 * accelerated, low latency. Without WebCodecs `isSupported()` returns false
 * and the caller shows a clear message (a wasm fallback is an open question
 * in plan 08).
 *
 * Initialising the decoder needs SPS/PPS: the core sends a config packet
 * first, and resends it on rotation (dimensions change → decoder resets).
 */
export interface H264Renderer {
  /**
   * `keyframe` comes from the wire flag: config packets and IDRs set it.
   * `timing` is the frame's device/host/browser timestamps (plan 203 §4.8) —
   * fed straight into the chunk's own timestamp and, via `onEvent`, into the
   * latency estimator.
   */
  decode(data: Uint8Array, keyframe: boolean, width: number, height: number, timing: FrameTiming): void
  close(): void
}

/** A frame's timestamps as it crosses the socket (plan 203 §4.8). */
export interface FrameTiming {
  ptsUs: bigint
  hostReceivedAt: number
  /** `Date.now()` when the WS binary message reached this browser. */
  browserReceivedAt: number
}

/**
 * One decode/paint cycle, or a dropped chunk (plan 203 §4.8, §4.9). Shaped
 * to match `@enkaku/protocol`'s `LatencyEvent` exactly (structurally, not by
 * import — this file has no reason to depend on the protocol package, and
 * the estimator has no reason to depend on this one).
 */
export type DecodeEvent =
  | {
      kind: 'decoded'
      ptsUs: bigint
      hostReceivedAt: number
      browserReceivedAt: number
      /** `performance.now()` just before `decoder.decode()`. */
      submittedAt: number
      /** `decoder.decodeQueueSize` read just before `decoder.decode()`. */
      queueSize: number
      /** `performance.now()` inside the output callback, before `drawImage`. */
      outputAt: number
      /** The `requestAnimationFrame` timestamp of the first animation frame after `drawImage`. */
      paintedAt: number
    }
  | { kind: 'dropped'; reason: 'awaiting-keyframe' | 'no-decoder' }

export function isWebCodecsSupported(): boolean {
  return typeof window !== 'undefined' && 'VideoDecoder' in window
}

/** Walk the Annex-B start codes and hand back each NAL unit's type and offset. */
function* nalUnits(buf: Uint8Array): Generator<{ type: number; start: number }> {
  for (let i = 0; i + 4 < buf.length; i++) {
    const startCode3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1
    const startCode4 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1
    if (!startCode3 && !startCode4) continue
    const start = i + (startCode4 ? 4 : 3)
    yield { type: (buf[start] ?? 0) & 0x1f, start }
    i = start
  }
}

const NAL_SLICE = 1
const NAL_IDR = 5
const NAL_SPS = 7

/** Extract profile and level from the SPS to build the avc1.PPCCLL codec string. */
function codecStringFromSps(config: Uint8Array): string {
  for (const { type, start } of nalUnits(config)) {
    if (type !== NAL_SPS) continue
    const profile = config[start + 1] ?? 0x42
    const constraints = config[start + 2] ?? 0
    const level = config[start + 3] ?? 0x28
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
  }
  return 'avc1.42e01e' // baseline 3.0 — a safe fallback
}

/** Bounded so a decoder that never outputs a submitted chunk cannot leak (plan 203 §4.8 rule 2). */
const PENDING_LIMIT = 300

export function createH264Renderer(
  canvas: HTMLCanvasElement,
  onError: (msg: string) => void,
  onEvent?: (event: DecodeEvent) => void,
): H264Renderer | null {
  if (!isWebCodecsSupported()) return null

  const ctx = canvas.getContext('2d')
  let decoder: VideoDecoder | null = null
  let configured = false
  let sawKeyframe = false
  let configBytes: Uint8Array | null = null
  let lastCodec = ''
  let pendingDims: { width: number; height: number } = { width: 0, height: 0 }

  // Chunk timestamp (the number handed to EncodedVideoChunk/reported back by
  // VideoDecoder's output) → the timing this renderer submitted it with.
  // `0n` (no device clock) frames use `lastTimestampUs + 1` so WebCodecs
  // still sees a monotonic sequence (plan 203 §3.2 D3).
  const pending = new Map<
    number,
    { ptsUs: bigint; hostReceivedAt: number; browserReceivedAt: number; submittedAt: number; queueSize: number }
  >()
  let lastTimestampUs = 0
  let paintQueue: Array<{
    ptsUs: bigint
    hostReceivedAt: number
    browserReceivedAt: number
    submittedAt: number
    queueSize: number
    outputAt: number
  }> = []
  let rafId = 0

  const makeDecoder = () =>
    new VideoDecoder({
      output: (frame) => {
        const outputAt = performance.now()
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        ctx?.drawImage(frame, 0, 0)
        const p = pending.get(frame.timestamp)
        if (p) {
          pending.delete(frame.timestamp)
          paintQueue.push({ ...p, outputAt })
          if (!rafId) {
            rafId = requestAnimationFrame((t) => {
              for (const s of paintQueue) onEvent?.({ kind: 'decoded', ...s, paintedAt: t })
              paintQueue = []
              rafId = 0
            })
          }
        }
        frame.close()
      },
      error: (err) => onError(String(err)),
    })

  return {
    decode(data, keyframe, width, height, timing) {
      try {
        let hasSps = false
        let hasPicture = false
        for (const { type } of nalUnits(data)) {
          if (type === NAL_SPS) hasSps = true
          else if (type === NAL_IDR || type === NAL_SLICE) hasPicture = true
        }

        if (hasSps) {
          const codec = codecStringFromSps(data)
          // Rotation or a resolution change means the decoder must be reset with the new config.
          const dimensionChanged = pendingDims.width !== width || pendingDims.height !== height
          if (!decoder || codec !== lastCodec || dimensionChanged) {
            decoder?.close()
            decoder = makeDecoder()
            lastCodec = codec
            pendingDims = { width, height }
            decoder.configure({
              codec,
              // Annex-B: with no description, the decoder reads SPS/PPS in-band.
              optimizeForLatency: true,
            })
            configured = true
            sawKeyframe = false
          }
        }

        // scrcpy's config packet is SPS/PPS and nothing else: it paints no
        // pixels, so there is nothing to decode on its own. Keep the bytes —
        // they are needed in-band, see below.
        if (hasSps && !hasPicture) {
          configBytes = new Uint8Array(data)
          return
        }
        if (!hasPicture) return
        if (!decoder || !configured) {
          onEvent?.({ kind: 'dropped', reason: 'no-decoder' })
          return // still waiting for the config packet
        }

        if (!sawKeyframe) {
          // Joining mid-GOP: deltas reference frames this decoder never saw.
          // Drop them rather than error, and start at the first real keyframe.
          if (!keyframe) {
            onEvent?.({ kind: 'dropped', reason: 'awaiting-keyframe' })
            return
          }
          sawKeyframe = true
        }

        // `configure()` is given no `description`, which puts the decoder in
        // Annex-B mode: it expects to read SPS/PPS out of the bitstream itself.
        // scrcpy sends them once, in a separate packet, so a keyframe on its
        // own leaves the decoder with a picture it has no parameter sets for —
        // it then emits no frames and no error, and the canvas simply stays
        // black. Prepending the cached parameter sets to each keyframe is what
        // makes the stream self-describing.
        let payload = data
        if (keyframe && !hasSps && configBytes) {
          payload = new Uint8Array(configBytes.length + data.length)
          payload.set(configBytes, 0)
          payload.set(data, configBytes.length)
        }

        const timestamp = timing.ptsUs > BigInt(0) ? Number(timing.ptsUs) : lastTimestampUs + 1
        lastTimestampUs = timestamp

        const submittedAt = performance.now()
        const queueSize = decoder.decodeQueueSize
        pending.set(timestamp, {
          ptsUs: timing.ptsUs,
          hostReceivedAt: timing.hostReceivedAt,
          browserReceivedAt: timing.browserReceivedAt,
          submittedAt,
          queueSize,
        })
        if (pending.size > PENDING_LIMIT) {
          const oldest = pending.keys().next().value
          if (oldest !== undefined) pending.delete(oldest)
        }

        decoder.decode(
          new EncodedVideoChunk({
            type: keyframe ? 'key' : 'delta',
            timestamp,
            data: payload,
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
        // already closed
      }
      decoder = null
      configured = false
      sawKeyframe = false
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      paintQueue = []
      pending.clear()
    },
  }
}
