import type { WorkflowDocInput } from '@enkaku/protocol'
import type { WarmupAssignment } from './warmup'

/**
 * One phone's warm-up as a single workflow document (plan 907, plan 908).
 *
 * ## What this buys, and what it costs
 *
 * The default path gives a phone its four activities as four jobs, and the gaps
 * between them are `notBeforeAt` stamps the router honours on its own fifteen
 * second tick. That works — it is the path verified on hardware in plan 903 —
 * but the pacing is only ever as fine as the tick, and a four-activity phone
 * costs four trips through the queue.
 *
 * As a workflow it is ONE job with `delay` nodes between the scripts, so the
 * gaps are exact and the phone is claimed once.
 *
 * The cost is real and is the reason this is a choice rather than a
 * replacement: the plugin sees ONE outcome for the sequence, not one per
 * activity. It holds `job.get` and deliberately not `job.list` (a permission
 * asked for and not needed is one an operator granted for nothing), so it
 * cannot read the workflow's own member jobs. The per-activity detail still
 * exists — Studio's run view shows every step — but it is a click away instead
 * of a column.
 *
 * ## Why the document is built here and not drawn
 *
 * It is generated from the plan `warmup.ts` already drew: same platform, same
 * style, same shuffled order, same counts. Nothing about WHO authors the
 * composition changed (plan 900 D1) — this is only how the sequence is
 * dispatched.
 */

/** A workflow value wrapper. A script node's params take these, never a bare value — see plan 907 §4.1. */
const constant = (value: unknown): { const: unknown } => ({ const: value })

/** Laid out top to bottom, one node per row, so the run view reads in order if anyone opens it. */
const ROW = 120

/**
 * Turn one phone's assignment into a document.
 *
 * `null` when the phone was given nothing — a workflow with no script in it is
 * a job that does nothing, and dispatching one per idle phone would fill the
 * operator's job list with successes that mean "this phone was skipped".
 */
export function warmupSequenceDoc(assignment: WarmupAssignment, opts: { gapSec: readonly [number, number] }): WorkflowDocInput | null {
  if (assignment.steps.length === 0) return null

  const nodes: WorkflowDocInput['nodes'] = []
  let y = 0
  const push = (node: WorkflowDocInput['nodes'][number]): void => {
    nodes.push(node)
    y += ROW
  }

  const stepId = (index: number): string => `s${index}`
  const gapId = (index: number): string => `g${index}`

  push({ id: 'start', title: 'Start', ui: { x: 0, y }, enabled: true, kind: 'start', next: stepId(0) } as WorkflowDocInput['nodes'][number])

  assignment.steps.forEach((step, index) => {
    const last = index === assignment.steps.length - 1
    /*
      The gap the planner already drew for this step is the delay BEFORE the
      next one — `atSec` differences, not a fresh draw. Re-drawing here would
      give the session a different pace from the one its rows say it has.
    */
    const nextGapMs = last ? 0 : Math.max(0, ((assignment.steps[index + 1]?.atSec ?? step.atSec) - step.atSec) * 1000)
    push({
      id: stepId(index),
      title: step.title,
      ui: { x: 0, y },
      enabled: true,
      kind: 'script',
      script: step.script,
      params: Object.fromEntries(Object.entries(step.params).map(([key, value]) => [key, constant(value)])),
      next: last ? 'done' : gapId(index),
    } as WorkflowDocInput['nodes'][number])
    if (last) return
    push({
      id: gapId(index),
      title: 'Wait',
      ui: { x: 0, y },
      enabled: true,
      kind: 'delay',
      ms: constant(nextGapMs),
      // A ceiling the document carries itself, so a settings change that made
      // the gaps enormous cannot leave a phone asleep for an afternoon.
      maxMs: Math.max(60_000, (opts.gapSec[1] + 1) * 1000),
      next: stepId(index + 1),
    } as WorkflowDocInput['nodes'][number])
  })

  push({ id: 'done', title: 'Done', ui: { x: 0, y }, enabled: true, kind: 'finish', status: 'succeed', message: '' } as WorkflowDocInput['nodes'][number])

  return {
    schema: 2,
    name: 'smm-warmup-sequence',
    title: `Warm-up — ${assignment.styleTitle ?? assignment.platform ?? 'sequence'}`,
    description: `One phone's warm-up on ${assignment.platform ?? 'no platform'}: ${assignment.steps.length} activities with the session's own gaps between them.`,
    entry: 'start',
    nodes,
    // `2n + 2` is exactly this document: a start, a finish, one node per
    // activity and one gap between each pair. A ceiling rather than a budget.
    maxSteps: assignment.steps.length * 2 + 2,
  }
}
