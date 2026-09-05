import { deriveRandom } from '@enkaku/expr'
import type { ResolveScope, RunSummaryEntry, WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import type { ScriptEntry, ScriptRegistry } from '../scripts/registry'
import type { PinStore } from './pins'
import { sampleFromSchema } from './sample-from-schema'
import { computeDelayMs, computeGateStep, computeSetStep, computeSwitchStep, successorOf } from './step-compute'

/**
 * Plan 309 — running a whole workflow with no device attached, ever. This
 * is the real control-flow engine (`step-compute.ts`, `@enkaku/expr`), with
 * the acting half (a `script` node's device call) replaced by a value: a
 * pin, a sample derived from `resultSchema`, or an author-written mock.
 * G3 is a constraint, not a feature: this file defines NO evaluator of its
 * own — every gate/switch/set decision is made by the exact same code the
 * real executor calls (`jobs/executors/workflow.ts`), imported from
 * `step-compute.ts`, so a simulation cannot disagree with production about
 * which branch fires.
 *
 * Pure apart from the two reads it is handed (`deps.pins`,
 * `deps.registry`). No clock, no randomness of its own: `req.now`/`req.seed`
 * are fixed by the caller, so two simulations of the same document give the
 * same answer.
 */

export interface SimulateRequest {
  /** The document as the EDITOR currently has it — a simulation runs on unsaved work (plan 309 §4.4). */
  doc: WorkflowDoc
  /** Values for the workflow's own `params[]`, from the same form the Run dialog uses. */
  params: Record<string, unknown>
  /**
   * Author-written mocks, keyed by node id, MERGED OVER stored pins — an
   * author typing a hypothetical value into the Simulate dialog previews it
   * without first saving it as a pin (plan 309 §4.1's own interface
   * comment). A stored pin still wins over an auto-generated sample when no
   * mock is given for that node — the precedence, high to low, is
   * mock → pin → sample.
   */
  mocks?: Record<string, unknown>
  /** `$now` for every `{ expr }` binding this run resolves — fixed by the caller (plan 302 §3.3), defaults to `Date.now()`. */
  now?: number
  /** `$random`'s seed (plan 304 §3.4) — fixed by the caller so a simulation is reproducible. Defaults to `0`. */
  seed?: number
}

/** Where a `script` node's value came from — rendered on the step, so nothing is anonymous (plan 309 §3.2, §4.1). A computing node (`gate`/`switch`/`delay`/`set`) is always `'computed'`: it never needed a device to begin with. */
export type SimulatedValueSource = 'pin' | 'mock' | 'sample' | 'computed'

/** `start`/`finish` cost no step and are never pushed as a `SimulatedStep` (they run through, exactly as the real executor treats them) — so this is narrower than `WorkflowNode['kind']`, matching `workflow_steps.kind`'s own domain. */
export type SimulatedNodeKind = Exclude<WorkflowNode['kind'], 'start' | 'finish'>

export interface SimulatedStep {
  seq: number
  nodeId: string
  kind: SimulatedNodeKind
  input: unknown
  output: unknown
  source: SimulatedValueSource
  takenEdge: string | null
  /** Set on a `delay` — the duration it would have waited, skipped rather than honoured (plan 309 §3.3). */
  skippedMs?: number
}

export type SimulateResult =
  | { status: 'success' | 'failed'; steps: SimulatedStep[]; error?: string }
  | { status: 'stopped'; steps: SimulatedStep[]; stoppedAtNodeId: string; reason: string }

/** A `script` node's value, per plan 309 §3.2/§4.1's precedence: mock → pin → sample. `undefined` means none of the three yielded a value — the simulation stops at this node (G5). */
function scriptNodeValue(
  node: Extract<WorkflowNode, { kind: 'script' }>,
  mocks: Record<string, unknown>,
  pins: ReadonlyMap<string, unknown>,
  registry: ScriptRegistry,
): { ok: true; value: unknown; source: SimulatedValueSource } | { ok: false; reason: string } {
  if (Object.prototype.hasOwnProperty.call(mocks, node.id)) {
    return { ok: true, value: mocks[node.id], source: 'mock' }
  }
  if (pins.has(node.id)) {
    return { ok: true, value: pins.get(node.id) ?? null, source: 'pin' }
  }
  let entry: ScriptEntry
  try {
    entry = registry.resolve(node.script)
  } catch (err) {
    const message = err instanceof EnkakuError ? err.message : String(err)
    return { ok: false, reason: `script "${node.script}" could not be resolved: ${message} — pin a value to simulate past it` }
  }
  if (entry.resultSchema == null) {
    return { ok: false, reason: `"${node.id}" (${node.script}) declares no result shape — pin a value to simulate past it` }
  }
  return { ok: true, value: sampleFromSchema(entry.resultSchema), source: 'sample' }
}

const toSec = (ms: number): number => Math.floor(ms / 1000)

/** Runs `req.doc` end to end with no device, no child process, no session open (G1) — every gate/switch/set decision made by `step-compute.ts`, the same module the real executor calls (G3). */
export function simulateWorkflow(req: SimulateRequest, deps: { pins: PinStore; registry: ScriptRegistry }): SimulateResult {
  const { doc, params } = req
  const mocks = req.mocks ?? {}
  const now = req.now ?? Date.now()
  const seed = req.seed ?? 0
  const pins = deps.pins.readPins(doc.name)

  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]))
  const outputs = new Map<string, unknown>()
  const summary: RunSummaryEntry[] = []
  const steps: SimulatedStep[] = []
  const runCounts = new Map<string, number>()

  const currentInputValue = (): unknown => (summary.length > 0 ? (summary[summary.length - 1]?.output ?? null) : null)

  let cursor: string | null = doc.entry
  let seq = 0
  let status: 'success' | 'failed' = 'success'
  let error: string | undefined

  while (cursor) {
    if (seq >= doc.maxSteps) {
      status = 'failed'
      error = `the workflow's step budget (maxSteps: ${doc.maxSteps}) was exceeded on step "${cursor}"`
      break
    }
    const node = nodesById.get(cursor)
    if (!node) {
      status = 'failed'
      error = `step "${cursor}" does not exist in this workflow's document`
      break
    }

    if (node.kind === 'start') {
      cursor = node.next ?? null
      continue
    }
    if (node.kind === 'finish') {
      if (node.status === 'fail') {
        status = 'failed'
        error = node.message || `workflow ended at finish node "${node.id}" — failed`
      }
      cursor = null
      continue
    }

    runCounts.set(node.id, (runCounts.get(node.id) ?? 0) + 1)
    const stepStartMs = now
    const scope: ResolveScope = { params, outputs, summary, now: stepStartMs, randomSeed: deriveRandom(seed, seq) }
    const inputValue = currentInputValue()

    if (node.kind === 'gate') {
      const { takenEdge, output } = computeGateStep(node, scope)
      outputs.set(node.id, output)
      summary.push({ nodeId: node.id, script: null, status: 'success', startedAt: toSec(stepStartMs), finishedAt: toSec(stepStartMs), durationMs: 0, output })
      steps.push({ seq, nodeId: node.id, kind: node.kind, input: inputValue, output, source: 'computed', takenEdge })
      seq += 1
      cursor = successorOf(node, takenEdge)
      continue
    }

    if (node.kind === 'switch') {
      const { takenEdge, output } = computeSwitchStep(node, scope)
      outputs.set(node.id, output)
      summary.push({ nodeId: node.id, script: null, status: 'success', startedAt: toSec(stepStartMs), finishedAt: toSec(stepStartMs), durationMs: 0, output })
      steps.push({ seq, nodeId: node.id, kind: node.kind, input: inputValue, output, source: 'computed', takenEdge })
      seq += 1
      cursor = successorOf(node, takenEdge)
      continue
    }

    if (node.kind === 'delay') {
      // Plan 309 §3.3 — resolves instantly and says so: the alternative
      // (honouring the wait) turns a 4-minute workflow into a 4-minute
      // simulation, which defeats the point.
      const waitMs = computeDelayMs(node, scope)
      const output = { ms: waitMs }
      outputs.set(node.id, output)
      summary.push({ nodeId: node.id, script: null, status: 'success', startedAt: toSec(stepStartMs), finishedAt: toSec(stepStartMs), durationMs: 0, output })
      steps.push({ seq, nodeId: node.id, kind: node.kind, input: inputValue, output, source: 'computed', takenEdge: 'next', skippedMs: waitMs })
      seq += 1
      cursor = successorOf(node, 'next')
      continue
    }

    if (node.kind === 'set') {
      const result = computeSetStep(node, scope, inputValue)
      if (!result.ok) {
        steps.push({ seq, nodeId: node.id, kind: node.kind, input: inputValue, output: null, source: 'computed', takenEdge: null })
        status = 'failed'
        error = `step "${node.id}" failed: ${result.error}`
        cursor = null
        continue
      }
      outputs.set(node.id, result.output)
      summary.push({ nodeId: node.id, script: null, status: 'success', startedAt: toSec(stepStartMs), finishedAt: toSec(stepStartMs), durationMs: 0, output: result.output })
      steps.push({ seq, nodeId: node.id, kind: node.kind, input: inputValue, output: result.output, source: 'computed', takenEdge: 'next' })
      seq += 1
      cursor = successorOf(node, 'next')
      continue
    }

    // A `script` node: never executed (G1) — its value comes from a pin, a
    // sample derived from its `resultSchema`, or an author-written mock, in
    // that order (§3.2, §4.1). None of the three stops the simulation here
    // (G5), naming the node and why.
    const resolved = scriptNodeValue(node, mocks, pins, deps.registry)
    if (!resolved.ok) {
      return { status: 'stopped', steps, stoppedAtNodeId: node.id, reason: resolved.reason }
    }
    outputs.set(node.id, resolved.value)
    summary.push({ nodeId: node.id, script: `${node.script} (${resolved.source})`, status: 'success', startedAt: toSec(stepStartMs), finishedAt: toSec(stepStartMs), durationMs: 0, output: resolved.value })
    steps.push({ seq, nodeId: node.id, kind: node.kind, input: inputValue, output: resolved.value, source: resolved.source, takenEdge: 'next' })
    seq += 1
    cursor = successorOf(node, 'next')
  }

  return { status, steps, error }
}
