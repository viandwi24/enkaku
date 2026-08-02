import { z } from 'zod'

/**
 * The device event log (plan 18 §3.1, §4.1, §4.2): one table, two streams.
 * `main` is lifecycle (connect, control, jobs, settings); `input` is every
 * injected action. The kind strings below are the single source of truth —
 * no message string for these events lives anywhere outside this file.
 */

export const DeviceEventStreamSchema = z.enum(['main', 'input'])
export type DeviceEventStream = z.infer<typeof DeviceEventStreamSchema>

/** Main-stream kinds (§4.2) — documented here, not enforced by the schema:
 * `kind` stays a free string so a future kind never needs a migration. */
export const MAIN_EVENT_KINDS = [
  'device.online',
  'device.offline',
  'device.unauthorized',
  'control.acquired',
  'control.released',
  'control.revoked',
  'session.opened',
  'session.closed',
  'session.degraded',
  'job.started',
  'job.finished',
  'settings.changed',
  'battery.warning',
  /** A device stopped answering adb and was auto-quarantined (plan 23 §4.4). */
  'device.unhealthy',
  /** The same device answered again and was auto-released (plan 23 §4.4). */
  'device.recovered',
] as const

/** Input-stream kinds (§4.2). */
export const INPUT_EVENT_KINDS = ['input.tap', 'input.swipe', 'input.key', 'input.text'] as const

export const DeviceEventSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  stream: DeviceEventStreamSchema,
  /** Dotted kind, e.g. 'device.online', 'input.tap'. */
  kind: z.string(),
  /** userId, 'job:<id>', or null when the core itself is the actor. */
  actor: z.string().nullable(),
  /** Kind-specific detail; always an object (or null), never a bare value. */
  meta: z.record(z.string(), z.unknown()).nullable(),
  /** Unix epoch seconds. */
  at: z.number(),
})
export type DeviceEvent = z.infer<typeof DeviceEventSchema>

// ---- client → server ----

/** Subscribe this connection to a device's log streams (§3.6). */
export const LogSubscribeMessage = z.object({
  type: z.literal('log.subscribe'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    streams: z.array(DeviceEventStreamSchema).min(1),
  }),
})

export const LogUnsubscribeMessage = z.object({
  type: z.literal('log.unsubscribe'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

// ---- server → client ----

export const DeviceEventMessage = z.object({
  type: z.literal('device.event'),
  payload: DeviceEventSchema,
})
