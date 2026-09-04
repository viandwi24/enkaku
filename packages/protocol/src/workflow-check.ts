import type { JsonSchemaNode } from './api/json-schema'
import type { ScriptRef } from './script-ref'
import { compileWorkflowParams } from './workflow-params'
import type { Predicate, ValueExpr, WorkflowDoc, WorkflowNode } from './workflow'

/**
 * Static, publish-time checking of a workflow document (plan 99 §4.3, step
 * 99.6). Pure: `checkWorkflow` never touches a database — every fact about
 * another script it needs (its `paramsSchema`, its declared
 * `outputSchema` once plan 97 lands) is handed in already resolved, by the
 * caller. This is deliberate and load-bearing (§4.3's own doc comment on the
 * design): the editor's Validate button (`POST /api/workflows/validate`) and
 * the publish gate (`POST /api/workflows`) both call this SAME function, so
 * they cannot disagree about what is wrong with a document.
 */

export interface WorkflowFinding {
  /** `'nodes[2].params.keyword'`, `'onFail.params.keyword'`, `''` for a doc-level finding. */
  path: string
  code: WorkflowFindingCode
  message: string
  severity: 'error' | 'warning'
}

export type WorkflowFindingCode =
  | 'E_WORKFLOW_DUP_NODE_ID'
  | 'E_WORKFLOW_UNKNOWN_NODE'
  | 'E_WORKFLOW_FORWARD_REF'
  | 'E_WORKFLOW_UNKNOWN_PARAM'
  | 'E_WORKFLOW_BINDING_TYPE'
  | 'E_WORKFLOW_BINDING_UNRESOLVABLE'
  | 'E_WORKFLOW_BUDGET_IMPOSSIBLE'
  | 'W_WORKFLOW_UNCHECKED_BINDING'
  | 'W_WORKFLOW_LOOP'
  | 'W_WORKFLOW_LATEST_REF'
  /** `doc.entry` is missing, names an unknown node, or names a node that is not `kind: 'start'` (plan 301 §4.2). */
  | 'E_WORKFLOW_ENTRY_UNKNOWN'
  /** A node no edge (from anywhere reachable from `entry`) targets — a warning, not a refusal: an author mid-edit has orphans (plan 301 §4.3). */
  | 'W_WORKFLOW_NODE_UNREACHABLE'
  /** An edge field (`next`/`onFailure`/`then`/`else`) that is absent — not wired yet. Not an error: reaching the end of it at run time ends the run succeeded (`next`) or failed (`onFailure`) (plan 301 §3.2). */
  | 'W_WORKFLOW_EDGE_DANGLING'
  /**
   * Plan 99 §4.3 check 7, unblocked by plan 98 §4.4 step 98.4
   * (`scripts.runtime`, so `ResolvedNodeScript.timeoutMs` is now readable at
   * publish time). A reachable SCRIPT node whose resolved entry declares no
   * `timeoutMs` is UNKNOWN, not zero — treating it as zero would make an
   * impossible budget look fine, which is exactly the failure mode this
   * plan's own brief warns against. When at least one such node sits on the
   * document's deterministic (acyclic) path, the sum cannot be computed at
   * all, so this warning fires INSTEAD of `E_WORKFLOW_BUDGET_IMPOSSIBLE`
   * (never both) naming every node responsible, and publishing still
   * proceeds — the workflow executor's own runtime clock
   * (`E_WORKFLOW_BUDGET_EXCEEDED`, §4.7) is the real backstop either way.
   */
  | 'W_WORKFLOW_BUDGET_UNKNOWN'
  /**
   * NOT one of plan 99 §4.3's original eight checks — added here because a
   * node's script reference is resolved by the CALLER (the route, which
   * touches the database `checkWorkflow` itself deliberately does not), and
   * a resolution failure ("no such script", "that version is disabled", …)
   * still needs a finding-shaped way to report itself so an author sees it
   * in the SAME list as every structural/binding finding, rather than a
   * differently-shaped error that only surfaces on publish and never on
   * Validate. `packages/core/src/api/workflows.ts` is the only producer.
   */
  | 'E_WORKFLOW_SCRIPT_UNRESOLVED'
  /**
   * Also not one of the original eight, also produced only by
   * `packages/core/src/api/workflows.ts`: the request body failed
   * `WorkflowDocSchema.safeParse` itself — a structural error the PROTOCOL
   * schema already caught, before `checkWorkflow` (which assumes an
   * already-valid `WorkflowDoc`) ever runs. Reported in the same
   * `WorkflowFinding[]` shape purely so the editor's Validate button never
   * has to branch on "which kind of error is this".
   */
  | 'E_WORKFLOW_INVALID'
  /** A workflow document's `schema` is neither 1 nor 2 (plan 301 §4.6) — produced only by `packages/core/src/workflows/upgrade.ts`, surfaced through the same finding shape. */
  | 'E_WORKFLOW_SCHEMA_UNKNOWN'
  /** A `schema: 1` document does not satisfy the frozen v1 shape and cannot be upgraded (plan 301 §4.6) — produced only by `packages/core/src/workflows/upgrade.ts`. */
  | 'E_WORKFLOW_UPGRADE_FAILED'

/** What the publish route already looked up for one node's script reference (plan 99 §4.3's own signature). `outputSchema` is always `null` until plan 97 ships a producer (§0.2 A1) — every check below degrades honestly when it is. */
export interface ResolvedNodeScript {
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
  outputSchema: JsonSchemaNode | null
  /**
   * Plan 99 §3.11/§4.3 check 7, plan 98 §4.4 step 98.4 — this node's SCRIPT's
   * own declared `runtime.timeoutMs` (`ScriptRegistry.get/.resolve(ref)?.runtime?.timeoutMs`),
   * read straight off the `scripts.runtime` column by the caller, exactly
   * once, before this function ever runs. `null` means the script declared
   * no timeout at all — UNKNOWN, never zero (see `WorkflowFindingCode`'s own
   * `W_WORKFLOW_BUDGET_UNKNOWN` doc comment for why that distinction is
   * load-bearing). A caller that predates plan 98 may pass `null` here for
   * every entry, which degrades check 7 to "every node's timeout is
   * unknown", exactly as honest as not implementing it at all. A workflow
   * node's script always resolves to a plugin member (plan 210, MVP 03 §2):
   * nesting a workflow inside another cannot be expressed any more.
   */
  timeoutMs: number | null
}

/**
 * Check 7's other input (plan 99 §3.11) — the farm's own
 * `workflow.maxTotalMs` setting, resolved by the CALLER (never read from a
 * database or a settings store by this file — see this file's own module
 * doc comment on why `checkWorkflow` stays pure). Optional and, when
 * omitted, check 7 is skipped entirely: `checkWorkflow` never invents a
 * default of its own to check against, because a default it invented could
 * silently drift from the one the workflow executor actually enforces at
 * run time (`E_WORKFLOW_BUDGET_EXCEEDED`, §4.7) — the two would then be two
 * sources of truth for one number, exactly the trap plan 92 was named for
 * elsewhere in this codebase.
 */
export interface WorkflowBudget {
  /** `workflow.maxTotalMs`, milliseconds. */
  maxTotalMs: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function push(findings: WorkflowFinding[], path: string, code: WorkflowFindingCode, message: string, severity: 'error' | 'warning'): void {
  findings.push({ path, code, message, severity })
}

// ---------------------------------------------------------------------------
// The transition graph (plan 99 §3.9, §4.3 item 2; rewritten by plan 301 §4.2
// for doc v2's explicit edges). Edges point from a node to whichever node the
// cursor could land on next — one edge per possible outcome, not one node per
// array slot. A gate spawns up to two (then/else); a script node spawns up to
// two (success, failure). Every edge is a node id read straight off the node
// (`next`/`onFailure`/`then`/`else`) — array order carries no control meaning
// (plan 300 D1). An absent edge field is DANGLING (`W_WORKFLOW_EDGE_DANGLING`)
// — not an error, and not an edge in this graph either: the walk simply stops
// there, exactly as the executor's run-time walk would.
// ---------------------------------------------------------------------------

interface Graph {
  /** nodeId -> the set of nodeIds the cursor could land on immediately after it. */
  edges: Map<string, Set<string>>
  /** Every node reachable from `doc.entry`, including itself. */
  reachable: Set<string>
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string | undefined): void {
  if (to === undefined) return
  const set = edges.get(from)
  if (set) set.add(to)
  else edges.set(from, new Set([to]))
}

/** Resolves one edge field, reporting `E_WORKFLOW_UNKNOWN_NODE` for an id that names no node, and `W_WORKFLOW_EDGE_DANGLING` for one left unwired. Returns the target id, or `undefined` when the edge is not usable for graph-walking purposes (unknown OR dangling). */
function resolveEdge(nodeIds: ReadonlySet<string>, target: string | undefined, ownerPath: string, endsAs: 'succeeded' | 'failed', findings: WorkflowFinding[]): string | undefined {
  if (target === undefined) {
    push(findings, ownerPath, 'W_WORKFLOW_EDGE_DANGLING', `this edge is not wired to a node yet — reaching it at run time ends the run ${endsAs}`, 'warning')
    return undefined
  }
  if (!nodeIds.has(target)) {
    push(findings, ownerPath, 'E_WORKFLOW_UNKNOWN_NODE', `"${target}" is not a node in this document`, 'error')
    return undefined
  }
  return target
}

function buildGraph(doc: WorkflowDoc, nodeIds: ReadonlySet<string>, findings: WorkflowFinding[]): Graph {
  const edges = new Map<string, Set<string>>()

  doc.nodes.forEach((node, i) => {
    if (node.kind === 'start') {
      addEdge(edges, node.id, resolveEdge(nodeIds, node.next, `nodes[${i}].next`, 'succeeded', findings))
    } else if (node.kind === 'script') {
      addEdge(edges, node.id, resolveEdge(nodeIds, node.next, `nodes[${i}].next`, 'succeeded', findings))
      addEdge(edges, node.id, resolveEdge(nodeIds, node.onFailure, `nodes[${i}].onFailure`, 'failed', findings))
    } else if (node.kind === 'gate') {
      addEdge(edges, node.id, resolveEdge(nodeIds, node.then, `nodes[${i}].then`, 'succeeded', findings))
      addEdge(edges, node.id, resolveEdge(nodeIds, node.else, `nodes[${i}].else`, 'succeeded', findings))
    }
    // `finish` is a sink — no outgoing edge to resolve.
  })

  const reachable = new Set<string>()
  if (doc.entry !== undefined && nodeIds.has(doc.entry)) {
    const queue = [doc.entry]
    reachable.add(doc.entry)
    while (queue.length > 0) {
      const cur = queue.shift() as string
      for (const next of edges.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next)
          queue.push(next)
        }
      }
    }
  }

  return { edges, reachable }
}

/** Is there a path of ONE OR MORE edges from `from` to `to`? Used for the forward-ref check (§4.3 item 2): "can X have run before N" — a self-path (`from === to`) is answered correctly too, since the walk starts from `from`'s OWN out-edges, never a zero-length stay, which is exactly "is `from` on a cycle back to itself". */
function pathExists(edges: ReadonlyMap<string, Set<string>>, from: string, to: string): boolean {
  const visited = new Set<string>()
  const stack = [...(edges.get(from) ?? [])]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (cur === to) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const next of edges.get(cur) ?? []) stack.push(next)
  }
  return false
}

/** DFS cycle detection over the REACHABLE subgraph, for `W_WORKFLOW_LOOP` (§3.9, §3.11) — a warning, never a refusal, because a bounded loop is a wanted feature ("if not enough matches yet, scroll again"). Returns the first node id found on a cycle, or `null`. */
function findCycle(edges: ReadonlyMap<string, Set<string>>, start: string | undefined): string | null {
  if (start === undefined) return null
  const state = new Map<string, 1 | 2>() // 1 = on the current DFS stack, 2 = fully explored
  let found: string | null = null
  function visit(id: string): void {
    if (found !== null) return
    state.set(id, 1)
    for (const next of edges.get(id) ?? []) {
      const s = state.get(next)
      if (s === 1) {
        found = next
        return
      }
      if (s === undefined) visit(next)
      if (found !== null) return
    }
    state.set(id, 2)
  }
  visit(start)
  return found
}

// ---------------------------------------------------------------------------
// Check 7's arithmetic (plan 99 §3.11, §4.3 item 7) — ONLY meaningful over
// an ACYCLIC reachable graph. A loop makes the true total a "might", never
// a "will" (§3.11's own words: "a workflow that MIGHT not finish ... gets a
// warning, not a refusal — the budget exists precisely to bound that
// case"), and `W_WORKFLOW_LOOP` above already covers that case; promoting a
// cyclic document to a hard `E_WORKFLOW_BUDGET_IMPOSSIBLE` refusal would be
// asserting a certainty this design deliberately does not claim to have. So
// this arithmetic runs, and can only ever produce a finding, when
// `findCycle` found nothing.
// ---------------------------------------------------------------------------

/** A gate, a `start`, and a `finish` cost nothing — they run in-process (or not at all), no child, no clock (§3.7, plan 301 §4.2). A script node costs its resolved script's `timeoutMs`, or `null` for UNKNOWN (no declared timeout, or a ref missing from `resolved` entirely — both mean "cannot determine", never zero). */
function nodeCostMs(resolved: ReadonlyMap<ScriptRef, ResolvedNodeScript>, node: WorkflowNode): number | null {
  if (node.kind !== 'script') return 0
  return resolved.get(node.script)?.timeoutMs ?? null
}

/**
 * The longest node-timeout-weighted path from `start` to a sink, over a
 * graph the caller has already proven acyclic. Walks BOTH edges a script
 * node can produce (its success continuation AND its `onFailure` — see
 * `buildGraph`) and both a gate's `then`/`else`, so the result is the true
 * worst case across every branch this document allows, exactly the same
 * transition graph the forward-ref and reachability checks already use.
 * Returns `null` the instant any node reachable from `start` has an unknown
 * cost (propagates up — one unknown node makes the whole sum unknowable,
 * not just the paths through it); callers are expected to have already
 * checked for unknown costs among the reachable set before calling this, so
 * in practice this only returns `null` defensively.
 */
function longestPathMs(edges: ReadonlyMap<string, Set<string>>, costOf: ReadonlyMap<string, number | null>, start: string): number | null {
  const memo = new Map<string, number | null>()
  function visit(id: string): number | null {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const own = costOf.get(id) ?? 0
    if (own === null) {
      memo.set(id, null)
      return null
    }
    let best = 0
    for (const next of edges.get(id) ?? []) {
      const childBest = visit(next)
      if (childBest === null) {
        memo.set(id, null)
        return null
      }
      if (childBest > best) best = childBest
    }
    const total = own + best
    memo.set(id, total)
    return total
  }
  return visit(start)
}

// ---------------------------------------------------------------------------
// JSON-Schema-shaped comparisons (checks 3 and 4). Both are CONSERVATIVE:
// when the available shape does not let us prove a mismatch, we do not
// report one — an open/unknown shape is exactly what "unchecked" already means
// for check 4, and check 3 must never invent a false positive against a
// script the author did not write.
// ---------------------------------------------------------------------------

function extractJsonTypes(node: unknown): Set<string> {
  const out = new Set<string>()
  if (!isPlainObject(node)) return out
  if (typeof node.type === 'string') out.add(node.type)
  else if (Array.isArray(node.type)) {
    for (const t of node.type) if (typeof t === 'string') out.add(t)
  }
  if (Array.isArray(node.anyOf)) {
    for (const variant of node.anyOf) for (const t of extractJsonTypes(variant)) out.add(t)
  }
  if (Array.isArray(node.enum)) {
    for (const member of node.enum) {
      if (typeof member === 'string') out.add('string')
      else if (typeof member === 'number') out.add(Number.isInteger(member) ? 'integer' : 'number')
      else if (typeof member === 'boolean') out.add('boolean')
    }
  }
  if (out.size === 0 && (Array.isArray(node.prefixItems) || node.items !== undefined)) out.add('array')
  return out
}

/** `undetermined` on either side never blocks (conservative). `integer` is accepted where `number` is wanted (a whole number IS a number); the reverse is not, since a target expecting `integer` can genuinely reject a non-whole `number`. */
function typesCompatible(source: ReadonlySet<string>, target: ReadonlySet<string>): boolean {
  if (source.size === 0 || target.size === 0) return true
  for (const t of source) {
    if (target.has(t)) return true
    if (t === 'integer' && target.has('number')) return true
  }
  return false
}

/**
 * Walks a dotted `path` (already publish-time validated by `WorkflowPathSchema`
 * — identifier segments and non-negative integer indices only, never
 * evaluated as code) against a declared JSON Schema, structurally. Returns
 * `false` only when the schema PROVES the segment cannot exist (a closed
 * `properties` set with `additionalProperties: false`, or a fixed-length
 * tuple with no `items` fallback); every other case — an open shape, a
 * `$ref` this walker does not chase, a schema that simply does not say —
 * returns `true`, because "cannot determine" must never become a false
 * refusal of a legitimate binding (plan 99 §3.6).
 */
function jsonSchemaPathResolves(schema: unknown, path: string | undefined): boolean {
  if (path === undefined || path === '') return true
  let node: unknown = schema
  for (const segment of path.split('.')) {
    if (!isPlainObject(node)) return true
    if (/^\d+$/.test(segment)) {
      const index = Number(segment)
      if (Array.isArray(node.prefixItems)) {
        if (index < node.prefixItems.length) {
          node = node.prefixItems[index]
          continue
        }
        if (node.items === false) return false
        node = isPlainObject(node.items) ? node.items : undefined
        continue
      }
      node = isPlainObject(node.items) ? node.items : undefined
      continue
    }
    if (isPlainObject(node.properties)) {
      if (Object.prototype.hasOwnProperty.call(node.properties, segment)) {
        node = (node.properties as Record<string, unknown>)[segment]
        continue
      }
      if (node.additionalProperties === false) return false
      return true
    }
    return true
  }
  return true
}

function topLevelPropertyNames(schema: unknown): string[] {
  if (isPlainObject(schema) && isPlainObject(schema.properties)) return Object.keys(schema.properties)
  return []
}

// ---------------------------------------------------------------------------
// Binding sites — every place a `ValueExpr` can appear in the document, with
// enough context to check it: which node is DOING the binding (for the
// forward-ref check — `null` for `onFail`, which by construction only ever
// runs after everything else has had its chance), and — only for a value
// bound directly into a script's OWN `params` slot — which node parameter it
// targets (for the type-compat check, item 3's second half; a gate
// predicate's operands have no such target, since they are only ever
// compared, never fed into a schema).
// ---------------------------------------------------------------------------

interface BindingSite {
  fromNodeId: string | null
  path: string
  expr: ValueExpr
  target?: { scriptRef: ScriptRef; paramName: string }
}

function* predicateExprs(pred: Predicate): Generator<ValueExpr> {
  if ('left' in pred) {
    yield pred.left
    if (pred.right !== undefined) yield pred.right
    return
  }
  if ('all' in pred) {
    for (const p of pred.all) yield* predicateExprs(p)
    return
  }
  if ('any' in pred) {
    for (const p of pred.any) yield* predicateExprs(p)
    return
  }
  yield* predicateExprs(pred.not)
}

function* collectBindingSites(doc: WorkflowDoc): Generator<BindingSite> {
  // A plain `for` loop, not `.forEach` — `yield` cannot cross into a nested
  // (non-generator) callback function, only lexically within THIS function's
  // own body.
  for (const [i, node] of doc.nodes.entries()) {
    if (node.kind === 'script') {
      for (const [key, expr] of Object.entries(node.params)) {
        yield { fromNodeId: node.id, path: `nodes[${i}].params.${key}`, expr, target: { scriptRef: node.script, paramName: key } }
      }
    } else if (node.kind === 'gate') {
      for (const expr of predicateExprs(node.when)) {
        yield { fromNodeId: node.id, path: `nodes[${i}].when`, expr }
      }
    }
    // `start`/`finish` carry no bindings.
  }
  if (doc.onFail) {
    for (const [key, expr] of Object.entries(doc.onFail.params)) {
      yield { fromNodeId: null, path: `onFail.params.${key}`, expr, target: { scriptRef: doc.onFail.script, paramName: key } }
    }
  }
}

function paramType(compiledParams: JsonSchemaNode | null, name: string): unknown {
  if (!isPlainObject(compiledParams) || !isPlainObject(compiledParams.properties)) return undefined
  return (compiledParams.properties as Record<string, unknown>)[name]
}

function nodeParamProperty(resolved: ReadonlyMap<ScriptRef, ResolvedNodeScript>, scriptRef: ScriptRef, paramName: string): unknown {
  const entry = resolved.get(scriptRef)
  if (!entry || !isPlainObject(entry.paramsSchema) || !isPlainObject(entry.paramsSchema.properties)) return undefined
  return (entry.paramsSchema.properties as Record<string, unknown>)[paramName]
}

/**
 * Every publish-time check plan 99 §4.3 lists, in order, run against an
 * already-parsed `WorkflowDoc` (so node id uniqueness is ALSO already
 * enforced by `WorkflowDocSchema`'s own `superRefine` — checked again here
 * regardless, since `checkWorkflow` is meant to be usable standalone against
 * anything shaped like a `WorkflowDoc`, not only a document that arrived
 * through `.parse()`) and a pre-resolved map of what the caller looked up
 * for every node's script reference.
 *
 * Every finding is returned — never the first (plan 95 §4.2's own rule for
 * `checkDeclaredSchema`, applied here).
 *
 * **§4.3 item 7 ("the timeout arithmetic of §3.11") is implemented**, as of
 * plan 98 §4.4 step 98.4 persisting a script's declared `runtime.timeoutMs`
 * onto its `scripts` row — `resolved`'s own `ResolvedNodeScript.timeoutMs`
 * is what makes it readable here, at publish time, with no child and no
 * `ready` message. Two shapes, matching §3.11's own text precisely:
 * - **No loop in the reachable graph**: every execution this document
 *   allows is one fixed path, so the worst case is a real, deterministic
 *   number — the longest node-timeout-weighted path from node 0 to a
 *   terminal outcome (`longestPathMs`, walking the SAME transition graph
 *   checks 2 and 6 already build). If that number, plus `onFail`'s own cost
 *   when declared, exceeds the budget the caller passed in, the workflow
 *   CANNOT possibly finish — `E_WORKFLOW_BUDGET_IMPOSSIBLE`, with the
 *   arithmetic in the message.
 * - **A loop exists**: the total is bounded only by `maxSteps`, and a gate
 *   might exit the loop long before that bound is ever reached — §3.11's
 *   own words, "a workflow that MIGHT not finish ... gets a warning, not a
 *   refusal". `W_WORKFLOW_LOOP` already covers this case; check 7 does not
 *   promote it to a hard refusal, because that would assert a certainty
 *   this design does not have.
 * A reachable SCRIPT node whose script declares no `timeoutMs` is UNKNOWN,
 * never treated as zero: the whole sum becomes uncheckable, reported once
 * as `W_WORKFLOW_BUDGET_UNKNOWN` naming every such node, and publishing
 * still proceeds (the workflow executor's own `E_WORKFLOW_BUDGET_EXCEEDED`
 * runtime clock, §4.7, is the real backstop regardless of whether check 7
 * could run at all). `budget` is optional; omitting it skips check 7
 * entirely rather than falling back to a default this function invented
 * itself — see `WorkflowBudget`'s own doc comment for why.
 */
export function checkWorkflow(doc: WorkflowDoc, resolved: ReadonlyMap<ScriptRef, ResolvedNodeScript>, budget?: WorkflowBudget | null): WorkflowFinding[] {
  const findings: WorkflowFinding[] = []

  // --- 1. Node ids unique; every goto/next/onFailure.node names one -------
  const nodeIds = new Set<string>()
  const nodeById = new Map<string, { node: WorkflowNode; index: number }>()
  doc.nodes.forEach((node, i) => {
    if (nodeIds.has(node.id)) {
      const first = nodeById.get(node.id)
      push(findings, `nodes[${i}].id`, 'E_WORKFLOW_DUP_NODE_ID', `duplicate node id "${node.id}" (first used by nodes[${first?.index}])`, 'error')
      return
    }
    nodeIds.add(node.id)
    nodeById.set(node.id, { node, index: i })
  })

  // --- entry: names a node in the document, and it is a `start` node
  // (plan 301 §4.2 — `WorkflowDocSchema`'s own superRefine already checks
  // this against a doc that arrived through `.parse()`; checked again here
  // since `checkWorkflow` is meant to be usable standalone, same discipline
  // as the duplicate-id check above).
  const entryNode = nodeById.get(doc.entry)
  if (!entryNode) {
    push(findings, 'entry', 'E_WORKFLOW_ENTRY_UNKNOWN', `entry "${doc.entry}" is not a node in this document`, 'error')
  } else if (entryNode.node.kind !== 'start') {
    push(findings, 'entry', 'E_WORKFLOW_ENTRY_UNKNOWN', `entry "${doc.entry}" must name a "start" node`, 'error')
  }

  const graph = buildGraph(doc, nodeIds, findings) // also emits E_WORKFLOW_UNKNOWN_NODE and W_WORKFLOW_EDGE_DANGLING

  // --- Every node reachable from `entry` — a WARNING (plan 301 §4.3): an
  // author mid-edit has orphans, and refusing to save that makes the canvas
  // hostile. Only a missing/unknown/non-start entry above is an error.
  doc.nodes.forEach((node, i) => {
    if (!graph.reachable.has(node.id)) {
      push(findings, `nodes[${i}].id`, 'W_WORKFLOW_NODE_UNREACHABLE', `node "${node.id}" is never reached from the entry ("${doc.entry}")`, 'warning')
    }
  })

  // --- W_WORKFLOW_LOOP -----------------------------------------------------
  const cycleNode = entryNode ? findCycle(graph.edges, doc.entry) : null
  if (cycleNode !== null) {
    push(
      findings,
      '',
      'W_WORKFLOW_LOOP',
      `this workflow can loop back to node "${cycleNode}" — bounded only by maxSteps (${doc.maxSteps}); the total time this could take is a MIGHT, not a WILL, so it is not checked against workflow.maxTotalMs (see W_WORKFLOW_BUDGET_UNKNOWN/E_WORKFLOW_BUDGET_IMPOSSIBLE, which only ever fire for a document with no loop)`,
      'warning',
    )
  }

  // --- 7. The timeout arithmetic of §3.11 — ONLY for an acyclic document,
  // and only when the caller handed in a budget (see `WorkflowBudget`'s own
  // doc comment for why an absent budget is skipped rather than defaulted).
  if (cycleNode === null && budget && entryNode) {
    const start = doc.entry
    {
      const costOf = new Map<string, number | null>()
      for (const node of doc.nodes) costOf.set(node.id, nodeCostMs(resolved, node))

      const unknownNodes = doc.nodes.filter((n) => graph.reachable.has(n.id) && n.kind === 'script' && costOf.get(n.id) === null).map((n) => n.id)
      const onFailKnown = doc.onFail ? resolved.get(doc.onFail.script)?.timeoutMs : 0
      const onFailCost = onFailKnown ?? (doc.onFail ? null : 0)
      if (doc.onFail && onFailCost === null) unknownNodes.push(`onFail (${doc.onFail.script})`)

      if (unknownNodes.length > 0) {
        push(
          findings,
          '',
          'W_WORKFLOW_BUDGET_UNKNOWN',
          `this workflow's total budget (workflow.maxTotalMs = ${budget.maxTotalMs}ms) cannot be checked at publish time: ${unknownNodes.map((id) => `"${id}"`).join(', ')} declare${unknownNodes.length === 1 ? 's' : ''} no runtime.timeoutMs — the workflow executor's own budget clock still applies when this runs`,
          'warning',
        )
      } else {
        const longest = longestPathMs(graph.edges, costOf, start) ?? 0
        const worstCaseMs = longest + (onFailCost ?? 0)
        if (worstCaseMs > budget.maxTotalMs) {
          push(
            findings,
            '',
            'E_WORKFLOW_BUDGET_IMPOSSIBLE',
            `this workflow cannot possibly finish inside its ${budget.maxTotalMs}ms total budget (workflow.maxTotalMs): the longest possible run, node timeouts summed along the way${doc.onFail ? ' (including the onFail cleanup script)' : ''}, is ${worstCaseMs}ms`,
            'error',
          )
        }
      }
    }
  }

  // --- 5. A stale @latest reference is still worth flagging ---------------
  doc.nodes.forEach((node, i) => {
    if (node.kind !== 'script') return
    if (node.script.endsWith('@latest')) {
      push(findings, `nodes[${i}].script`, 'W_WORKFLOW_LATEST_REF', `"${node.script}" resolves to whatever is newest at RUN time — this workflow's behaviour can change without the workflow itself changing`, 'warning')
    }
  })
  if (doc.onFail) {
    if (doc.onFail.script.endsWith('@latest')) {
      push(findings, 'onFail.script', 'W_WORKFLOW_LATEST_REF', `"${doc.onFail.script}" resolves to whatever is newest at RUN time — this workflow's behaviour can change without the workflow itself changing`, 'warning')
    }
  }

  // --- 2, 3, 4. Every ValueExpr in the document ---------------------------
  const compiledParams = compileWorkflowParams(doc.params)
  for (const site of collectBindingSites(doc)) {
    const expr = site.expr

    if ('param' in expr) {
      const declared = doc.params.find((p) => p.name === expr.param)
      if (!declared) {
        push(findings, site.path, 'E_WORKFLOW_UNKNOWN_PARAM', `"${expr.param}" is not a declared workflow parameter`, 'error')
        continue
      }
      if (site.target) {
        const sourceTypes = extractJsonTypes(paramType(compiledParams, declared.name))
        const targetTypes = extractJsonTypes(nodeParamProperty(resolved, site.target.scriptRef, site.target.paramName))
        if (!typesCompatible(sourceTypes, targetTypes)) {
          push(
            findings,
            site.path,
            'E_WORKFLOW_BINDING_TYPE',
            `workflow parameter "${expr.param}" (${[...sourceTypes].join('|') || 'unknown'}) is not assignable to "${site.target.scriptRef}"'s "${site.target.paramName}" (${[...targetTypes].join('|') || 'unknown'})`,
            'error',
          )
        }
      }
      continue
    }

    if ('from' in expr) {
      if (!nodeIds.has(expr.from)) {
        push(findings, site.path, 'E_WORKFLOW_UNKNOWN_NODE', `"${expr.from}" is not a node in this document`, 'error')
        continue
      }
      // Forward-ref check (item 2) — skipped for `onFail` (fromNodeId===null): the cleanup
      // node has no fixed position, it runs after whichever node's failure ended the
      // workflow, so any earlier node it names may legitimately have run.
      if (site.fromNodeId !== null && !pathExists(graph.edges, expr.from, site.fromNodeId)) {
        push(
          findings,
          site.path,
          'E_WORKFLOW_FORWARD_REF',
          `"${site.fromNodeId}" binds to node "${expr.from}"'s output, but "${expr.from}" can only run AFTER "${site.fromNodeId}" (or never) in every execution this document allows`,
          'error',
        )
        continue
      }
      // Item 4 — only meaningful against a SCRIPT node (a gate has no output; see this
      // file's module doc — referencing a gate's output degrades to "unchecked", honestly,
      // since there is nothing declared to check it against).
      const target = nodeById.get(expr.from)
      if (target?.node.kind === 'script') {
        const entry = resolved.get(target.node.script)
        if (entry?.outputSchema) {
          if (!jsonSchemaPathResolves(entry.outputSchema, expr.path)) {
            const shape = topLevelPropertyNames(entry.outputSchema)
            push(
              findings,
              site.path,
              'E_WORKFLOW_BINDING_UNRESOLVABLE',
              `path "${expr.path ?? ''}" cannot exist on "${target.node.script}"'s declared output${shape.length > 0 ? ` (which declares: ${shape.join(', ')})` : ''}`,
              'error',
            )
          }
        } else {
          push(findings, site.path, 'W_WORKFLOW_UNCHECKED_BINDING', `"${target.node.script}" does not declare an output — this binding cannot be checked until it runs`, 'warning')
        }
      }
      continue
    }

    // `{ const }` / `{ run: 'summary' }` — nothing to check statically.
  }

  return findings
}
