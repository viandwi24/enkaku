import { z } from 'zod'
import { DeviceInfoSchema } from './device'

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

export const AgentToControlSchema = z.discriminatedUnion('type', [
  AgentHelloMessage,
  AgentDevicesMessage,
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
  TunnelPingMessage,
  TunnelPongMessage,
  TunnelChannelOpenMessage,
  TunnelChannelCloseMessage,
])
export type ControlToAgent = z.infer<typeof ControlToAgentSchema>

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
