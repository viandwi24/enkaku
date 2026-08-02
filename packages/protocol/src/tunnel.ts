import { z } from 'zod'
import { DeviceInfoSchema } from './device'
import { PointSchema } from './ui-node'

/**
 * Protokol tunnel agent ⇄ control plane (plan 11 §4.2).
 *
 * The envelope gains routing fields; local messages without them stay valid,
 * so local mode (Plans 01–09) is completely unchanged.
 */
export const RoutedEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.string(),
  id: z.string().optional(),
  /** Filled in by the control plane when routing to or from an agent. */
  agentId: z.string().optional(),
  deviceId: z.string().optional(),
  /** Server-side only — agents and browsers must never set it. */
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
    /** The bundle travels inline or by URL — the control plane decides. */
    bundle: z.string().optional(),
    bundleUrl: z.string().optional(),
    params: z.unknown(),
  }),
})

// ---- bidirectional ----

export const TunnelPingMessage = z.object({
  type: z.literal('tunnel.ping'),
  payload: z.object({ t: z.number() }),
})

export const TunnelPongMessage = z.object({
  type: z.literal('tunnel.pong'),
  payload: z.object({ t: z.number() }),
})

/** Dynamic binary channel allocation: one tunnel carries many devices. */
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
 * Byte 0 = 0x02 marks a "tunnel frame" (distinct from the VIDEO channel 0x01
 * on a direct browser connection — see binary.ts).
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
    throw new Error('not a valid tunnel frame')
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

/** Negotiation failed → Studio falls back to WS + WebCodecs (degraded, not dead). */
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
 * CP → agent: forward input. Coordinates are already in device PIXELS — the
 * control plane maps them from 0..1 using the latest frame dimensions, so the
 * agent never needs to know the browser's display size.
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

/** agent → CP: the session came up, including any degraded effective engines. */
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

/** agent → CP: job progress (phase, logs, small artifacts, final result). */
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

// ---- union (must come last: every message is defined by now) ----

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

