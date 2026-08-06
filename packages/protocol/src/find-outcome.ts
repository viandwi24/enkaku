import { z } from 'zod'
import { UiNodeSchema } from './ui-node'

/**
 * Plan 74 §3.4, §4.3 — completes plan 60's find guard, which has always
 * known WHY it refused a match and never had anywhere to say it.
 * `device-executor.ts` collapsed every non-match to a bare `null`, so a
 * caller could not tell:
 *
 * - **not-found** — nothing on screen matches; wait, or navigate;
 * - **rejected-oversized** — the selector matched a container filling the
 *   screen (plan 60 §3.1's guard); retrying the same selector never helps;
 * - **ambiguous** — several nodes matched; the selector needs narrowing.
 *
 * The reason travels BESIDE the result, never inside it (§3.5): a script's
 * own `find()` keeps returning `UiNode | null` unchanged — a bundle
 * published before this plan must keep working — and this richer shape is
 * what `findDetailed()` and the `device.find` capability hand back instead.
 *
 * A discriminated union, not an optional field, so a consumer that switches
 * on `reason` gets a typecheck failure the day a fourth reason is added,
 * rather than a silent fallthrough (§8 risk table).
 */
export const FindOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), node: UiNodeSchema }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['not-found', 'rejected-oversized', 'ambiguous']),
    matches: z.number().int(),
  }),
])
export type FindOutcome = z.infer<typeof FindOutcomeSchema>
