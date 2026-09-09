import { z } from 'zod'
import { ConnectionMediumSchema } from './device'
import { DeviceSettingsSchema } from './settings'

/**
 * The MVP 07 actions API (plan 207) — one endpoint per verb, taking a
 * target. Every per-device action route and every bulk twin is replaced by
 * `POST /api/actions/<verb>` with a `{ target, ...params, force }` body and
 * a per-device result array (MVP 07 §1.1, §1.2). Reads stay per device; the
 * WS `input.*` messages stay single-device and fire-and-forget (MVP 07
 * §1.4) — a stream, not an action.
 */

/** MVP 07 §1.1: a single device is `{ deviceIds: [one] }`. Exactly one key. */
export const TargetSchema = z.union([
  z.object({ deviceIds: z.array(z.string().min(1)).min(1) }),
  z.object({ groupId: z.string().min(1) }),
  /**
   * Every device carrying ALL of these labels (plan 225 §3.4) — an AND, the
   * same intersection the `tags` member it replaces resolved.
   *
   * Label IDS, not names: a label can be renamed, and a stored target that
   * named a label by its text would silently resolve to nothing the first
   * time an operator fixed a typo. That is exactly what the free-form tags
   * this member replaces could not avoid, because a tag WAS its text.
   */
  z.object({ labelIds: z.array(z.string().min(1)).min(1) }),
  /**
   * LEGACY, read-only: a target stored before plan 225, naming free-form
   * tags by text. Nothing writes this shape any more — Studio, the SDK and
   * the plugin surface all send `labelIds` — but batch rows, operations and
   * workflow documents persisted under the old shape are still on disk, and
   * a union that dropped this member would fail to parse them rather than
   * run them. Migration 0080 gave every old tag a label of the SAME name, so
   * `resolveTargetSet` resolves this member by label name and lands on the
   * devices it always meant.
   */
  z.object({ tags: z.array(z.string().min(1)).min(1) }),
])
export type Target = z.infer<typeof TargetSchema>

export const ACTION_VERBS = [
  'run-script',
  'run-workflow',
  'install',
  'push',
  'pull',
  'adb',
  'wake',
  'sleep',
  // The device's PANEL, which is not the device's sleep (plan 227 §3.3).
  //
  // `sleep` puts Android itself to sleep: the phone is asleep, the tile goes
  // dark, and the state survives this core dying because Android owns it.
  // These two set a display POWER MODE over the session's existing scrcpy
  // control socket — the panel goes dark, the encoder keeps producing frames,
  // and the wall keeps showing the phone. Two bytes, no adb.
  //
  // They are deliberately not one verb with a boolean: every other verb in
  // this list is a thing an operator does, named as they would name it, and a
  // farm's action bar reads better with two buttons than with one that needs
  // its argument read.
  'screen-off',
  'screen-on',
  'reconnect',
  'disconnect',
  'cutover',
  'forget',
  'block',
  'unquarantine',
  'set-network',
  // The device's PHYSICAL label — the number written onto its lock screen or
  // wallpaper (plan 89, `device/labelling.ts`, the guest agent's own
  // `screen-label` capability). Renamed from `set-label`/`clear-label` by
  // plan 225, which introduced `set-labels` a single keystroke away with an
  // entirely different meaning: putting an operator's coloured labels ON a
  // device row. Two verbs that differ by one character and share no
  // behaviour is a mistake waiting to be typed.
  'apply-screen-label',
  'clear-screen-label',
  'set-group',
  'set-labels',
  'prepare',
  'retry-prepare',
  // The guest agent, reachable by hand (CEO, 2026-09-04). Detecting an
  // outdated agent already reinstalls it automatically — these exist because
  // production is not the happy path: an install that reported success and
  // did not stick, a phone that refused the accessibility grant, a local
  // build the version check cannot see. `install-agent` forces the
  // uninstall+reinstall+reverify cycle the launcher already owns;
  // `uninstall-agent` removes it, which is also how an operator turns the
  // agent off for one device.
  'install-agent',
  'uninstall-agent',
  'reprofile',
  'screenshot',
  'clear-cache',
  'settings',
] as const
export const ActionVerbSchema = z.enum(ACTION_VERBS)
export type ActionVerb = z.infer<typeof ActionVerbSchema>

/** The `pacing` block `POST /api/batches` took (plan 94 §4.9), unchanged. */
const PacingSchema = z
  .object({
    count: z.number().int().min(1).max(1000).default(1),
    intervalMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([0, 0]),
    deviceIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
    /**
     * A per-device random start delay, drawn independently for each member —
     * "start them together but not at the same instant".
     *
     * `deviceIntervalMs` above is a fixed ladder and fixes the wall-clock
     * ORDER as a side effect: the phone at the end of the list is always
     * last. This gives every device a different wait without ranking them,
     * which is what "10-30 seconds each" means. The two compose.
     */
    deviceDelayMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([0, 0]),
    /**
     * How many devices share one rung of the `deviceIntervalMs` ladder — the
     * client's **sub-groups**.
     *
     * `1` (the default) is the ladder as it always was: every phone gets its
     * own rung, so on a 70-device fleet at 30 s the last phone starts 35
     * minutes in. `10` steps the ladder once per ten phones instead, so the
     * fleet goes out in waves of ten.
     *
     * This is a wave in TIME, not a barrier: wave 2 starts one rung after
     * wave 1 started, not when wave 1 finished. That is deliberate. A true
     * "when the previous wave is done" gate has to hold jobs with no release
     * date, and a core that restarts mid-batch would leave them held with
     * nothing to release them. `concurrency` is the hard cap on how many run
     * at once and already gives the guarantee the waves are wanted for; the
     * ladder decides when each wave is *offered*, and the two compose.
     */
    waveSize: z.number().int().min(1).max(1000).default(1),
  })
  .refine((p) => p.intervalMs[0] <= p.intervalMs[1], 'the interval range is inverted')
  .refine((p) => p.deviceDelayMs[0] <= p.deviceDelayMs[1], 'the per-device delay range is inverted')

/**
 * A two-level partial of `DeviceSettingsSchema`: every top-level block optional,
 * every field inside a block optional. Built from `DeviceSettingsSchema.shape`
 * so a block added later cannot be missed; `actions.test.ts` pins the key set.
 * A block that is not a `ZodObject` after unwrapping its default (today `timing`
 * is `TimingSettingsSchema.default(...)`) is unwrapped with `.unwrap()` first.
 *
 * `prep` needs one more unwrap than any other block: its schema is
 * `z.preprocess(normaliseLegacyPrep, z.object({...})).default({...})`
 * (`settings.ts`, for the legacy-shape migration `normaliseLegacyPrep`
 * handles), so unwrapping its `ZodDefault` lands on the `z.preprocess`
 * wrapper itself (Zod4: `ZodPreprocess`, a `ZodPipe` under the hood, `out`
 * points at the object it wraps), never directly on a `ZodObject` — the
 * `instanceof z.ZodObject` check below used to fail for this one block only,
 * silently skipping `.partial()` and requiring every `prep` field the moment
 * `prep` was mentioned at all (caught via `actions.test.ts` asserting
 * `{prep:{rotation:'device'}}` alone parses).
 */
export const DeviceSettingsPatchSchema = z.object(
  Object.fromEntries(
    Object.entries(DeviceSettingsSchema.shape).map(([key, block]) => {
      const defaultUnwrapped = block instanceof z.ZodDefault ? block.unwrap() : block
      const inner =
        !(defaultUnwrapped instanceof z.ZodObject) && 'out' in defaultUnwrapped && (defaultUnwrapped as { out: unknown }).out instanceof z.ZodObject
          ? (defaultUnwrapped as { out: z.ZodObject }).out
          : defaultUnwrapped
      return [key, (inner instanceof z.ZodObject ? inner.partial() : inner).optional()]
    }),
  ),
)
export type DeviceSettingsPatch = z.infer<typeof DeviceSettingsPatchSchema>

const CommonSchema = z.object({
  target: TargetSchema,
  /** MVP 04 §1.3: acknowledges `warn` decisions; never overrides `forbid`. */
  force: z.boolean().default(false),
})

/** One member per verb. `params` is the verb's own body, flattened beside `target` on the wire (MVP 07 §1.1). */
export const ActionRequestSchema = z.discriminatedUnion('verb', [
  CommonSchema.extend({
    verb: z.literal('run-script'),
    scriptId: z.string().min(1).optional(),
    /** `name@version` or `name@latest`, resolved by the script registry, the same `scriptRef` `POST /api/jobs` took. */
    scriptRef: z.string().min(1).optional(),
    params: z.unknown().optional(),
    concurrency: z.number().int().min(0).default(0),
    order: z.enum(['as-listed', 'random']).default('as-listed'),
    priority: z.number().int().optional(),
    runtimeOverride: z.unknown().optional(),
    pacing: PacingSchema.optional(),
    /**
     * The caller asked for a batch by name (the Batches tab's own Run
     * button), so the batch stays visible as a batch even with one member.
     * Default `false` keeps every existing caller exactly as it was.
     */
    explicit: z.boolean().optional(),
    /** Plan 211 §4.8 — re-run an existing job: adds a run rather than creating a batch. */
    jobId: z.string().optional(),
  }).refine((b) => Boolean(b.jobId) || Boolean(b.scriptId) !== Boolean(b.scriptRef), 'exactly one of scriptId or scriptRef'),
  CommonSchema.extend({
    verb: z.literal('run-workflow'),
    workflowName: z.string().min(1),
    params: z.unknown().optional(),
    /**
     * The same three batch controls `run-script` above has taken since plan
     * 94, added by plan 313 §4.4. A workflow batch IS a batch row, and
     * `createBatchPacer` is generic over batch rows, so the stagger, the
     * per-device delay draw and the random device order all already worked —
     * they were simply never reachable, because this verb hardcoded
     * `concurrency: 0, order: 'as-listed'` and sent no pacing at all.
     */
    concurrency: z.number().int().min(0).default(0),
    order: z.enum(['as-listed', 'random']).default('as-listed'),
    priority: z.number().int().optional(),
    pacing: PacingSchema.optional(),
    /** Plan 211 §4.8 — re-run an existing workflow job: adds a run rather than creating a batch. */
    jobId: z.string().optional(),
  }),
  CommonSchema.extend({
    verb: z.literal('install'),
    artifactId: z.string().min(1),
    reinstall: z.boolean().optional(),
    grantPermissions: z.boolean().optional(),
    allowDowngrade: z.boolean().optional(),
  }),
  CommonSchema.extend({
    verb: z.literal('push'),
    artifactId: z.string().min(1),
    remotePath: z.string().min(1),
    mediaScan: z.enum(['auto', 'always', 'never']).default('auto'),
  }),
  CommonSchema.extend({ verb: z.literal('pull'), remotePath: z.string().min(1) }),
  CommonSchema.extend({ verb: z.literal('adb'), cmd: z.string().min(1).max(4096) }),
  CommonSchema.extend({ verb: z.literal('wake') }),
  CommonSchema.extend({ verb: z.literal('sleep') }),
  CommonSchema.extend({ verb: z.literal('screen-off') }),
  CommonSchema.extend({ verb: z.literal('screen-on') }),
  CommonSchema.extend({ verb: z.literal('reconnect'), allowSweep: z.boolean().optional() }),
  CommonSchema.extend({ verb: z.literal('disconnect') }),
  CommonSchema.extend({
    verb: z.literal('cutover'),
    op: z.enum(['start', 'cancel']).default('start'),
    medium: ConnectionMediumSchema.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    address: z.string().min(1).optional(),
  }).refine((b) => b.op === 'cancel' || b.medium !== undefined, 'medium is required to start a cutover'),
  CommonSchema.extend({ verb: z.literal('forget'), deleteHistory: z.boolean().default(false) }),
  CommonSchema.extend({ verb: z.literal('block'), reason: z.string().min(1).optional() }),
  CommonSchema.extend({ verb: z.literal('unquarantine') }),
  CommonSchema.extend({
    verb: z.literal('set-network'),
    op: z.enum(['set', 'enable', 'disable', 'retry', 'clear']).default('set'),
    /** Unparsed on purpose, exactly as `DeviceNetworkApplyBodySchema.route` was (its doc comment): the door re-parses and refuses credentials. */
    route: z.record(z.string(), z.unknown()).optional(),
  }).refine((b) => b.op !== 'set' || b.route !== undefined, 'route is required for op: set'),
  CommonSchema.extend({ verb: z.literal('apply-screen-label') }),
  CommonSchema.extend({ verb: z.literal('clear-screen-label'), restoreOriginal: z.boolean().default(false) }),
  CommonSchema.extend({ verb: z.literal('set-group'), groupId: z.string().min(1).nullable() }),
  /**
   * Put labels on, or take them off, every device in the target (plan 225
   * §4.5). Three ops rather than the whole-set PUT `set-tags` was, because
   * the surface that needs this most is a multi-device context menu: "add
   * Smoke Pool to these twelve phones" must not erase whatever else each of
   * the twelve already carries, which a replace would.
   */
  CommonSchema.extend({
    verb: z.literal('set-labels'),
    op: z.enum(['add', 'remove', 'replace']).default('add'),
    labelIds: z.array(z.string().min(1)),
  }),
  CommonSchema.extend({ verb: z.literal('prepare'), forceRecheck: z.boolean().default(false) }),
  CommonSchema.extend({ verb: z.literal('retry-prepare'), component: z.string().min(1) }),
  CommonSchema.extend({ verb: z.literal('install-agent') }),
  CommonSchema.extend({ verb: z.literal('uninstall-agent') }),
  CommonSchema.extend({ verb: z.literal('reprofile') }),
  CommonSchema.extend({ verb: z.literal('screenshot') }),
  CommonSchema.extend({ verb: z.literal('clear-cache'), package: z.string().min(1).max(256) }),
  CommonSchema.extend({ verb: z.literal('settings'), settings: DeviceSettingsPatchSchema }),
])
export type ActionRequest = z.infer<typeof ActionRequestSchema>
/**
 * What a CALLER must supply for one verb — built from the schema's INPUT
 * type, not its output, so a field the schema defaults is optional here
 * (plan 313 §4.4). `ActionRequest` is the parsed, server-side shape where
 * every default has been applied; a client is exactly the party that has
 * not applied them yet. Before this, adding `concurrency`/`order` to
 * `run-workflow` would have forced every re-run call site — which creates
 * no batch at all — to name two batch controls it has no opinion about.
 */
export type ActionParams<V extends ActionVerb> = Omit<Extract<z.input<typeof ActionRequestSchema>, { verb: V }>, 'verb' | 'target' | 'force'>

/** MVP 07 §1.2. `accepted`/`done`/`failed` are the life of an async verb; `done`/`failed` the whole life of a sync one. */
export const ActionResultStatusSchema = z.enum(['accepted', 'skipped', 'forbidden', 'warned', 'done', 'failed'])
export type ActionResultStatus = z.infer<typeof ActionResultStatusSchema>

export const ActionResultSchema = z.object({
  deviceId: z.string(),
  status: ActionResultStatusSchema,
  /** The policy sentence for `warned`/`forbidden`, the skip reason, or the failure message. */
  message: z.string().optional(),
  /** The coded error for `forbidden`/`failed` (`E_DEVICE_CONFLICT`, `auth.forbidden`, `job_running`, ...). */
  code: z.string().optional(),
  /** The activity this verb started on the device (plan 205 ids: `transfer:<id>`, `command:<operationId>:<deviceId>`, ...). */
  activityId: z.string().optional(),
  jobId: z.string().optional(),
  batchId: z.string().optional(),
  /** Plan 211 §4.8 — the run this action added or created, for `run-script`/`run-workflow`. */
  runId: z.string().optional(),
  /** Verb-specific outcome for `done`: `ReconnectOutcome`, `CutoverState`, `DeviceLabelState`, `DeviceReadiness`, `{ artifactId, bytes }`, `{ exitCode, stdout, stderr, truncated, durationMs }`, ... Parsed by the caller with the verb's own schema. */
  detail: z.unknown().optional(),
})
export type ActionResult = z.infer<typeof ActionResultSchema>

export const ActionResponseSchema = z.object({
  operationId: z.string(),
  verb: ActionVerbSchema,
  results: z.array(ActionResultSchema),
})
export type ActionResponse = z.infer<typeof ActionResponseSchema>

/** `GET /api/operations/:id`. */
export const OperationSchema = ActionResponseSchema.extend({
  target: TargetSchema,
  createdBy: z.string().nullable(),
  /** Unix seconds. */
  createdAt: z.number().int(),
  /** True once no result is `accepted`. */
  settled: z.boolean(),
})
export type Operation = z.infer<typeof OperationSchema>
export const OperationResponseSchema = z.object({ operation: OperationSchema })

/** Whole-request refusals; per-device outcomes never use HTTP status. */
export const ACTION_ERROR_CODES = {
  E_UNKNOWN_VERB: 404,
  E_BAD_REQUEST: 400,
  'auth.forbidden': 403,
  group_not_found: 404,
  operation_not_found: 404,
  E_NOT_SUPPORTED: 501,
  unknown_script: 400,
  script_disabled: 409,
  invalid_job_params: 400,
  params_incompatible: 409,
  E_RUNTIME_ENVELOPE_INVALID: 400,
  E_RUNTIME_OVER_CEILING: 400,
} as const

/** `actions.run` (capability/actions.ts): the request without the flattening, so a plugin passes `params` as one object. */
export const ActionCapabilityInputSchema = z.object({
  verb: ActionVerbSchema,
  target: TargetSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  force: z.boolean().default(false),
})
export type ActionCapabilityInput = z.infer<typeof ActionCapabilityInputSchema>
