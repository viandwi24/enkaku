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
  /** The pre-job reset ran (plan 35 §3.5) — carries { policy, packages, warnings, durationMs }. */
  'job.reset',
  /** A script called `ctx.jobs.trigger()` and a new (non-deduped) job was queued (plan 81 §4.5) — carries { fromJobId, toJobId, rootJobId, depth }, recorded on the TARGET device (where the new job will run, which may differ from the triggering job's own device). */
  'job.triggered',
  'settings.changed',
  'battery.warning',
  /** A device stopped answering adb and was auto-quarantined (plan 23 §4.4). */
  'device.unhealthy',
  /** The same device answered again and was auto-released (plan 23 §4.4). */
  'device.recovered',
  /** An application crash or ANR was detected (plan 37 §3.3) — carries { kind: 'crash'|'anr', package, process, exception, message, system, truncated, artifactId?, jobId? }. */
  'app.crashed',
  /** A one-shot uninstall/reinstall repair still left an on-device artifact (e.g. the ui-server APK) mismatched (plan 41 §3.3) — carries { package, reason: 'version_mismatch'|'signature_mismatch', observed? }. */
  'device.artifact.mismatch',
  /** `desired` readiness changed, by a human or a policy (plan 43 §4.5) — carries { from, to }. */
  'device.readiness',
  /** The inspector engine was started (or joined) for the Inspect tab (plan 56 §3.7) — carries { engineId }. Individual dumps are NOT recorded here (§3.7): they are reads, many per minute, and would drown the log. */
  'inspect.attached',
  /** The last Inspect tab viewer left and the inspector engine was released (plan 56 §3.7). */
  'inspect.detached',
  /** Bounded automatic network-route recovery gave up after its attempt bound (plan 90 §3.7 rule 5, fixes F20) — carries { attempts, message }. */
  'network.recovery.exhausted',
  /** A network route that needed automatic recovery is carrying traffic again — either mid-attempt or after a genuine reconnect reset the bound (plan 90 §3.7 rule 5) — carries { attempts } or { attempts, wasExhausted }. */
  'network.recovery.recovered',
  /** The guest agent's provisioning state changed (plan 90 §3.8, §4.3) — carries { state, reason? }. Fired once per state transition, never per verification pass (a clean reconnect that changes nothing emits no event, acceptance criterion 5). */
  'device.agent',
  /** A registered device-preparation component's state changed (plan 106 §3.1, §3.3) — carries { componentId, state, reason?, from }. Fired once per state transition, same rule as `device.agent` above (a clean pass that changes nothing emits no event). */
  'device.preparation',
  /** A co-control (Assist) grant started on this device (plan 91 §3.5, §3.4 item 4) — mirrors `control.acquired`/`control.released` for the SUBORDINATE grant rather than the lease. Carries { jobId, primaryKind }. */
  'control.assist.started',
  /** The bookend to `control.assist.started` — carries { jobId, primaryKind, reason }, `reason` one of `AssistEndReason` ('released' | 'ttl' | 'disconnected' | 'primary_ended' | 'mode_off'). */
  'control.assist.ended',
  // `'clipboard.overwritten'` — the text ladder's clipboard-paste rung (plan 90 §3.3 rule 3) —
  // was added here for step 90.5's benefit and removed by the M61 hotfix pass
  // (docs/plans/96-m61-hotfixes.md §96.7, §96.8): the rung it recorded was proven
  // architecturally unreachable in this codebase, so the event could never fire. Do not re-add it
  // without first re-adding a reachable clipboard-paste rung to `packages/session/src/text-input.ts`.
] as const

/** Input-stream kinds (§4.2). */
export const INPUT_EVENT_KINDS = ['input.tap', 'input.swipe', 'input.gesture', 'input.key', 'input.text'] as const

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
