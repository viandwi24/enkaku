import { z } from 'zod'

/**
 * Rotation coverage (plan 314 §7.5, §10.3) — the client's proof that nobody
 * was left out.
 *
 * ## Why this exists as its own read
 *
 * A warm-up split across three sessions a day is three separate dispatches,
 * and coverage across them is emergent, not guaranteed by any single row. The
 * failure the client named is a phone that quietly opens TikTok twice and
 * Instagram never — **with three green runs and no red batch**. Nothing on
 * the Jobs screen can say that, because every one of those runs succeeded.
 *
 * ## What it reads, and why that is honest
 *
 * The branch a run actually took, out of `workflow_steps.takenEdge` — the
 * `case:<i>` a `switch` node recorded when it ran. Not a re-derivation, not a
 * simulation, not the document's intent: the edge the executor wrote down at
 * the moment it chose. A device shows a case as covered only if some real run
 * of that device took it.
 *
 * `switch` is the right anchor because it is where a rotation is expressed at
 * all: `($device.number + $params.slot) % 3` decides a case, and the case is
 * the platform. A workflow with no switch has no rotation to report on, and
 * the endpoint says so rather than inventing one.
 */
export const CoverageCaseSchema = z.object({
  /** `case:0`, `case:1`, … or `default` — the edge name exactly as the run recorded it. */
  edge: z.string(),
  /** The switch case's own authored label, when it has one — what an operator calls the platform. */
  label: z.string(),
})
export type CoverageCase = z.infer<typeof CoverageCaseSchema>

export const DeviceCoverageSchema = z.object({
  deviceId: z.string(),
  /** `#7 Pixel 5` — the number and name an operator reads everywhere else. */
  deviceLabel: z.string(),
  /** `device_numbers.number`, or null. This is the rotation key, so it is worth seeing beside the result. */
  deviceNumber: z.number().int().nullable(),
  /** The edges this device actually took, within the window. */
  covered: z.array(z.string()),
  /** The edges it did NOT take. Empty means fully covered — this is the field the whole report exists for. */
  missing: z.array(z.string()),
  /** How many real runs of this workflow this device had in the window. */
  runs: z.number().int(),
})
export type DeviceCoverage = z.infer<typeof DeviceCoverageSchema>

export const WorkflowCoverageResponseSchema = z.object({
  /** The switch node the report is keyed on. */
  nodeId: z.string(),
  /** Every case that node can take, in document order. */
  cases: z.array(CoverageCaseSchema),
  /** How many recent runs per device were considered. */
  window: z.number().int(),
  /** One row per device that has run this workflow at all, worst coverage first. */
  devices: z.array(DeviceCoverageSchema),
  /** Devices with at least one missing case — the count an operator acts on. */
  incompleteCount: z.number().int(),
})
export type WorkflowCoverageResponse = z.infer<typeof WorkflowCoverageResponseSchema>
