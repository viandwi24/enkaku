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
  /** An activity started on the device (plan 205, MVP 04) — carries { id, kind, label, actor }. */
  'activity.started',
  /** An activity ended on the device (plan 205, MVP 04) — carries { id, kind, label, actor }. */
  'activity.ended',
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
  /** An Inspect tab attached to the session's already-running engine (plan 56 §3.7, plan 208 §3.2) — carries { engineId, tookMs }. Individual dumps are NOT recorded here (§3.7): they are reads, many per minute, and would drown the log. */
  'inspect.attached',
  /** An Inspect tab viewer left; the engine keeps running with the session (plan 56 §3.7, plan 208 §3.2). */
  'inspect.detached',
  /** Bounded automatic network-route recovery gave up after its attempt bound (plan 90 §3.7 rule 5, fixes F20) — carries { attempts, message }. */
  'network.recovery.exhausted',
  /** A network route that needed automatic recovery is carrying traffic again — either mid-attempt or after a genuine reconnect reset the bound (plan 90 §3.7 rule 5) — carries { attempts } or { attempts, wasExhausted }. */
  'network.recovery.recovered',
  /**
   * A device was admitted still carrying a route the farm's own record does
   * not want, and the farm took it back — carries { engine, reason,
   * devicePort?, restored: 'captured'|'cleared', forgot }.
   *
   * The incident behind it: a phone turned off in the farm while it was
   * unplugged kept `http_proxy 127.0.0.1:<port>` and got its `adb reverse`
   * back on reconnect, so its traffic left through a metered residential proxy
   * for a day with every screen reading "no route". Convergence on admission
   * is the fix; this event is the half that makes the convergence legible,
   * because a farm that silently un-does things to a phone is the same
   * unreadable state pointed the other way.
   */
  'network.orphan.cleared',
  /** The guest agent's provisioning state changed (plan 90 §3.8, §4.3) — carries { state, reason? }. Fired once per state transition, never per verification pass (a clean reconnect that changes nothing emits no event, acceptance criterion 5). */
  'device.agent',
  /** A registered device-preparation component's state changed (plan 106 §3.1, §3.3) — carries { componentId, state, reason?, from }. Fired once per state transition, same rule as `device.agent` above (a clean pass that changes nothing emits no event). */
  'device.preparation',
  /**
   * A screen-rotation lock (`DeviceSettings.prep.rotation`, plan 85 §3.7) was
   * asked for and the device did not end up in it — carries { mode, applied:
   * false, reason, quality? }, plus { from, to, state } when the trigger was an
   * operator changing the setting rather than a session opening.
   *
   * Deliberately only recorded for outcomes that are NOT a plain success. A
   * lock is applied on every session build of every wall tile; recording each
   * one would write dozens of rows an hour saying nothing happened, and would
   * bury the one row that matters. The event exists because the failure used
   * to be swallowed into `log.debug` — an operator saw a lock that silently
   * never took (`packages/session/src/orientation.ts`).
   */
  'device.rotation',
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
