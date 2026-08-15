import { z } from 'zod'
import { RuntimeEnvelopeSchema, ui } from '@enkaku/protocol'
import type { JsonSchemaNode } from './types'

/**
 * Plan 98 §3.9 item 2, §4.1, step 98.8 — the Run form's per-job Runtime
 * override, rendered through the SAME `SchemaForm` every other schema in
 * this product goes through. No new form code, and no new control: this is
 * the deliverable the step's own brief calls out explicitly — "a test
 * asserting the planner produced `bytes` and `duration` fields for the
 * override schema with no new control component registered"
 * (`runtime-override-schema.test.ts`).
 *
 * Deliberately built from `RuntimeEnvelopeSchema.shape` — the SAME field
 * validators (`min`/`max`/`int`) `@enkaku/protocol` already enforces for a
 * script's own declaration and for what the core will eventually accept as
 * `jobs.runtime_override` (plan 98 §4.1, step 98.7) — rather than a second,
 * hand-typed copy of the bounds that could silently drift from them. The
 * ONLY thing added here is what `@enkaku/protocol` itself is not allowed to
 * say (plan 95 §3.1: the vocabulary package names no control and, by the
 * same reasoning, ships no Studio-specific presentation hint either) —
 * `title`/`kind`/`group`/`enforcement`, via the same typed `ui()` helper
 * every other annotated field in this codebase uses.
 *
 * `sdk` is deliberately NOT offered here. `RuntimeEnvelopeSchema` validates
 * it as part of the identical shape the core will eventually accept for
 * `runtimeOverride` (plan 98 §4.1's own doc comment: "the identical shape is
 * reused for a script's own declaration ... and for a per-job override"),
 * but an operator overriding the SDK CONTRACT major from the Run form is not
 * a real per-job knob — it is a compatibility escape hatch with no honest
 * use case at run time (plan 98 §3.3 S1: "there is no repair"). Omitting a
 * field from Studio's OWN schema is not a shape change to the wire contract
 * (a value the operator never typed is simply absent, exactly like a script
 * that never declared it), so this narrowing costs nothing.
 *
 * `group` deliberately separates the two fields with a farm ceiling
 * (`timeoutMs`/`maxRssBytes`, §3.8's asymmetric "refused, not clamped" rule
 * for an override) from the two that do not (`retries`/`maxConcurrent`,
 * §4.1's own doc comment) — the same "consecutive run" section grouping
 * every other multi-field schema in this product already uses
 * (`sectionFields`, `plan.ts`), not a bespoke layout.
 */
const RUNTIME_OVERRIDE_SCHEMA_ZOD = z.object({
  timeoutMs: RuntimeEnvelopeSchema.shape.timeoutMs.meta(
    ui({
      title: 'Timeout',
      description: 'Refused outright if it exceeds the farm ceiling — never silently clamped (plan 98 §3.8).',
      kind: 'duration',
      unit: 'ms',
      group: 'Limits',
    }),
  ),
  maxRssBytes: RuntimeEnvelopeSchema.shape.maxRssBytes.meta(
    ui({
      title: 'Memory limit',
      description: 'Enforced by sampling, not prevented — a breach is caught on the next check (plan 98 §3.5).',
      kind: 'bytes',
      group: 'Limits',
      enforcement: 'sampled',
    }),
  ),
  retries: RuntimeEnvelopeSchema.shape.retries.meta(
    ui({ title: 'Retries on a script failure', kind: 'count', group: 'Advanced', advanced: true }),
  ),
  maxConcurrent: RuntimeEnvelopeSchema.shape.maxConcurrent.meta(
    ui({ title: 'Max concurrent (farm-wide)', description: '0 = unlimited.', kind: 'count', group: 'Advanced', advanced: true }),
  ),
})

/**
 * Precomputed once at module load — same `{ io: 'input' }` `z.toJSONSchema`
 * call `sdk/cli/publish.ts` and `workflow-params.ts`'s `compileWorkflowParams`
 * already use for the identical reason (plan 95 §3.2, §4.9): every field
 * here is `.optional()` with no `.default()`, so `io` makes no observable
 * difference today, but matching the convention means this schema behaves
 * identically to every other one in this codebase if a `.default()` is ever
 * added to `RuntimeEnvelopeSchema` upstream.
 */
export const RUNTIME_OVERRIDE_SCHEMA = z.toJSONSchema(RUNTIME_OVERRIDE_SCHEMA_ZOD, { io: 'input' }) as JsonSchemaNode
