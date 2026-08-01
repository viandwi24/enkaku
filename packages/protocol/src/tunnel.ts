import { z } from 'zod'
import { DeviceInfoSchema } from './device'
import { PointSchema } from './ui-node'

/**
 * Protokol tunnel agent ⇄ control plane (plan 11 §4.2).
 *
 * Envelope diperluas dengan field routing; message lokal tanpa field ini
 * tetap valid, jadi mode local (Plan 01–09) tidak berubah sama sekali.
 */
export const RoutedEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.string(),
  id: z.string().optional(),
  /** Diisi control plane saat merutekan ke/dari agent. */
  agentId: z.string().optional(),
  deviceId: z.string().optional(),
  /** Server-side only — agent/browser tidak boleh menetapkannya. */
  tenantId: z.string().optional(),
  payload: z.unknown(),
})
export type RoutedEnvelope = z.infer<typeof RoutedEnvelopeSchema>

// ---- agent → control plane ----

export const AgentHelloMessage = z.object({
  type: z.literal('agent.hello'),
  payload: z.object({
    agentVersion: z.string(),
    platform: z.string(),
    toolVersions: z.record(z.string(), z.string()),
  }),
})

export const AgentDevicesMessage = z.object({
  type: z.literal('agent.devices'),
  payload: z.object({ devices: z.array(DeviceInfoSchema) }),
})

// ---- control plane → agent ----

export const AgentHelloAckMessage = z.object({
  type: z.literal('agent.hello.ack'),
  payload: z.object({
    agentId: z.string(),
    serverTime: z.number().int(),
    pinnedScrcpyVersion: z.string(),
  }),
})

export const SessionStartMessage = z.object({
  type: z.literal('session.start'),
  payload: z.object({
    deviceId: z.string(),
    engines: z.object({
      transport: z.string().optional(),
      display: z.string().optional(),
      input: z.string().optional(),
      inspection: z.string().optional(),
    }),
  }),
})

export const SessionStopMessage = z.object({
  type: z.literal('session.stop'),
  payload: z.object({ deviceId: z.string() }),
})

export const JobDispatchMessage = z.object({
  type: z.literal('job.dispatch'),
  payload: z.object({
    jobId: z.string(),
    deviceId: z.string(),
    /** Bundle dikirim inline atau via URL (control plane yang menentukan). */
    bundle: z.string().optional(),
    bundleUrl: z.string().optional(),
    params: z.unknown(),
  }),
})

// ---- dua arah ----

export const TunnelPingMessage = z.object({
  type: z.literal('tunnel.ping'),
  payload: z.object({ t: z.number() }),
})

export const TunnelPongMessage = z.object({
  type: z.literal('tunnel.pong'),
  payload: z.object({ t: z.number() }),
})

/** Alokasi channel binary dinamis: satu tunnel membawa banyak device. */
export const TunnelChannelOpenMessage = z.object({
  type: z.literal('tunnel.channel.open'),
  payload: z.object({
    channelId: z.number().int().min(0).max(65535),
    deviceId: z.string(),
    kind: z.enum(['video', 'audio', 'control-raw']),
  }),
})

export const TunnelChannelCloseMessage = z.object({
  type: z.literal('tunnel.channel.close'),
  payload: z.object({ channelId: z.number().int() }),
})

/**
 * Frame binary tunnel: `[0x02][channelId u16BE][payload]`.
 * Byte 0 = 0x02 menandai "tunnel frame" (berbeda dari channel VIDEO 0x01
 * pada koneksi browser langsung — lihat binary.ts).
 */
export const TUNNEL_FRAME_MARKER = 0x02

export function encodeTunnelFrame(channelId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + payload.length)
  out[0] = TUNNEL_FRAME_MARKER
  new DataView(out.buffer).setUint16(1, channelId & 0xffff, false)
  out.set(payload, 3)
  return out
}

export function decodeTunnelFrame(buf: Uint8Array): { channelId: number; payload: Uint8Array } {
  if (buf.length < 3 || buf[0] !== TUNNEL_FRAME_MARKER) {
    throw new Error('bukan tunnel frame yang valid')
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { channelId: dv.getUint16(1, false), payload: buf.subarray(3) }
}

// ---- signaling WebRTC (M8b) ----

export const WebRtcRequestMessage = z.object({
  type: z.literal('video.webrtc.request'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

export const WebRtcOfferMessage = z.object({
  type: z.literal('video.webrtc.offer'),
  payload: z.object({ deviceId: z.string(), sdp: z.string() }),
})

export const WebRtcAnswerMessage = z.object({
  type: z.literal('video.webrtc.answer'),
  payload: z.object({ deviceId: z.string(), sdp: z.string() }),
})

export const WebRtcIceMessage = z.object({
  type: z.literal('video.webrtc.ice'),
  payload: z.object({ deviceId: z.string(), candidate: z.unknown() }),
})

/** Gagal negosiasi → Studio jatuh ke WS+WebCodecs (degraded, bukan mati). */
export const WebRtcFailedMessage = z.object({
  type: z.literal('video.webrtc.failed'),
  payload: z.object({ deviceId: z.string(), reason: z.string() }),
})

export const WebRtcStopMessage = z.object({
  type: z.literal('video.webrtc.stop'),
  payload: z.object({ deviceId: z.string() }),
})

// ---- session & job jarak jauh (M9a) ----

/**
 * CP → agent: teruskan input. Koordinat sudah dalam PIXEL device — control
 * plane yang memetakannya dari 0..1 memakai dimensi frame terakhir, supaya
 * agent tidak perlu tahu ukuran tampilan di browser.
 */
export const InputForwardMessage = z.object({
  type: z.literal('input.forward'),
  payload: z.object({
    deviceId: z.string(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('tap'), point: PointSchema }),
      z.object({ kind: z.literal('swipe'), from: PointSchema, to: PointSchema, durationMs: z.number().int() }),
      z.object({ kind: z.literal('key'), keycode: z.number().int() }),
      z.object({ kind: z.literal('text'), text: z.string() }),
    ]),
  }),
})

export const JobCancelForwardMessage = z.object({
  type: z.literal('job.cancel.forward'),
  payload: z.object({ jobId: z.string() }),
})

/** agent → CP: sesi berhasil dibuat, termasuk engine efektif hasil degrade. */
export const SessionStartedMessage = z.object({
  type: z.literal('session.started'),
  payload: z.object({
    deviceId: z.string(),
    codec: z.enum(['png', 'h264']),
    width: z.number().int(),
    height: z.number().int(),
    displayEngine: z.string(),
    inputEngine: z.string(),
    inspectorEngine: z.string(),
    degradedReason: z.string().optional(),
  }),
})

export const SessionFailedMessage = z.object({
  type: z.literal('session.failed'),
  payload: z.object({ deviceId: z.string(), code: z.string(), message: z.string() }),
})

/** agent → CP: kemajuan job (fase, log, artifact kecil, hasil akhir). */
export const JobProgressMessage = z.object({
  type: z.literal('job.progress'),
  payload: z.object({
    jobId: z.string(),
    kind: z.enum(['phase', 'log', 'artifact', 'result']),
    phase: z.enum(['prepare', 'run', 'finish']).optional(),
    attempt: z.number().int().optional(),
    log: z
      .object({ level: z.string(), source: z.string(), msg: z.string(), ts: z.number() })
      .optional(),
    artifact: z
      .object({ label: z.string(), kind: z.string(), ext: z.string().optional(), dataBase64: z.string() })
      .optional(),
    result: z
      .object({
        ok: z.boolean(),
        value: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .optional(),
  }),
})

// ---- union (harus di akhir: semua message sudah terdefinisi) ----

export const AgentToControlSchema = z.discriminatedUnion('type', [
  AgentHelloMessage,
  AgentDevicesMessage,
  SessionStartedMessage,
  SessionFailedMessage,
  JobProgressMessage,
  TunnelPingMessage,
  TunnelPongMessage,
  TunnelChannelCloseMessage,
])
export type AgentToControl = z.infer<typeof AgentToControlSchema>

export const ControlToAgentSchema = z.discriminatedUnion('type', [
  AgentHelloAckMessage,
  SessionStartMessage,
  SessionStopMessage,
  JobDispatchMessage,
  InputForwardMessage,
  JobCancelForwardMessage,
  TunnelPingMessage,
  TunnelPongMessage,
  TunnelChannelOpenMessage,
  TunnelChannelCloseMessage,
])
export type ControlToAgent = z.infer<typeof ControlToAgentSchema>

