import { DEVICE_CALL_ARGS, JobStatusSchema, ScriptRefSchema } from '@enkaku/protocol'
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
 * The seventeen device operations are declared once either way.
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
    ttlSec: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('setIfVersion'),
    scope: KvScopeSchema,
    key: z.string(),
    value: z.unknown(),
    expectedVersion: z.number().int(),
    secret: z.boolean().optional(),
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
  }),
  z.object({ t: z.literal('phase'), phase: z.enum(['prepare', 'run', 'finish']) }),
  z.intersection(z.object({ t: z.literal('device.call'), callId: z.string() }), DeviceCallSchema),
  z.intersection(z.object({ t: z.literal('kv.call'), callId: z.string() }), KvCallSchema),
  z.intersection(z.object({ t: z.literal('jobs.call'), callId: z.string() }), JobsCallSchema),
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
  z.object({
    t: z.literal('result'),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: ScriptErrorSchema.optional(),
    /** Lets the parent know whether a finish-only attempt is still needed. */
    finishRan: z.boolean(),
  }),
])
export type ChildToParent = z.infer<typeof ChildToParentSchema>

export const ParentToChildSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('init'),
    mode: z.enum(['full', 'finish-only']),
    job: z.object({ id: z.string(), attempt: z.number().int(), deviceId: z.string() }),
    params: z.unknown(),
    priorError: z.object({ code: z.string(), message: z.string(), phase: z.string() }).optional(),
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
  // 'crashed' (plan 37 §3.5, §4.4): the target application crashed mid-run —
  // the runner (`job-runner.ts`) maps this to `APP_CRASHED` and still runs
  // `finish()`, exactly like every other abort reason (spec §11.3).
  // 'startup-timeout' (plan 74 §3.2, §4.2): the child never sent `ready` —
  // it is not slow, it is broken, and this fires long before the run
  // timeout would.
  z.object({ t: z.literal('abort'), reason: z.enum(['timeout', 'cancelled', 'hung', 'crashed', 'startup-timeout']) }),
])
export type ParentToChild = z.infer<typeof ParentToChildSchema>
