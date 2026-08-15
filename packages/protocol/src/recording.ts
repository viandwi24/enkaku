import { z } from 'zod'
import { NormGestureSampleSchema, NormPointSchema } from './messages/input'
import { SelectorSchema } from './ui-node'

/**
 * The recording document (plan 94 §4.1, step 94.1) — the format `defineRecording`
 * (`@enkaku/sdk`) compiles into an ordinary `ScriptDefinition` (plan 94 §3.1: "a
 * recording is source, and a script is build output").
 *
 * **Coordinates are normalised 0..1 everywhere a position is recorded — never a
 * device pixel.** This is deliberate and load-bearing, not a style choice: a
 * recording made on one phone must replay on a DIFFERENT phone with a different
 * screen resolution with no edit (plan 94 §4.1, acceptance criterion 1). Manual
 * input already reaches the core normalised this way and the core maps it to
 * device pixels server-side (F2) — this schema stores exactly that
 * resolution-independent form, never the mapped pixel value, so replay on a
 * different screen is a property of the DATA, not something a later step has to
 * retrofit. `RecordingTargetSchema`'s `point` case, every gesture sample, and a
 * `swipe` step's `from`/`to` are all `NormPointSchema`/`NormGestureSampleSchema` —
 * the same normalised shapes the manual WS input path already uses
 * (`./messages/input.ts`) — for this one reason.
 */

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * A recording's own slug grammar — the same shape a script's bare name already
 * uses (`packages/protocol/src/script-ref.ts:15-17`), duplicated here rather
 * than imported because that file defines the COMBINED `name@version` reference
 * grammar and splitting it into a reusable "name alone" half touches a file this
 * step does not own (the same reasoning `workflow.ts`'s `WorkflowNameSchema`
 * gives for its own duplicate). Unlike that grammar, this one has NO `/`
 * alternation: a recording is not a plugin member (plan 94 §4.1), so a slug
 * containing `/` is refused here, at record time, where the mistake can be
 * named — never deferred to a publish-time 400 against a grammar the operator
 * has never seen.
 */
const RECORDING_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

/**
 * A recorded step's target (plan 94 §4.1). v1 ALWAYS replays `point` — a plain
 * coordinate, exactly what was recorded. `selector` is present on a step ONLY
 * because a human deliberately promoted a `RecordingCandidateSchema` in the
 * review panel (plan 94 §3.3): nothing here or in the recorder ever chooses
 * `selector` automatically. `fallback` keeps the original point alongside a
 * promoted selector so demoting one is lossless.
 */
export const RecordingTargetSchema = z.union([
  z.object({ kind: z.literal('point'), pos: NormPointSchema }).strict(),
  z.object({ kind: z.literal('selector'), selector: SelectorSchema, fallback: NormPointSchema }).strict(),
])
export type RecordingTarget = z.infer<typeof RecordingTargetSchema>

/**
 * What `proposeSelectors` (`./selector-analysis.ts`, F13) offered for a step,
 * and how much to trust it — never consulted at replay time in v1 (plan 94
 * §3.3): these fields exist so a human can judge whether promoting this
 * candidate is safe, not so the interpreter can decide on its own.
 */
export const RecordingCandidateSchema = z
  .object({
    selector: SelectorSchema,
    /** Matches in the anchor tree (`countMatches`, F13's guarantee). 1 is the only promotable value. */
    count: z.number().int().nonnegative(),
    /** How stale the anchor was when this step landed. */
    anchorAgeMs: z.number().int().nonnegative(),
    /** Steps taken since the anchor was dumped — each one could have changed the screen. */
    anchorStepsSince: z.number().int().nonnegative(),
    anchorPackage: z.string(),
  })
  .strict()
export type RecordingCandidate = z.infer<typeof RecordingCandidateSchema>

/**
 * One recorded input, discriminated on `kind` (plan 94 §4.1, §3.4). `gapMs` is
 * the human's own pause since the previous step — the authoritative replay
 * timing (§3.6: a replayed recording pays its OWN gaps, never
 * `betweenActionMs` on top). Two properties this shape exists specifically to
 * carry, because a later step cannot add them back onto a narrower schema
 * (plan 94 step 94.1 brief):
 *
 * - `gesture` carries the operator's own SAMPLED path (F3, F7) — not just two
 *   endpoints — so a replayed drag can play it back sample-for-sample instead
 *   of a synthesised curve.
 * - `longPress` is its own step kind with a required `holdMs` (F4), not a
 *   `tap` with a duration bolted on — so "this was held" survives compilation
 *   and review as a fact about the step, not an inferred number.
 */
export const RecordingStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tap'),
      gapMs: z.number().int().min(0),
      target: RecordingTargetSchema,
      /** Pointer down→up, when the manual path reported one (F4 — needs plan 94 step 94.2). */
      holdMs: z.number().int().min(0).max(60_000).optional(),
      candidate: RecordingCandidateSchema.optional(),
      screenshotBlobId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('longPress'),
      gapMs: z.number().int().min(0),
      target: RecordingTargetSchema,
      /** A tap whose hold exceeded the recorder's `longPressMs` (default 400 — plan 94 §3.3). */
      holdMs: z.number().int().min(200).max(60_000),
      candidate: RecordingCandidateSchema.optional(),
      screenshotBlobId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gesture'),
      gapMs: z.number().int().min(0),
      /** The operator's real sampled trace, verbatim (F3) — replayed sample-for-sample, never a synthesised curve. */
      samples: z.array(NormGestureSampleSchema).min(2).max(300),
      screenshotBlobId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('swipe'),
      gapMs: z.number().int().min(0),
      /** The two-point fallback a drag too fast to sample already emits (`LiveView.tsx`, §3.4). */
      from: NormPointSchema,
      to: NormPointSchema,
      durationMs: z.number().int().min(50).max(10_000),
      screenshotBlobId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      gapMs: z.number().int().min(0),
      keycode: z.number().int().min(0).max(320),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      gapMs: z.number().int().min(0),
      /** A literal string, or `{ param: 'caption' }` — the recording's ONE parameterisation seam (plan 94 §4.2). */
      value: z.union([z.string(), z.object({ param: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) }).strict()]),
    })
    .strict(),
])
export type RecordingStep = z.infer<typeof RecordingStepSchema>
export type RecordingStepKind = RecordingStep['kind']

/**
 * The recording document itself (plan 94 §4.1). `name` becomes the published
 * script's name (§3.1) and is validated against `RECORDING_NAME_RE` above, not
 * the whole `name@version` reference grammar — a recording is never itself a
 * reference. `recordedOn` is not decoration: it is what lets a review panel say
 * "this was recorded on a 1080×2400 device" when scheduled onto a 720×1600 one
 * — normalised coordinates survive that; a fixed-pixel layout (an app's own
 * breakpoint, not this schema) may not, and the operator should be told rather
 * than discovering it in a job log.
 */
export const RecordingDocSchema = z
  .object({
    schema: z.literal(1),
    /** Becomes the published script's name (§3.1). */
    name: z.string().min(1).max(200).regex(RECORDING_NAME_RE),
    version: z.string().regex(SEMVER),
    description: z.string().default(''),
    /** Unix epoch seconds. */
    recordedAt: z.number().int(),
    recordedOn: z
      .object({
        stableId: z.string(),
        model: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    /** Multiplies every `gapMs` at replay. 1 = as recorded. */
    speed: z.number().min(0.1).max(10).default(1),
    /** Caps a single gap, so a recording with a 4-minute pause in it is usable. */
    maxGapMs: z.number().int().min(0).default(15_000),
    /** Force-stopping `packages` on finish; 'none' leaves the device as-is. */
    cleanup: z.enum(['force-stop', 'none']).default('force-stop'),
    /** Inferred from the anchors' `packageName`; also becomes the compiled `ScriptDefinition.reset.packages`. */
    packages: z.array(z.string()).default([]),
    steps: z.array(RecordingStepSchema).max(2_000),
  })
  .strict()
export type RecordingDoc = z.infer<typeof RecordingDocSchema>
