import { z } from 'zod'

/**
 * The six refusals `invoke` itself can produce (plan 63 §3.4), plus the
 * catch-all for anything unexpected. These are NOT the only codes a
 * `CapabilityResult` can carry — a handler's own domain error (e.g.
 * `EnkakuError('job_not_found', ...)`) passes through with its own code
 * unchanged, because collapsing "the job does not exist" into `E_INTERNAL`
 * would be a worse answer than the coded error the service already has.
 * This list is only the fixed set `invoke`'s SIX pipeline steps themselves
 * are allowed to produce (parse, permission, device grant, lease, readiness,
 * deadline) — one code per step, so a caller can act on "which check failed"
 * rather than parsing English.
 */
export const CAPABILITY_REFUSAL_CODES = [
  'E_BAD_INPUT',
  'E_FORBIDDEN',
  'E_NO_GRANT',
  'E_NEEDS_LEASE',
  'E_DEVICE_OFFLINE',
  'E_DEADLINE',
  'E_INTERNAL',
] as const

export const CapabilityRefusalCodeSchema = z.enum(CAPABILITY_REFUSAL_CODES)
export type CapabilityRefusalCode = z.infer<typeof CapabilityRefusalCodeSchema>

/**
 * A capability's error shape — `code` is deliberately `z.string()` rather
 * than the refusal enum above: a handler's own coded domain error (e.g.
 * `script_not_found`, `device_busy`) is a legitimate, MORE useful answer
 * than forcing every failure through the seven pipeline codes, and every
 * one of those existing codes is already a stable string across the
 * codebase (`EnkakuError.code`). `invoke`'s own six refusal steps only ever
 * populate this with a `CapabilityRefusalCode`.
 */
export const CapabilityErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})
export type CapabilityError = z.infer<typeof CapabilityErrorSchema>
