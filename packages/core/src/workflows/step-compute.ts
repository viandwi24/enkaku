import { evaluatePredicate, setPath, type PredicateTrace, type ResolveScope, type WorkflowNode } from '@enkaku/protocol'
import { resolveValue } from '@enkaku/protocol'

/**
 * The workflow control-flow engine's pure half (plan 309 §4.1, §10) —
 * extracted from `jobs/executors/workflow.ts` so the real executor and the
 * simulator (`workflows/simulate.ts`) call the EXACT same code to decide
 * which edge a `gate`/`switch`/`set`/`delay` node takes. Plan 309's G3 is a
 * constraint, not a feature: a simulation that disagrees with production
 * about which branch fires is worse than no simulation, so this module is
 * the ONE place that decision is made — nowhere else may define it.
 *
 * Everything here is pure: no DB, no clock read, no randomness of its own —
 * `scope.now`/`scope.randomSeed` are supplied by the caller (plan 302 §3.3).
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The edge a PINNED node takes (plan 304 §3.3, §4.2) — a pinned node is never executed, so no predicate or case is ever evaluated; it leaves by its FIRST declared successor, matching what an author sees on the canvas as the node's "main" edge. */
export function defaultEdgeFor(node: WorkflowNode): string {
  switch (node.kind) {
    case 'gate':
      return node.then !== undefined ? 'then' : 'else'
    case 'switch': {
      const idx = node.cases.findIndex((c) => c.to !== undefined)
      return idx === -1 ? 'default' : `case:${idx}`
    }
    case 'script':
    case 'delay':
    case 'set':
      return 'next'
    default:
      return 'next'
  }
}

/**
 * The node id `edge` (as `defaultEdgeFor` or a normal evaluated branch names
 * it) points at — `null` when it dangles (plan 309 §10: the ONE definition
 * of a workflow node's successor lookup in the workspace).
 */
export function successorOf(node: WorkflowNode, edge: string): string | null {
  switch (node.kind) {
    case 'gate':
      return (edge === 'then' ? node.then : node.else) ?? null
    case 'switch': {
      if (edge === 'default') return node.default ?? null
      const idx = Number(edge.slice('case:'.length))
      return node.cases[idx]?.to ?? null
    }
    case 'script':
    case 'delay':
    case 'set':
      return node.next ?? null
    default:
      return null
  }
}

export type GateNode = Extract<WorkflowNode, { kind: 'gate' }>
export type SwitchNode = Extract<WorkflowNode, { kind: 'switch' }>
export type SetNode = Extract<WorkflowNode, { kind: 'set' }>
export type DelayNode = Extract<WorkflowNode, { kind: 'delay' }>

export interface GateStepResult {
  value: boolean
  trace: PredicateTrace
  takenEdge: 'then' | 'else'
  output: { value: boolean; branch: string | null }
}

/** Evaluates a `gate` node's predicate — the SAME `evaluatePredicate` a `switch` case leaf uses. */
export function computeGateStep(node: GateNode, scope: ResolveScope): GateStepResult {
  const { value, trace } = evaluatePredicate(node.when, scope)
  const chosen = value ? node.then : node.else
  const takenEdge = value ? 'then' : 'else'
  return { value, trace, takenEdge, output: { value, branch: chosen ?? null } }
}

export interface SwitchStepResult {
  takenEdge: string
  output: { case: number | null; branch: string | null }
}

/** Evaluates a `switch` node — predicate mode (first match wins, array order) or weighted mode (a `$random` draw over normalised weights, plan 312 §3.6, §4.3). */
export function computeSwitchStep(node: SwitchNode, scope: ResolveScope): SwitchStepResult {
  let chosen: string | undefined
  let firedIndex: number | null = null

  if (node.mode === 'weighted') {
    const weights = node.cases.map((c) => c.weight ?? 0)
    const total = weights.reduce((a, b) => a + b, 0)
    let remaining = (scope.randomSeed ?? 0) * total
    for (let ci = 0; ci < node.cases.length; ci++) {
      remaining -= weights[ci] ?? 0
      if (remaining <= 0) {
        chosen = node.cases[ci]?.to
        firedIndex = ci
        break
      }
    }
    if (firedIndex === null) {
      // Floating-point edge case only (the draw landed exactly on the total, or every weight was 0) — the last case.
      firedIndex = node.cases.length - 1
      chosen = node.cases[firedIndex]?.to
    }
  } else {
    for (let ci = 0; ci < node.cases.length; ci++) {
      const c = node.cases[ci]
      if (!c || c.when === undefined) continue
      const { value } = evaluatePredicate(c.when, scope)
      if (value) {
        chosen = c.to
        firedIndex = ci
        break
      }
    }
    if (firedIndex === null) chosen = node.default
  }

  const takenEdge = firedIndex === null ? 'default' : `case:${firedIndex}`
  return { takenEdge, output: { case: firedIndex, branch: chosen ?? null } }
}

export type SetStepResult = { ok: true; output: Record<string, unknown> } | { ok: false; error: string }

/**
 * Evaluates a `set` node's assignments in array order (plan 312 §3.3, §4.3),
 * writing into `base` (the input, unless `keepOnlySet`) with `setPath`.
 * `inputForBase` is `$input` — the caller decides what that is (the previous
 * real step's output for the executor, a simulated node's own value for
 * `simulateWorkflow`).
 */
export function computeSetStep(node: SetNode, scope: ResolveScope, inputForBase: unknown): SetStepResult {
  let base: Record<string, unknown> = !node.keepOnlySet && isPlainObject(inputForBase) ? { ...inputForBase } : {}
  for (const a of node.assignments) {
    const nameOutcome = resolveValue(a.name, scope)
    if (!nameOutcome.ok) return { ok: false, error: `an assignment's name: ${nameOutcome.detail}` }
    if (typeof nameOutcome.value !== 'string' || nameOutcome.value.length === 0) {
      return { ok: false, error: `an assignment's name resolved to ${typeof nameOutcome.value === 'string' ? 'an empty string' : typeof nameOutcome.value}, not a non-empty string` }
    }
    const valueOutcome = resolveValue(a.value, scope)
    if (!valueOutcome.ok) return { ok: false, error: `assignment "${nameOutcome.value}": ${valueOutcome.detail}` }
    try {
      base = setPath(base, nameOutcome.value, valueOutcome.value)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: true, output: base }
}

/**
 * A `delay` node's wait, clamped to its own declared `maxMs` (plan 303 §3.4)
 * — a non-numeric or unresolved `ms` degrades to `0` rather than failing the
 * step, since a delay is advisory timing, not a binding whose absence should
 * fail a run.
 */
export function computeDelayMs(node: DelayNode, scope: ResolveScope): number {
  const msOutcome = resolveValue(node.ms, scope)
  const rawMs = msOutcome.ok && typeof msOutcome.value === 'number' && Number.isFinite(msOutcome.value) ? msOutcome.value : 0
  return Math.max(0, Math.min(rawMs, node.maxMs))
}
