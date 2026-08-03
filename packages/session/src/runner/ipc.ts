import { PointSchema, SelectorSchema } from '@enkaku/protocol'
import { z } from 'zod'

/**
 * The parent ⇄ child IPC protocol (plan 05 §4.6). Every message is JSON,
 * safeParse'd on both sides; unknown messages are ignored (forward-compatible).
 *
 * The child NEVER opens adb itself — every device action travels as a
 * `device.call` to the parent, so the per-device queue and lease still hold.
 */

/** The gesture engine's easing options (plan 40 §4.1) — mirrored here rather
 * than imported from `@enkaku/drivers`, since `@enkaku/protocol` (where this
 * schema effectively lives, through `DeviceCallSchema`'s consumers) sits
 * below `drivers` in the dependency graph. */
const GestureEasingSchema = z.enum(['linear', 'easeOutQuad', 'easeInOutCubic'])
const ScrollDirectionSchema = z.enum(['up', 'down', 'left', 'right'])

export const DeviceCallSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('tap'), args: z.object({ target: SelectorSchema }) }),
  z.object({
    method: z.literal('swipe'),
    args: z.object({
      from: PointSchema,
      to: PointSchema,
      ms: z.number().int().positive().default(300),
      /** Overrides `TimingSettings.gestureCurvature` for this call (plan 40 §4.4). */
      curvature: z.number().min(0).max(0.5).optional(),
      easing: GestureEasingSchema.optional(),
    }),
  }),
  /** A controlled drag that ends at low velocity and stops where it is put (plan 40 §3.4, §4.4). */
  z.object({
    method: z.literal('scroll'),
    args: z.object({
      direction: ScrollDirectionSchema,
      /** Pixels; defaults to 60% of the relevant viewport axis. */
      distance: z.number().positive().optional(),
      from: PointSchema.optional(),
    }),
  }),
  /** A short, fast gesture that ends at high velocity and lets the list coast (plan 40 §3.4, §4.4). */
  z.object({
    method: z.literal('fling'),
    args: z.object({
      direction: ScrollDirectionSchema,
      strength: z.enum(['soft', 'normal', 'hard']).optional(),
    }),
  }),
  z.object({
    method: z.literal('type'),
    args: z.object({
      text: z.string(),
      /** Overrides `TimingSettings.perCharMs` for this call (plan 40 §4.4). */
      perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
      /** Forces the pre-plan-40 bulk delivery for this call regardless of the timing profile (a long token, a paste target). */
      instant: z.boolean().optional(),
    }),
  }),
  z.object({ method: z.literal('key'), args: z.object({ code: z.union([z.number().int(), z.string()]) }) }),
  z.object({ method: z.literal('find'), args: z.object({ sel: SelectorSchema }) }),
  z.object({
    method: z.literal('waitFor'),
    args: z.object({
      sel: SelectorSchema,
      timeout: z.number().int().positive(),
      intervalMs: z.number().int().positive(),
    }),
  }),
  z.object({ method: z.literal('screenshot'), args: z.object({}) }),
  z.object({
    method: z.literal('app.launch'),
    // A package name is not a free string (plan 34 §3.4, §4.3) — the regex
    // mirrors Android's own package-name rules and rejects metacharacters
    // early with a clear error; `shellQuote` at the call site
    // (`device-executor.ts`) is what actually guarantees injection safety.
    args: z.object({
      pkg: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/),
      activity: z.string().regex(/^[a-zA-Z0-9_.$/]+$/).optional(),
    }),
  }),
  z.object({
    method: z.literal('app.forceStop'),
    args: z.object({ pkg: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/) }),
  }),
  z.object({ method: z.literal('clipboard.get'), args: z.object({}) }),
  z.object({
    method: z.literal('clipboard.set'),
    args: z.object({ text: z.string(), paste: z.boolean().default(false) }),
  }),
  // File transfer and APK install (plan 39 §4.6) — the child never touches
  // adb or the artifact store itself; `TransferPort` (see `../types.ts`) is
  // the parent-side implementation, exactly like every other device.call.
  z.object({
    method: z.literal('install'),
    args: z.object({
      artifactId: z.string().min(1),
      reinstall: z.boolean().optional(),
      grantPermissions: z.boolean().optional(),
      allowDowngrade: z.boolean().optional(),
    }),
  }),
  z.object({
    method: z.literal('push'),
    args: z.object({ artifactId: z.string().min(1), remotePath: z.string().min(1) }),
  }),
  z.object({
    method: z.literal('pull'),
    args: z.object({ remotePath: z.string().min(1) }),
  }),
])
export type DeviceCall = z.infer<typeof DeviceCallSchema>

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
  // 'crashed' (plan 37 §3.5, §4.4): the target application crashed mid-run —
  // the runner (`job-runner.ts`) maps this to `APP_CRASHED` and still runs
  // `finish()`, exactly like every other abort reason (spec §11.3).
  z.object({ t: z.literal('abort'), reason: z.enum(['timeout', 'cancelled', 'hung', 'crashed']) }),
])
export type ParentToChild = z.infer<typeof ParentToChildSchema>
