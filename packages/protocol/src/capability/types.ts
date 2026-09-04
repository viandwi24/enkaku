import type { z } from 'zod'
import type { CapabilityError } from './errors'
import type { ActivityKind } from '../activity'

/**
 * `'read'` observes; safe to retry, safe to run unattended.
 * `'write'` changes device or farm state; a retry may duplicate.
 * `'destructive'` is hard or impossible to undo (`device.install`).
 *
 * This is the field Plan 65's per-agent policy and Plan 66's approval gate
 * both read later — neither has to keep its own list of dangerous operations
 * (plan 63 §3.2).
 */
export type CapabilityEffect = 'read' | 'write' | 'destructive'

/**
 * What a capability does to a device (MVP 04 §1.4, plan 205 §4.4). `null` —
 * no device involved (`script.list`). `kind: 'read'` — the device must be
 * online, nothing is started and the policy is not consulted
 * (`device.inspect.dump`). Any other kind is evaluated against the device's
 * live activities before the handler runs (`device.tap` declares `control`).
 */
export interface CapabilityActivity {
  kind: ActivityKind | 'read'
  exclusiveWith?: ActivityKind[]
}

/**
 * One declaration of one operation the farm can perform (plan 63 §3.2) — id,
 * input, output, permission, activity requirement, deadline, side-effect class
 * and a model-facing description, all in one place.
 *
 * Generic over `Ctx`: `@enkaku/protocol` has zero runtime dependencies
 * beyond zod (00-overview §3 — the DB driver, drivers, and session layers
 * all sit ABOVE it), so it cannot type a concrete "reach a device session"
 * context here. `@enkaku/core`'s `capability/context.ts` defines the real
 * `CapabilityContext` every handler actually runs against and pins `Ctx` to
 * it (`CoreCapability` in `capability/types.ts`). Only the shape that is
 * genuinely dependency-free — id/input/output/permission/activity/deadline/
 * effect/description plus the handler signature — lives here.
 */
export interface Capability<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, Ctx = unknown> {
  /** Stable, dotted, and never reused: 'device.tap', 'script.publish'. */
  id: string
  input: I
  output: O
  /** A permission id from the host's own ACL — kept as `string` here (not
   * imported) for the same zero-dependency reason as `Ctx`; `@enkaku/core`'s
   * `CoreCapability` narrows it to the real `Permission` union. */
  permission: string
  /** `undefined` for a device-less capability. */
  activity?: CapabilityActivity
  /** Milliseconds. Enforced by the executor (`invoke`), never by the handler. */
  deadline: number
  effect: CapabilityEffect
  /**
   * Written for a model, in English, saying what it does, when to use it,
   * and what it returns — a prompt, not a code comment (plan 63 §3.2).
   */
  description: string
  handler: (ctx: Ctx, input: z.infer<I>) => Promise<z.infer<O>>
}

/** A `Capability` with its generics erased to `z.ZodType` — the shape a
 * heterogeneous registry actually stores (every entry has a DIFFERENT I/O). */
export type AnyCapability<Ctx = unknown> = Capability<z.ZodType, z.ZodType, Ctx>

/**
 * What `invoke` (plan 63 §3.4) hands back — never a bare string (plan 63
 * §3.3, acceptance #12). `output`'s shape is whatever the capability's own
 * `output` schema declares; success is never determined by matching text.
 * `warning`, added by plan 205 §4.4, is set on a success whose activity
 * policy answered `warn` — a sentence naming the conflicting activity,
 * absent when nothing conflicted.
 */
export type CapabilityResult<O = unknown> = { ok: true; output: O; warning?: string } | { ok: false; error: CapabilityError }
