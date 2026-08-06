import type { z } from 'zod'
import type { Capability, CapabilityEffect, CapabilityLease } from '@enkaku/protocol'
import type { Permission } from '../auth/acl'
import type { CapabilityContext } from './context'

/**
 * `@enkaku/protocol`'s `Capability<I, O, Ctx>` pinned to this host's real
 * `CapabilityContext` (plan 63 §3.2, §4.1) — every capability entry in
 * `capability/device-*.ts`, `script.ts`, and `job.ts` is typed against this,
 * not the bare protocol generic, so `permission` is checked against the
 * real ACL union and `handler` receives the real context.
 */
export type CoreCapability<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = Capability<I, O, CapabilityContext> & {
  permission: Permission
  /** Plan 70 §4.3 — a DECLARATION, not pattern-matching on a field called `image`: fields of
   * `output` that hold base64 image bytes, with the field naming the media type. See
   * `ImageOutputDeclaration` below. */
  imageOutputs?: ImageOutputDeclaration[]
}

/**
 * Names one field of a capability's `output` that holds base64 image bytes
 * (plan 70 §4.3). The loop (`agent/loop/run.ts`) turns each declared field
 * into a stored blob and an image content block; a capability that does not
 * declare this has its output serialised as text, exactly as before this
 * plan. The boot-time registry check (`registry.ts`) asserts every declared
 * `dataField` actually exists in the capability's own `output` schema — a
 * typo here would otherwise silently fall back to text, which is the bug
 * this plan exists to fix (criterion 11).
 */
export interface ImageOutputDeclaration {
  /** The `output` object's key holding the base64 string, e.g. `'image'`. */
  dataField: string
  /** The `output` object's key naming the media type at runtime, when it varies. Mutually exclusive with `mediaType` in practice, but both may be omitted only if the other is set. */
  mediaTypeField?: string
  /** A fixed media type, when the capability always produces the same one (`device.screenshot` always returns a PNG). */
  mediaType?: string
}

/**
 * A `CoreCapability` with its generics erased — the shape a heterogeneous
 * registry actually stores (every entry has a DIFFERENT input/output pair).
 * `handler`'s parameter is deliberately `any`, not `z.ZodType`'s inferred
 * `unknown`: TS function parameters are checked contravariantly, so a
 * concrete `CoreCapability<TapInput, TapOutput>` is not structurally
 * assignable to a slot whose handler takes `unknown` — this is the
 * well-known heterogeneous-registry variance wall, and `any` on this ONE
 * internal storage type is the standard, narrow way through it. Nothing
 * downstream is weakened by it: `invoke` (`invoke.ts`) always calls
 * `cap.input.safeParse(raw)` BEFORE `cap.handler(ctx, parsed.data)`, so the
 * value a handler actually receives at runtime is exactly what its own Zod
 * schema validated, regardless of this storage type.
 */
export interface AnyCoreCapability {
  id: string
  input: z.ZodType
  output: z.ZodType
  permission: Permission
  lease: CapabilityLease
  deadline: number
  effect: CapabilityEffect
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: CapabilityContext, input: any) => Promise<any>
  /** Plan 70 §4.3 — see `ImageOutputDeclaration`. */
  imageOutputs?: ImageOutputDeclaration[]
}

export type { CapabilityEffect, CapabilityLease }

/**
 * Identity function purely for generic inference (plan 63 §4.3): every
 * `capability/device-*.ts`/`script.ts`/`job.ts` entry is written as
 * `defineCapability({ id, input, output, ... })` rather than a hand-written
 * type annotation, so `I`/`O` are inferred from the object literal's own
 * `input`/`output` properties and `handler`'s second parameter is checked
 * against `z.infer<I>` for free — the same pattern `satisfies` gives you,
 * without fighting Zod 4's own generic `ZodObject`/`.extend()` shape.
 */
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(cap: CoreCapability<I, O>): CoreCapability<I, O> {
  return cap
}
