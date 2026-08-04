import { z } from 'zod'
import { MonitorKindSchema } from './monitor'

/**
 * The Monitor WS protocol (plan 24 §4.4). Named `shell.ts` to match Plan 26's
 * eventual free-form terminal channel, which this plan deliberately does NOT
 * implement — every message here carries a `kind` drawn from
 * `MonitorKindSchema` and typed `options`, never a raw command string (§3.7,
 * §2 non-goals).
 *
 * `streamId` is the hub's own key (`deviceId:kind:optionsHash`, plan 24
 * §4.5) rather than a per-connection counter like `stream.start`'s video
 * `streamId` — that is exactly what makes two viewers of the same (device,
 * monitor) converge on the same stream instead of each starting their own.
 */

/** Why a stream ended (plan 24 §4.2), mirrored here so Studio never needs to import @enkaku/adb. */
export const MonitorEndReasonSchema = z.enum(['closed', 'idle', 'deadline', 'bytes', 'stopped', 'error'])
export type MonitorEndReason = z.infer<typeof MonitorEndReasonSchema>

// ---- client -> server ----

/** Subscribe to (and, if nobody else already has, start) a monitor stream. */
export const MonitorStartMessage = z.object({
  type: z.literal('monitor.start'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    kind: MonitorKindSchema,
    /** Validated against `optionsSchemaFor(kind)` server-side; see monitors.ts. */
    options: z.unknown().optional(),
  }),
})

/** Unsubscribe. The stream itself stops only once its last subscriber leaves (§3.5, §4.5). */
export const MonitorStopMessage = z.object({
  type: z.literal('monitor.stop'),
  payload: z.object({ streamId: z.string() }),
})

/** A one-shot kind (`ps` | `meminfo` | `df`) — request/reply, no subscription. */
export const MonitorOneshotMessage = z.object({
  type: z.literal('monitor.oneshot'),
  id: z.string(),
  payload: z.object({ deviceId: z.string(), kind: MonitorKindSchema }),
})

// ---- server -> client ----

export const MonitorStartedMessage = z.object({
  type: z.literal('monitor.started'),
  id: z.string(),
  payload: z.object({
    streamId: z.string(),
    deviceId: z.string(),
    kind: MonitorKindSchema,
    /** The ring buffer replayed immediately so a late joiner is not staring at an empty pane (§3.5). */
    backlog: z.array(z.string()),
  }),
})

/** Batched every ~100ms server-side (§4.4) — never one WS frame per raw chunk. */
export const MonitorDataMessage = z.object({
  type: z.literal('monitor.data'),
  payload: z.object({ streamId: z.string(), lines: z.array(z.string()) }),
})

export const MonitorEndedMessage = z.object({
  type: z.literal('monitor.ended'),
  payload: z.object({ streamId: z.string(), reason: MonitorEndReasonSchema }),
})

export const MonitorResultMessage = z.object({
  type: z.literal('monitor.result'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    kind: MonitorKindSchema,
    text: z.string(),
    truncated: z.boolean(),
  }),
})

/**
 * Live subscriber count for a stream (plan 24 §4.7's shared-viewer badge) —
 * broadcast to every subscriber of that `streamId` whenever it changes, the
 * same shape `device.viewers` uses for the device-level presence badge.
 */
export const MonitorSubscribersMessage = z.object({
  type: z.literal('monitor.subscribers'),
  payload: z.object({ streamId: z.string(), count: z.number().int().min(0) }),
})

/**
 * The interactive terminal (plan 26 §4.2) — deliberately a SEPARATE trio of
 * message types from everything above: `shell.exec` carries a raw `cmd`
 * string, never a `MonitorKind` plus typed options. That is the whole
 * difference between "a fixed command builder" (plan 24, no lease, no
 * permission) and "free-form remote execution" (plan 26, both). The server
 * checks `device.shell` plus `leases.checkInputAllowed` before doing
 * anything with `cmd` — never trust that Studio only sent this because its
 * own input box was enabled (spec §10.1).
 */

// ---- client -> server ----

export const ShellExecMessage = z.object({
  type: z.literal('shell.exec'),
  /** Correlates only an immediate refusal (`error`) back to the sender — a
   * successful run is NOT replied to the sender alone, it is broadcast via
   * `shell.echo`/`shell.result` to every viewer of the device (§3.8). */
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    cmd: z.string().min(1).max(4096),
    /**
     * Advisory only — the server is authoritative for the emulated cwd
     * (§3.7, §4.4) and never trusts a client-supplied path. Accepted here so
     * a future client can show what it BELIEVES the cwd to be without that
     * belief ever influencing what actually runs.
     */
    cwd: z.string().optional(),
  }),
})

// ---- server -> client (broadcast to every viewer of the device, §3.8) ----

/** Emitted the instant the command is accepted — before it has run — so observers see what is executing before it finishes. */
export const ShellEchoMessage = z.object({
  type: z.literal('shell.echo'),
  payload: z.object({
    deviceId: z.string(),
    cmd: z.string(),
    /** The server's emulated cwd at the moment the command was accepted (§3.7). */
    cwd: z.string(),
    /** userId, or null when the actor cannot be resolved (local mode's implicit admin edge cases). */
    actor: z.string().nullable(),
    /** Unix epoch seconds. */
    at: z.number(),
  }),
})

export const ShellResultMessage = z.object({
  type: z.literal('shell.result'),
  payload: z.object({
    deviceId: z.string(),
    stdout: z.string(),
    /**
     * Kept apart from `stdout` rather than merged into it (plan 53). A field
     * named `stdout` that also carried error text was the naming lie plan 53
     * set out to remove; Studio renders this stream distinctly.
     */
    stderr: z.string(),
    /**
     * `null` when the device could not report one — a shell too old for the
     * framed `shell,v2,raw` service, or a killed shell (plan 53 §3.4). Never
     * guessed, and never a fabricated `0`.
     */
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    durationMs: z.number(),
    /** The resulting cwd — unchanged from the echo's `cwd` unless this command was a successful `cd` (§3.7). */
    cwd: z.string(),
    /** Set when the command hit its deadline (§3.6) — Studio offers a one-click "Run as a stream" on the Plan 24 lane. */
    hint: z.literal('stream_suggested').optional(),
  }),
})
