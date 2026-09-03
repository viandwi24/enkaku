import { z } from 'zod'
import type { DeviceInfo } from './device'

/** MVP 04 §1.1. Closed for now: plugin-declared kinds are deferred (MVP 04 §5 item 3, §9 Q2). */
export const ActivityKindSchema = z.enum([
  'control',
  'job',
  'workflow-job',
  'install',
  'transfer',
  'prep',
  'command',
  'agent',
  'network-apply',
  'wake',
])
export type ActivityKind = z.infer<typeof ActivityKindSchema>

export const ActivityActorSchema = z.object({
  kind: z.enum(['user', 'agent', 'system', 'plugin']),
  /** userId (or the WS clientId when unauthenticated), agentId, 'core', or 'plugin:<name>'. */
  id: z.string(),
  /** Resolved server-side, never empty and never a raw id: an email, an agent's name, 'a signed-out client'. */
  label: z.string(),
})
export type ActivityActor = z.infer<typeof ActivityActorSchema>

export const DeviceActivitySchema = z.object({
  /** Stable for the activity's life: `control:<clientId>`, `job:<jobId>`, `transfer:<transferId>`, `prep:<component>`, `command:<runId>`, `agent:<rootRunId>`, `network-apply:<uuid>`, `wake:<deviceId>`. */
  id: z.string(),
  kind: ActivityKindSchema,
  /** A human sentence, never an id: "Running tiktok/login (job #482)", "Installing app.apk 40 %", "Controlled by Rani". */
  label: z.string(),
  actor: ActivityActorSchema,
  /** Unix seconds. */
  startedAt: z.number().int(),
  /** Unix seconds: last heartbeat, last progress, or last input. */
  updatedAt: z.number().int(),
  /** Where to look: `/jobs/detail?id=...`, a plugin view. */
  href: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type DeviceActivity = z.infer<typeof DeviceActivitySchema>

/** The "last controlled N seconds ago by X" tail (MVP 04 §1.2), kept `LAST_CONTROL_TAIL_SEC` after the marker ends. */
export const LastControlSchema = z.object({ actor: ActivityActorSchema, endedAt: z.number().int() })
export type LastControl = z.infer<typeof LastControlSchema>

export const PolicyDecisionSchema = z.object({
  decision: z.enum(['allow', 'warn', 'forbid']),
  /** The sentence shown to the caller; empty string for `allow`. */
  message: z.string(),
  conflicting: DeviceActivitySchema.optional(),
})
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>

/** The one error code a `forbid` produces, everywhere (WS, HTTP 409, capability refusal). */
export const E_DEVICE_CONFLICT = 'E_DEVICE_CONFLICT' as const

export const DeviceActivityMessage = z.object({
  type: z.literal('device.activity'),
  payload: z.object({
    deviceId: z.string(),
    change: z.enum(['added', 'updated', 'ended']),
    activity: DeviceActivitySchema,
    /** The tail after an `ended` control marker; null otherwise. */
    lastControl: LastControlSchema.nullable(),
  }),
})
export type DeviceActivityEvent = z.infer<typeof DeviceActivityMessage>

/** Unicast to the client whose input was accepted with `warn` (MVP 04 §3): at most one per device per minute per connection. */
export const DeviceActivityWarningMessage = z.object({
  type: z.literal('device.activity.warning'),
  payload: z.object({ deviceId: z.string(), message: z.string(), conflicting: DeviceActivitySchema }),
})
export type DeviceActivityWarningEvent = z.infer<typeof DeviceActivityWarningMessage>

const JOB_KINDS = new Set<ActivityKind>(['job', 'workflow-job'])

/**
 * MVP 15 §1's state-dot mapping, moved here from `packages/studio/src/lib/activity.ts`
 * by plan 205's §12 amendment: a pure function of `DeviceInfo` belongs beside the
 * schemas it reads, and Studio has zero tests (plan 200 §8.3) so it is exercised
 * here instead of in a Studio-side test.
 *
 * green free, amber someone controlling, red job running, grey disconnected, warn quarantined.
 */
export type StateDot = 'free' | 'controlled' | 'job' | 'offline' | 'warn'
export function deviceState(info: Pick<DeviceInfo, 'status' | 'activities'>): StateDot {
  if (info.status === 'offline') return 'offline'
  if (info.status === 'quarantined') return 'warn'
  if (info.activities.some((a: DeviceActivity) => JOB_KINDS.has(a.kind))) return 'job'
  if (info.activities.some((a: DeviceActivity) => a.kind === 'control')) return 'controlled'
  return 'free'
}
