import { PointSchema, SelectorSchema } from '@enkaku/protocol'
import { z } from 'zod'

/**
 * Protokol IPC parent ⇄ child (plan 05 §4.6). Semua message JSON,
 * di-safeParse di kedua sisi; message tak dikenal → abaikan (forward-compat).
 *
 * Child TIDAK pernah membuka adb sendiri — semua aksi device lewat
 * `device.call` ke parent, supaya per-device queue & lease tetap dihormati.
 */

export const DeviceCallSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('tap'), args: z.object({ target: SelectorSchema }) }),
  z.object({
    method: z.literal('swipe'),
    args: z.object({ from: PointSchema, to: PointSchema, ms: z.number().int().positive().default(300) }),
  }),
  z.object({ method: z.literal('type'), args: z.object({ text: z.string() }) }),
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
  z.object({ method: z.literal('app.launch'), args: z.object({ pkg: z.string(), activity: z.string().optional() }) }),
  z.object({ method: z.literal('app.forceStop'), args: z.object({ pkg: z.string() }) }),
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
    /** Meta dari ScriptDefinition — hanya child yang bisa membacanya. */
    timeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).max(10).optional(),
  }),
  z.object({ t: z.literal('phase'), phase: z.enum(['prepare', 'run', 'finish']) }),
  z.intersection(z.object({ t: z.literal('device.call'), callId: z.string() }), DeviceCallSchema),
  z.object({
    t: z.literal('artifact.save'),
    callId: z.string(),
    kind: z.enum(['screenshot', 'file']),
    label: z.string(),
    /** Hanya kind 'file'; screenshot diambil core-side. */
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
    /** Parent tahu apakah masih perlu finish-only attempt. */
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
  z.object({ t: z.literal('abort'), reason: z.enum(['timeout', 'cancelled', 'hung']) }),
])
export type ParentToChild = z.infer<typeof ParentToChildSchema>
