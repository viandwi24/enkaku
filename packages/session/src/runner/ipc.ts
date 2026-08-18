import { DEVICE_CALL_ARGS, JobStatusSchema, ResultOutcomeSchema, RuntimeEnvelopeSchema, ScriptRefSchema } from '@enkaku/protocol'
import { z } from 'zod'

/**
 * The parent ⇄ child IPC protocol (plan 05 §4.6). Every message is JSON,
 * safeParse'd on both sides; unknown messages are ignored (forward-compatible).
 *
 * The child NEVER opens adb itself — every device action travels as a
 * `device.call` to the parent, so the per-device queue and lease still hold.
 *
 * Each variant's `args` shape comes from `@enkaku/protocol`'s
 * `DEVICE_CALL_ARGS` (plan 63 §3.7) — the SAME schema `@enkaku/core`'s
 * `device.*` capabilities extend with `{ deviceId }`. `@enkaku/session`
 * cannot import the capability registry itself (core depends on session,
 * never the reverse), so the shared source sits one level below both,
 * in protocol; only the `{ method: literal, args }` IPC framing stays here.
 * Twenty-one device operations are declared once either way (plan 94 §4.4,
 * step 94.2 added the last four: `gesture`, `longPress`, `tapNorm`,
 * `swipeNorm` — the replay's own verbs, F6/F7).
 */
export const DeviceCallSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('tap'), args: DEVICE_CALL_ARGS.tap }),
  z.object({ method: z.literal('swipe'), args: DEVICE_CALL_ARGS.swipe }),
  /** A controlled drag that ends at low velocity and stops where it is put (plan 40 §3.4, §4.4). */
  z.object({ method: z.literal('scroll'), args: DEVICE_CALL_ARGS.scroll }),
  /** A short, fast gesture that ends at high velocity and lets the list coast (plan 40 §3.4, §4.4). */
  z.object({ method: z.literal('fling'), args: DEVICE_CALL_ARGS.fling }),
  z.object({ method: z.literal('type'), args: DEVICE_CALL_ARGS.type }),
  z.object({ method: z.literal('key'), args: DEVICE_CALL_ARGS.key }),
  z.object({ method: z.literal('find'), args: DEVICE_CALL_ARGS.find }),
  /**
   * The whole accessibility tree, the same one the Inspect panel renders
   * (plan 60 §3.2). No arguments: a dump is a dump, and everything a script
   * wants to do with it is ordinary TypeScript over the returned nodes.
   */
  z.object({ method: z.literal('dump'), args: DEVICE_CALL_ARGS.dump }),
  z.object({ method: z.literal('waitFor'), args: DEVICE_CALL_ARGS.waitFor }),
  z.object({ method: z.literal('screenshot'), args: DEVICE_CALL_ARGS.screenshot }),
  // A package name is not a free string (plan 34 §3.4, §4.3) — the regex
  // mirrors Android's own package-name rules and rejects metacharacters
  // early with a clear error; `shellQuote` at the call site
  // (`device-executor.ts`) is what actually guarantees injection safety.
  z.object({ method: z.literal('app.launch'), args: DEVICE_CALL_ARGS['app.launch'] }),
  z.object({ method: z.literal('app.forceStop'), args: DEVICE_CALL_ARGS['app.forceStop'] }),
  z.object({ method: z.literal('clipboard.get'), args: DEVICE_CALL_ARGS['clipboard.get'] }),
  z.object({ method: z.literal('clipboard.set'), args: DEVICE_CALL_ARGS['clipboard.set'] }),
  // File transfer and APK install (plan 39 §4.6) — the child never touches
  // adb or the artifact store itself; `TransferPort` (see `../types.ts`) is
  // the parent-side implementation, exactly like every other device.call.
  z.object({ method: z.literal('install'), args: DEVICE_CALL_ARGS.install }),
  z.object({ method: z.literal('push'), args: DEVICE_CALL_ARGS.push }),
  z.object({ method: z.literal('pull'), args: DEVICE_CALL_ARGS.pull }),
  // Plan 94 §4.4, step 94.2 (F6, F7) — the replay's own four verbs. `gesture`
  // and `tapNorm`/`swipeNorm` carry NORMALISED coordinates on purpose (see
  // `device-args.ts`'s own comment on `TapNormArgsSchema` for the full rule)
  // — `device-executor.ts` is where they get mapped to this run's actual
  // device pixels, exactly like manual input already is.
  z.object({ method: z.literal('gesture'), args: DEVICE_CALL_ARGS.gesture }),
  z.object({ method: z.literal('longPress'), args: DEVICE_CALL_ARGS.longPress }),
  z.object({ method: z.literal('tapNorm'), args: DEVICE_CALL_ARGS.tapNorm }),
  z.object({ method: z.literal('swipeNorm'), args: DEVICE_CALL_ARGS.swipeNorm }),
])
export type DeviceCall = z.infer<typeof DeviceCallSchema>

/**
 * The KV store's child⇄parent protocol (plan 79 §4.4) — a `kv.call` /
 * `kv.result` round trip, the SAME shape `device.call` / `device.result`
 * already use. Declared here, self-contained, rather than sourced from
 * `@enkaku/protocol` the way `DeviceCallSchema` is: unlike `device.*`, the kv
 * store is never exposed as an `invoke()` capability (plan 79 is IPC + a
 * REST admin surface only), so there is no second definition anywhere else
 * in the registry this would need to stay identical to.
 */
export const KvScopeSchema = z.enum(['global', 'device'])
export type KvScopeKind = z.infer<typeof KvScopeSchema>

export const KvCallSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), scope: KvScopeSchema, key: z.string() }),
  z.object({
    op: z.literal('set'),
    scope: KvScopeSchema,
    key: z.string(),
    value: z.unknown(),
    secret: z.boolean().optional(),
    /**
     * Whether a secret write also stores its display hint (plan 112 step 112.2). Optional, and
     * ABSENT means `true` — the store's own default (`KvSetOptions.hint`), so every caller that
     * predates this field sends the same message and gets the same row. `false` is the opt-out a
     * caller storing a credential must send, because the hint is `${first 7}…${last 4}` of the
     * plaintext, kept in the clear on the row and returned by every read path.
     */
    hint: z.boolean().optional(),
    ttlSec: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('setIfVersion'),
    scope: KvScopeSchema,
    key: z.string(),
    value: z.unknown(),
    expectedVersion: z.number().int(),
    secret: z.boolean().optional(),
    /** As `set`'s — absent means `true`. */
    hint: z.boolean().optional(),
    ttlSec: z.number().int().positive().optional(),
  }),
  z.object({ op: z.literal('increment'), scope: KvScopeSchema, key: z.string(), by: z.number().optional() }),
  z.object({ op: z.literal('delete'), scope: KvScopeSchema, key: z.string(), ifVersion: z.number().int().optional() }),
  z.object({
    op: z.literal('list'),
    scope: KvScopeSchema,
    prefix: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    cursor: z.string().optional(),
  }),
])
export type KvCall = z.infer<typeof KvCallSchema>

/**
 * `ctx.jobs`'s child⇄parent protocol (plan 80 §4.2) — a `jobs.call` /
 * `jobs.result` round trip, the SAME shape `kv.call` above already uses.
 * Self-contained here rather than sourced from `@enkaku/protocol`, for the
 * same reason `KvCallSchema` is: `ctx.jobs` is never an `invoke()`
 * capability, so there is no second definition anywhere in the registry this
 * would need to stay identical to. `JobStatusSchema` is the one piece that
 * DOES come from `@enkaku/protocol` — it is already the shared source for
 * every job-status literal in the codebase, and duplicating its six values
 * here would be exactly the drift plan 63 §3.7 removed from `DeviceCallSchema`.
 */
export const JobsCallSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('list'),
    status: JobStatusSchema.optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().nullable().optional(),
  }),
  z.object({ method: z.literal('previous') }),
  z.object({ method: z.literal('queuedAfter'), limit: z.number().int().positive().optional() }),
  z.object({ method: z.literal('resultOf'), jobId: z.string() }),
  /**
   * `ctx.jobs.trigger()` (plan 81 §4.2, §4.3) — fire-and-forget: enqueues
   * another job and returns its id, never its result. `key` is REQUIRED at
   * this wire boundary (never optional here) because the default derivation
   * described in plan 81 §3.3 (`${jobId}:${attempt}:${callIndex}`) needs the
   * caller's own attempt number, which is only known CHILD-side (`ctx.job`)
   * — `jobs-client.ts`'s `trigger()` always resolves a concrete key, whether
   * the script supplied one or not, before this message is ever sent, so the
   * parent never has to guess at an attempt number it does not track on the
   * `jobs` row at all (attempts are never persisted — see `job-runner.ts`).
   */
  z.object({
    method: z.literal('trigger'),
    script: ScriptRefSchema,
    params: z.unknown().optional(),
    deviceId: z.string().optional(),
    priority: z.number().int().optional(),
    key: z.string().min(1),
    expiresAt: z.number().int().nullable().optional(),
  }),
])
export type JobsCall = z.infer<typeof JobsCallSchema>

/**
 * `ctx.farm`'s child⇄parent protocol (plan 109 §3.1, §4.3, step 109.1) — a
 * `farm.call` / `farm.result` round trip, the SAME shape `kv.call` and
 * `jobs.call` above already use.
 *
 * `input` is `z.unknown()` on purpose and is NOT validated here: the only
 * thing that may decide whether an input is well formed is the capability's
 * own `input` schema inside `invoke()` (plan 63 §3.4 step 1 — "`invoke` is
 * the ONLY door"). A second, weaker check at this boundary would be a second
 * definition of every capability's input, which is precisely the drift
 * plan 63 §3.7 removed from `DeviceCallSchema`.
 */
export const FarmCallSchema = z.object({
  /** A capability id — `device.list`, `job.run`. Refused by the broker unless the plugin's manifest declared it. */
  capability: z.string().min(1),
  input: z.unknown().optional(),
})
export type FarmCall = z.infer<typeof FarmCallSchema>

const ScriptErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  phase: z.string(),
  stack: z.string().optional(),
})

export const ChildToParentSchema = z.union([
  z.object({
    t: z.literal('ready'),
    scriptId: z.string(),
    version: z.string(),
    /**
     * The owning plugin's own id — `tiktok`, not `login` (plan 82 §3.10, plan
     * 79 §3.2) — set only when the bundle is a plugin bundle. This is what
     * `ctx.kv`'s namespace resolves to for a plugin member, so every script
     * in one plugin shares one kv namespace; undefined for a standalone
     * script, which keeps using its own `scriptId` as its namespace exactly
     * as before this field existed.
     */
    pluginId: z.string().optional(),
    /** Metadata from ScriptDefinition — only the child can read it. */
    timeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).max(10).optional(),
    /**
     * `ScriptDefinition.runtime` (plan 98 §3.1, §4.7, §5 step 98.4) — the
     * bundle's OWN declared envelope, folded from `timeout`/`retries` by
     * `defineScript`/`definePlugin` on the author's machine. This message
     * has stopped being the source of truth for a persisted script (the
     * pinned `scripts.runtime` DB row is, per §3.1's table) and become a
     * CHECK: the runner compares this against the row it was pinned to and
     * logs a warning naming both when they disagree, but always uses the
     * DB's value. The one case where this legitimately IS authoritative is
     * a plugin dev slot, which has no `scripts` row at all (§3.1).
     */
    runtime: RuntimeEnvelopeSchema.optional(),
    /**
     * ScriptDefinition.reset (plan 35 §4.3) — carried here so the parent
     * learns the declaration without importing the bundle itself. The
     * runner reads this to build the `declared`/`aggressive` reset plan.
     */
    reset: z
      .object({
        packages: z.array(z.string()),
        clearData: z.boolean().optional(),
      })
      .optional(),
    /**
     * `ScriptDefinition.assist` (plan 91 §3.6, §4.8) — whether an operator
     * may assist this script's job. Undefined for a pre-plan-91 bundle,
     * which the parent's `scriptAssistPolicy` hook reads as permissive
     * (`co-control.ts`'s own default), the same "omitted means allowed"
     * shape `reset` above already established for a field the child only
     * learns from the bundle.
     */
    assist: z.enum(['allow', 'deny']).optional(),
  }),
  z.object({ t: z.literal('phase'), phase: z.enum(['prepare', 'run', 'finish']) }),
  z.intersection(z.object({ t: z.literal('device.call'), callId: z.string() }), DeviceCallSchema),
  z.intersection(z.object({ t: z.literal('kv.call'), callId: z.string() }), KvCallSchema),
  z.intersection(z.object({ t: z.literal('jobs.call'), callId: z.string() }), JobsCallSchema),
  z.intersection(z.object({ t: z.literal('farm.call'), callId: z.string() }), FarmCallSchema),
  z.object({
    t: z.literal('artifact.save'),
    callId: z.string(),
    kind: z.enum(['screenshot', 'file']),
    label: z.string(),
    /** Only kind 'file'; screenshots are taken core-side. */
    dataBase64: z.string().optional(),
    ext: z.string().optional(),
  }),
  z.object({
    t: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    msg: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ t: z.literal('heartbeat') }),
  /**
   * Self-reported RSS (plan 98 §3.5, §4.7, H1) — measured with
   * `process.memoryUsage.rss()`, the same call §0.3 measurement M2/M4
   * verified works with no flags. Sent once immediately when a 'full' or
   * 'finish-only' attempt starts (so even a job shorter than the sample
   * interval gets at least one reading) and then on `init.rssSampleMs`'s own
   * cadence. This step records the PEAK unconditionally; no limit reads it
   * yet — that is step 98.3.
   */
  z.object({ t: z.literal('rss'), bytes: z.number().int().nonnegative() }),
  z.object({
    t: z.literal('result'),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: ScriptErrorSchema.optional(),
    /** Lets the parent know whether a finish-only attempt is still needed. */
    finishRan: z.boolean(),
    /**
     * Plan 97 §3.3, §3.4, §3.8, §4.3 — the child's own verdict on `value`:
     * measured, walked for a prototype-hijack field name, and (when the
     * script declared `result:`) checked against the real Zod schema, in
     * that order (H2, step 97.3's own title — "measure, then check, then
     * store"). OPTIONAL so a bundle built before this plan — a real case,
     * bundles are stored in the DB — still parses; a MISSING `outcome` means
     * `undeclared` (a pre-plan-97 bundle never reports one, even though it
     * still sends `value` exactly as it always has). Present only when
     * `ok: true` in this step (97.3's own scope is the success path only —
     * `outcome.status: 'partial'` for a `finish()` salvage is step 97.4's).
     */
    outcome: ResultOutcomeSchema.optional(),
  }),
  /**
   * Plan 97 §3.7, §4.3 — a live, unpersisted progress snapshot. Coalesced in
   * the CHILD (`child-entry.ts`'s own timer, last value wins) so a script
   * calling `ctx.progress()` in a tight loop costs one assignment, not one
   * IPC message per call — at most one of these arrives per
   * `job.progressIntervalMs`. The parent re-checks size and drops an
   * oversize push with one `warn` per job (`executor-host.ts`) rather than
   * trusting the child the way it does for `outcome` above (§3.8) — a
   * progress value has no measured-size counterpart the child reports back,
   * unlike a result's `outcome.bytes`.
   */
  z.object({ t: z.literal('progress'), value: z.unknown() }),
])
export type ChildToParent = z.infer<typeof ChildToParentSchema>

export const ParentToChildSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('init'),
    mode: z.enum(['full', 'finish-only']),
    job: z.object({
      id: z.string(),
      attempt: z.number().int(),
      deviceId: z.string(),
      /**
       * The workflow node this execution belongs to (plan 99 §3.2, §4.8) —
       * absent for every job outside a workflow. Threaded through to
       * `createJobsApiFor` (`jobs-client.ts`) so `ctx.jobs.trigger()`'s
       * default idempotency key does not collide across two nodes sharing
       * one `jobId` (plan 99 F20).
       */
      nodeId: z.string().optional(),
    }),
    params: z.unknown(),
    priorError: z.object({ code: z.string(), message: z.string(), phase: z.string() }).optional(),
    /**
     * Plan 98 §4.7 — the cadence the PARENT wants `rss` samples on. Fixed at
     * 10s in this step ("cadence 10 s, no limit anywhere") — once a memory
     * limit exists (step 98.3), the parent will send `job.memory.sampleIntervalMs`
     * instead whenever one is in effect.
     */
    rssSampleMs: z.number().int().positive(),
    /**
     * Plan 97 §3.4, §4.9 — the farm's `job.maxResultBytes` setting, resolved
     * by the parent (which holds the live settings store) and handed down so
     * the CHILD can enforce the cap before a value ever crosses IPC (F10,
     * F11 — the cap cannot be enforced after the fact, only before). Required
     * rather than optional, the same convention `rssSampleMs` above already
     * uses: the caller always resolves a concrete number (the farm default
     * when nothing is configured), never leaves the child to guess one.
     */
    maxResultBytes: z.number().int().positive(),
    /**
     * Plan 97 §3.7, §4.9 — the farm's `job.progressIntervalMs` setting,
     * resolved by the parent (which holds the live settings store) and
     * handed down so the CHILD's own coalescing timer (§3.7: "coalescing
     * lives in the child") runs at the operator's chosen cadence rather than
     * a hardcoded one. Optional, unlike `maxResultBytes` above: the runner
     * only resolves this for a 'full' attempt (`job-runner.ts`'s `sendInit`)
     * — a finish-only re-run's own short window has no live audience worth
     * the timer, and the child falls back to a sane default when it is
     * absent.
     */
    progressIntervalMs: z.number().int().positive().optional(),
  }),
  z.object({
    t: z.literal('device.result'),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    t: z.literal('artifact.result'),
    callId: z.string(),
    ok: z.boolean(),
    /**
     * The saved artifact's id (plan 115 §3.6) — what `ctx.artifact.file()`
     * hands back to a script. Present whenever `ok` is true; optional here
     * only for wire tolerance (a parent built before this plan never sent
     * it), never omitted by anything in this codebase today.
     */
    artifactId: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    t: z.literal('kv.result'),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    t: z.literal('jobs.result'),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    t: z.literal('farm.result'),
    callId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  // 'crashed' (plan 37 §3.5, §4.4): the target application crashed mid-run —
  // the runner (`job-runner.ts`) maps this to `APP_CRASHED` and still runs
  // `finish()`, exactly like every other abort reason (spec §11.3).
  // 'startup-timeout' (plan 74 §3.2, §4.2): the child never sent `ready` —
  // it is not slow, it is broken, and this fires long before the run
  // timeout would.
  z.object({ t: z.literal('abort'), reason: z.enum(['timeout', 'cancelled', 'hung', 'crashed', 'startup-timeout']) }),
  /**
   * The SECOND unsolicited parent→child push ever (plan 91 §3.6, §4.8) —
   * `abort` above is the first. A human sent input to this device while this
   * job was running. NOT an abort: the job keeps its lease, keeps running,
   * and `finish()` is not invoked because of this message. `actor` is
   * `userId`, or null when the assisting client is unauthenticated (local
   * mode) — the same "userId, or null when the core itself is the actor"
   * convention `DeviceEvent.actor` already documents, minus the `'job:<id>'`
   * form, which never applies here (a job cannot assist itself).
   */
  z.object({ t: z.literal('assist'), at: z.number().int(), actor: z.string().nullable() }),
])
export type ParentToChild = z.infer<typeof ParentToChildSchema>
