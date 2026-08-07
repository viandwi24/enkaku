import { z } from 'zod'
import { DeviceInfoSchema } from './device'
import { PointSchema } from './ui-node'

/**
 * Tunnel protocol, node ⇄ control plane (plan 11 §4.2, renamed from "agent" in plan 61).
 *
 * The envelope gains routing fields; local messages without them stay valid,
 * so local mode (Plans 01–09) is completely unchanged.
 */
export const RoutedEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.string(),
  id: z.string().optional(),
  /** Filled in by the control plane when routing to or from a node. */
  nodeId: z.string().optional(),
  deviceId: z.string().optional(),
  /** Server-side only — nodes and browsers must never set it. */
  tenantId: z.string().optional(),
  payload: z.unknown(),
})
export type RoutedEnvelope = z.infer<typeof RoutedEnvelopeSchema>

// ---- node → control plane ----

export const NodeHelloMessage = z.object({
  type: z.literal('node.hello'),
  payload: z.object({
    nodeVersion: z.string(),
    platform: z.string(),
    toolVersions: z.record(z.string(), z.string()),
  }),
})

/**
 * Plan 61 §3.3 compatibility window: a node binary built before the rename
 * still sends `agent.hello` — the control plane accepts it for one release
 * with a warn-level log naming the node, so an operator can see which nodes
 * still need upgrading. Dated removal tracked in `00-overview.md`.
 */
export const NodeHelloLegacyMessage = z.object({
  type: z.literal('agent.hello'),
  payload: z.object({
    agentVersion: z.string(),
    platform: z.string(),
    toolVersions: z.record(z.string(), z.string()),
  }),
})

export const NodeDevicesMessage = z.object({
  type: z.literal('node.devices'),
  payload: z.object({ devices: z.array(DeviceInfoSchema) }),
})

/** Plan 61 §3.3 compatibility window — same payload shape as `NodeDevicesMessage`, a pre-rename node still sends this type string. */
export const NodeDevicesLegacyMessage = z.object({
  type: z.literal('agent.devices'),
  payload: z.object({ devices: z.array(DeviceInfoSchema) }),
})

// ---- control plane → node ----

export const NodeHelloAckMessage = z.object({
  type: z.literal('node.hello.ack'),
  payload: z.object({
    nodeId: z.string(),
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
    /** Which member of a plugin bundle to run (plan 82 §3.2) — undefined for a standalone bundle. */
    scriptExportId: z.string().optional(),
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
    /**
     * `shell` (plan 25 §3.3, §4.2): a multiplexed byte stream for
     * logcat/top/thermal on a node-owned device — no new transport, just a
     * new kind on the channel that already exists.
     * `adb-raw` (plan 28 §4.1): one channel per ADB stream carried by the
     * cloud adb endpoint's shim — see the `adb.*` messages below.
     */
    kind: z.enum(['video', 'audio', 'control-raw', 'shell', 'adb-raw']),
  }),
})
export type TunnelChannelKind = z.infer<typeof TunnelChannelOpenMessage>['payload']['kind']

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
 * CP → node: forward input. Coordinates are already in device PIXELS — the
 * control plane maps them from 0..1 using the latest frame dimensions, so the
 * node never needs to know the browser's display size.
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

/** node → CP: the session came up, including any degraded effective engines. */
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

/** node → CP: job progress (phase, logs, small artifacts, final result). */
export const JobProgressMessage = z.object({
  type: z.literal('job.progress'),
  payload: z.object({
    jobId: z.string(),
    kind: z.enum(['phase', 'log', 'artifact', 'result']),
    /** `reset` (plan 35 §3.5) is the pre-job device reset — it always runs before `prepare`. */
    phase: z.enum(['reset', 'prepare', 'run', 'finish']).optional(),
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
        /** `phase` (plan 60 §3.4) — where the failure happened, so a cloud job's Summary reads the same as a local one's. */
        error: z.object({ code: z.string(), message: z.string(), phase: z.string().optional() }).optional(),
      })
      .optional(),
  }),
})

// ---- correlated shell request/response (M12d, plan 25 §4.1, §4.2) ----

/**
 * The correlation layer the tunnel was missing (plan 25 §3.2): every request
 * here carries `id` (a `crypto.randomUUID()`, matched to its reply by
 * `TunnelRpc`), unlike the fire-and-forget messages above. `cmd` crossing the
 * tunnel is deliberate (§4.2) — the node is not a security boundary against
 * its own control plane, and the monitor builders on the core side are the
 * only producers of these strings in this plan.
 */
export const ShellReplyErrorSchema = z.object({ code: z.string(), message: z.string() })

export const ShellExecRequestMessage = z.object({
  type: z.literal('shell.exec.request'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    cmd: z.string(),
    /** An `AdbTimeoutProfile` name, mirrored as a plain string so this package
     * never depends on `@enkaku/adb` (same reasoning as `MonitorEndReasonSchema`
     * in `messages/shell.ts`). A node that does not recognise the value
     * falls back to its own default profile. */
    profile: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  }),
})

export const ShellExecReplyMessage = z.object({
  type: z.literal('shell.exec.reply'),
  id: z.string(),
  payload: z.object({
    ok: z.boolean(),
    stdout: z.string().optional(),
    /**
     * Separated from `stdout` by the framed shell,v2,raw protocol (plan 53
     * §3.3). Optional so an older node build that has not been upgraded
     * yet — and so never sends this field — does not fail validation; the
     * core defaults it to `''` when absent (plan 53).
     */
    stderr: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    truncated: z.boolean().optional(),
    error: ShellReplyErrorSchema.optional(),
  }),
})

export const ShellStreamRequestMessage = z.object({
  type: z.literal('shell.stream.request'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    cmd: z.string(),
    /** The `shell` binary channel the core already opened for this stream (§4.5 step 1). */
    channelId: z.number().int().min(0).max(65535),
    idleTimeoutMs: z.number().int().positive().optional(),
    absoluteTimeoutMs: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
  }),
})

export const ShellStreamReplyMessage = z.object({
  type: z.literal('shell.stream.reply'),
  id: z.string(),
  payload: z.object({
    ok: z.boolean(),
    streamId: z.string().optional(),
    error: ShellReplyErrorSchema.optional(),
  }),
})

/** CP → node: stop a running stream (mirrors the local `AdbStreamHandle.stop()` path). */
export const ShellStreamStopMessage = z.object({
  type: z.literal('shell.stream.stop'),
  payload: z.object({ streamId: z.string() }),
})

/**
 * node → CP: a push, not a reply — correlated by the stream's OWN id
 * (assigned in `shell.stream.reply`), not by a pending request id, because
 * nothing is "requesting" this; it can arrive at any time (idle/deadline/
 * bytes/stopped/error/backpressure — plan 25 §3.5).
 */
export const ShellStreamEndedMessage = z.object({
  type: z.literal('shell.stream.ended'),
  payload: z.object({ streamId: z.string(), reason: z.string() }),
})

// ---- correlated clipboard request/response (M17d, plan 38 §4.5) ----

/**
 * The clipboard's cloud parity: same correlation pattern as `shell.exec.*`
 * above, one request/reply pair per operation. `ClipboardReplyErrorSchema` is
 * its own (structurally identical) schema rather than a reuse of
 * `ShellReplyErrorSchema` — clipboard and shell are independent protocol
 * surfaces, and this keeps a future divergence (an extra field on one but not
 * the other) from being a breaking rename.
 */
export const ClipboardReplyErrorSchema = z.object({ code: z.string(), message: z.string() })

export const ClipboardGetRequestMessage = z.object({
  type: z.literal('clipboard.get.request'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    copyKey: z.enum(['none', 'copy', 'cut']).optional(),
  }),
})

export const ClipboardGetReplyMessage = z.object({
  type: z.literal('clipboard.get.reply'),
  id: z.string(),
  payload: z.object({
    ok: z.boolean(),
    text: z.string().optional(),
    error: ClipboardReplyErrorSchema.optional(),
  }),
})

export const ClipboardSetRequestMessage = z.object({
  type: z.literal('clipboard.set.request'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    text: z.string(),
    paste: z.boolean().optional(),
  }),
})

export const ClipboardSetReplyMessage = z.object({
  type: z.literal('clipboard.set.reply'),
  id: z.string(),
  payload: z.object({
    ok: z.boolean(),
    error: ClipboardReplyErrorSchema.optional(),
  }),
})

// ---- the cloud adb endpoint (M12g, plan 28 §4.1) ----

/**
 * `AdbdShimDeps.openService` (plan 27 §4.1) becomes, in cloud mode, a call
 * across the tunnel: one `adb.open.request`/`adb.open.reply` pair per ADB
 * stream (`OPEN` on the wire protocol), correlated by `id` exactly like the
 * `shell.*` request/reply pairs above. Payload bytes then travel as tunnel
 * frames on `channelId`, in both directions — no further JSON per byte.
 */
export const AdbOpenRequestMessage = z.object({
  type: z.literal('adb.open.request'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    service: z.string().max(1024),
    channelId: z.number().int().min(0).max(65535),
  }),
})

export const AdbOpenReplyMessage = z.object({
  type: z.literal('adb.open.reply'),
  id: z.string(),
  payload: z.object({
    ok: z.boolean(),
    error: ShellReplyErrorSchema.optional(),
  }),
})

/**
 * Either side may end an ADB stream first (the host's `CLSE`, the device's
 * end of the smartsocket stream, or the endpoint tearing down) — plan 28
 * §4.2 point 5: "close on either side → adb.close → tunnel.channel.close →
 * release the id in a finally." Not a reply to anything, so it carries no
 * `id`; the receiving side correlates by `channelId`.
 */
export const AdbCloseMessage = z.object({
  type: z.literal('adb.close'),
  payload: z.object({
    channelId: z.number().int().min(0).max(65535),
    reason: z.string(),
  }),
})

/**
 * Delivery acknowledgement for §3.3: the node reports how many bytes it has
 * actually written downstream (to its own adb server) for `channelId`. The
 * shim's WRTE/OKAY window to the user's adb client advances ONLY on this
 * message — never merely because bytes were handed to the tunnel — so a
 * large `push` cannot buffer without limit in the control plane. This is the
 * single most important correctness detail in plan 28 (§3.3, acceptance #4).
 */
export const AdbAckMessage = z.object({
  type: z.literal('adb.ack'),
  payload: z.object({
    channelId: z.number().int().min(0).max(65535),
    bytes: z.number().int().nonnegative(),
  }),
})

// ---- union (must come last: every message is defined by now) ----

export const NodeToControlSchema = z.discriminatedUnion('type', [
  NodeHelloMessage,
  NodeHelloLegacyMessage,
  NodeDevicesMessage,
  NodeDevicesLegacyMessage,
  SessionStartedMessage,
  SessionFailedMessage,
  JobProgressMessage,
  TunnelPingMessage,
  TunnelPongMessage,
  TunnelChannelCloseMessage,
  ShellExecReplyMessage,
  ShellStreamReplyMessage,
  ShellStreamEndedMessage,
  ClipboardGetReplyMessage,
  ClipboardSetReplyMessage,
  AdbOpenReplyMessage,
  AdbCloseMessage,
  AdbAckMessage,
])
export type NodeToControl = z.infer<typeof NodeToControlSchema>

export const ControlToNodeSchema = z.discriminatedUnion('type', [
  NodeHelloAckMessage,
  SessionStartMessage,
  SessionStopMessage,
  JobDispatchMessage,
  InputForwardMessage,
  JobCancelForwardMessage,
  TunnelPingMessage,
  TunnelPongMessage,
  TunnelChannelOpenMessage,
  TunnelChannelCloseMessage,
  ShellExecRequestMessage,
  ShellStreamRequestMessage,
  ShellStreamStopMessage,
  ClipboardGetRequestMessage,
  ClipboardSetRequestMessage,
  AdbOpenRequestMessage,
  AdbCloseMessage,
])
export type ControlToNode = z.infer<typeof ControlToNodeSchema>

