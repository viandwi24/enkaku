import { E_DEVICE_CONFLICT, type CapabilityResult } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import { EnkakuError } from '../util/errors'
import type { CapabilityContext } from './context'
import type { AnyCoreCapability } from './types'

/**
 * `invoke` is the ONLY door (00-overview §"AI Agents series", plan 63 §3.4).
 * Every one of the six checks below, in this fixed order, plus audit —
 * nothing that reaches a device or a service skips this function, and
 * nothing inside it can be reordered by a caller.
 *
 *   1. parse    — `raw` through `cap.input`. Never an `as`-cast.
 *   2. permission
 *   3. device grant (only when the input names a `deviceId`)
 *   4. activity policy (`cap.activity` present and its `kind` is not `'read'`)
 *   5. readiness (device online + woken, whenever `cap.activity` is present)
 *   6. run, under `cap.deadline`
 *   7. audit — every invocation, refusals included
 */

class DeadlineExceeded extends Error {}

function runWithDeadline<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded(`exceeded its ${ms}ms deadline`)), ms)
    run().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Both `EnkakuError` (core) and `SessionError` (`@enkaku/session`) are a
 * plain `Error` with a string `.code` — this lets a handler's own coded
 * domain error (`job_not_found`, `element_not_found`, ...) pass through
 * `invoke` with that SAME code, rather than being collapsed into
 * `E_INTERNAL` (see `errors.ts`'s comment on why `CapabilityError.code`
 * is `string`, not the closed refusal enum). */
function isCodedError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string'
}

/** Exported for `agent/loop/run.ts` (plan 66) — the loop needs to know which device a capability call targets to start the agent's own device activity on its behalf before invoking it; this is the SAME extraction `invoke` itself uses, not a second implementation. */
export function extractDeviceId(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'deviceId' in input) {
    const v = (input as { deviceId?: unknown }).deviceId
    return typeof v === 'string' ? v : undefined
  }
  return undefined
}

export interface InvokeDeps {
  audit?: AuditLogger
}

export async function invoke(cap: AnyCoreCapability, ctx: CapabilityContext, raw: unknown, deps?: InvokeDeps): Promise<CapabilityResult> {
  const startedAt = Date.now()

  const record = (outcome: 'ok' | 'refused' | 'error', code: string | null, deviceId?: string): void => {
    deps?.audit?.record({
      userId: ctx.actor?.id ?? null,
      action: 'capability.invoke',
      target: cap.id,
      meta: { outcome, code, deviceId: deviceId ?? null, durationMs: Date.now() - startedAt },
    })
  }

  const refuse = (code: 'E_BAD_INPUT' | 'E_FORBIDDEN' | 'E_NO_GRANT' | typeof E_DEVICE_CONFLICT | 'E_DEVICE_OFFLINE', message: string, deviceId?: string, details?: unknown): CapabilityResult => {
    record('refused', code, deviceId)
    return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } }
  }

  // 1. parse
  const parsed = cap.input.safeParse(raw)
  if (!parsed.success) {
    return refuse('E_BAD_INPUT', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), undefined, parsed.error.issues)
  }
  const input = parsed.data
  const deviceId = extractDeviceId(input)

  // 2. permission
  if (!ctx.hasPermission(cap.permission)) {
    return refuse('E_FORBIDDEN', `requires the "${cap.permission}" permission`, deviceId)
  }

  // 3. device grant
  if (deviceId && !ctx.canReachDevice(deviceId)) {
    return refuse('E_NO_GRANT', `no grant to reach device ${deviceId}`, deviceId)
  }

  // 4. activity policy — NEVER touched implicitly before this point (plan
  // 63 §3.4 step 4, plan 205 §4.4): a capability that silently started an
  // activity would let a caller interrupt an operator mid-gesture. A
  // `forbid` refusal names the conflicting activity (acceptance #5); a
  // device-less capability or one declaring `{ kind: 'read' }` never
  // consults the policy at all.
  let warning: string | null = null
  if (cap.activity && cap.activity.kind !== 'read' && deviceId) {
    const decision = ctx.evaluateActivity(deviceId, cap.activity.kind, cap.activity.exclusiveWith)
    if (decision.decision === 'forbid') {
      return refuse(E_DEVICE_CONFLICT, decision.message, deviceId)
    }
    if (decision.decision === 'warn') warning = decision.message
  }

  // 5. readiness — device online, then woken, whenever the capability
  // touches a device at all (plan 63 §3.4 step 5).
  if (deviceId && cap.activity) {
    if (!ctx.isDeviceOnline(deviceId)) {
      return refuse('E_DEVICE_OFFLINE', `device ${deviceId} is not reachable`, deviceId)
    }
    await ctx.ensureAwake(deviceId)
  }

  // 6. run, under deadline. On expiry `invoke` returns immediately; the
  // handler's own promise is left to settle in the background, where the
  // underlying adb call's own Plan 22.1 profile timeout is what actually
  // frees the per-device queue slot — `invoke` never blocks past the
  // capability's own deadline waiting for that to happen.
  try {
    const output = await runWithDeadline(() => cap.handler(ctx, input), cap.deadline)
    // The control marker is touched AFTER the handler succeeds, never
    // before — a capability that throws never claims the device (plan 205
    // §4.4). Only `control` refreshes a marker this way; every other kind is
    // evaluated against the policy above but does not maintain one here.
    if (cap.activity?.kind === 'control' && deviceId) {
      ctx.touchActivity(deviceId, 'control')
    }
    record('ok', null, deviceId)
    return warning !== null ? { ok: true, output, warning } : { ok: true, output }
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      record('refused', 'E_DEADLINE', deviceId)
      return { ok: false, error: { code: 'E_DEADLINE', message: err.message } }
    }
    if (err instanceof EnkakuError) {
      record('error', err.code, deviceId)
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (isCodedError(err)) {
      record('error', err.code, deviceId)
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    const message = err instanceof Error ? err.message : String(err)
    record('error', 'E_INTERNAL', deviceId)
    return { ok: false, error: { code: 'E_INTERNAL', message } }
  }
}
