import type { z } from 'zod'
import type { Predicate, ValueExpr, WorkflowDoc, WorkflowFinding, WorkflowParam, WorkflowPoint } from '@enkaku/protocol'
import { WorkflowDocSchema } from '@enkaku/protocol'

/**
 * The editor's own working shape for one node (plan 99 §3.1, §4.1, §5 step
 * 99.9; rewritten to doc v2's explicit edges by plan 301 §4.1, §5 step
 * 301.6). `WorkflowNodeSchema` (`@enkaku/protocol`) already IS this shape
 * once a document is valid — a draft is looser only in `script` (a
 * `ScriptRef` string once picked, `''` before the operator has chosen one),
 * which is why `toWorkflowDoc` below exists: it is the one place a draft is
 * asked to prove it is actually a `WorkflowDoc`, through the real Zod schema,
 * never a hand-rolled duplicate of its rules.
 *
 * Every edge is a node id now (plan 300 D1) — `onFailure`/`next`/`then`/`else`
 * hold `string | undefined`, never a `GateOutcome` union. `start` and
 * `finish` are new node kinds (plan 301 §3.2, §3.4): every draft carries
 * exactly one `start`, undeletable by `removeNode` below, and `entry` always
 * points at it.
 */
export interface WorkflowStartNodeDraft {
  kind: 'start'
  id: string
  title: string
  ui: WorkflowPoint
  next?: string
}

export interface WorkflowScriptNodeDraft {
  kind: 'script'
  id: string
  title: string
  ui: WorkflowPoint
  script: string
  params: Record<string, ValueExpr>
  reset?: 'farm' | 'none'
  retries?: number
  next?: string
  onFailure?: string
}

export interface WorkflowGateNodeDraft {
  kind: 'gate'
  id: string
  title: string
  ui: WorkflowPoint
  when: Predicate
  then?: string
  else?: string
}

export interface WorkflowFinishNodeDraft {
  kind: 'finish'
  id: string
  title: string
  ui: WorkflowPoint
  status: 'succeed' | 'fail'
  message: string
}

export type WorkflowNodeDraft = WorkflowStartNodeDraft | WorkflowScriptNodeDraft | WorkflowGateNodeDraft | WorkflowFinishNodeDraft

export interface WorkflowDocDraft {
  schema: 2
  name: string
  title: string
  description: string
  params: WorkflowParam[]
  /** The one `start` node's id — never `nodes[0]` (plan 301 §3.4). */
  entry: string
  nodes: WorkflowNodeDraft[]
  maxSteps: number
  onFail?: { script: string; params: Record<string, ValueExpr> }
}

const START_NODE_ID = 'start'

/** A brand-new, empty document — the `/workflows/editor` (no `?name=`) starting point. Carries its one undeletable `start` node from the first render (plan 301 §3.4). */
export function emptyDraft(): WorkflowDocDraft {
  return {
    schema: 2,
    name: '',
    title: '',
    description: '',
    params: [],
    entry: START_NODE_ID,
    nodes: [{ kind: 'start', id: START_NODE_ID, title: '', ui: { x: 0, y: 0 } }],
    maxSteps: 50,
  }
}

/**
 * A closed, trivially-true placeholder condition for a freshly-added gate
 * (plan 99 §3.7) — `true == true`, never left as an undefined `Predicate`
 * (which cannot be represented — `PredicateSchema` has no "empty" member).
 * The operator is expected to replace it; Validate flags an unedited one
 * with nothing more alarming than "always continues", never a crash.
 */
export function placeholderPredicate(): Predicate {
  return { left: { const: true }, op: 'eq', right: { const: true } }
}

const SLUG_RE = /[^a-z0-9-]+/g

/** `Auto-Scroll the Feed!` → `auto-scroll-the-feed` — `WorkflowNodeIdSchema`'s own grammar (lowercase, digits, hyphens, starting with one of the first two). */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(SLUG_RE, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug.slice(0, 48) : 'node'
}

/**
 * A fresh, unique node id derived from a human-readable seed (a script's own
 * name, or "gate") — never typed by the operator directly (plan 99 §5 step
 * 99.9's own design: node ids are plumbing, not a field to fill in). Appends
 * `-2`, `-3`, ... on collision, matching the numbering scheme
 * `groupByName`-adjacent code in this repo already uses for "the second one
 * needs a different name."
 */
export function freshNodeId(seed: string, existing: ReadonlySet<string>): string {
  const base = slugify(seed)
  if (!existing.has(base)) return base
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`
}

export function nodeIdsOf(draft: WorkflowDocDraft): Set<string> {
  return new Set(draft.nodes.map((n) => n.id))
}

/** Plan 99 §3.3 — the position-based default; a node may override either way. Position here means "is this the entry's own first script" — approximated for the list editor as array index 0 among non-start/finish nodes, since `reset` is a per-node override anyway. */
export function defaultReset(index: number): 'farm' | 'none' {
  return index === 0 ? 'farm' : 'none'
}

/** The plain-language sentence the editor shows for a script node (§3.3, §4.11) — never a toggle labelled "reset". */
export function startsFromLabel(reset: 'farm' | 'none'): string {
  return reset === 'farm' ? 'a clean device' : 'where the previous node finished'
}

/** A simple, deterministic placement for a freshly-added node — `{x: 0, y: 0}` for the very first non-start/finish node, one column right of the rightmost existing node otherwise (plan 301 §5 step 301.6: "rank-and-row for a new node, `{x:0,y:0}` for the first"). Real auto-arrange is `computeLayout`'s successor (plan 300 P12) — plan 305's job, not this one. */
function nextPosition(draft: WorkflowDocDraft): WorkflowPoint {
  if (draft.nodes.length === 0) return { x: 0, y: 0 }
  const maxX = Math.max(...draft.nodes.map((n) => n.ui.x))
  return { x: maxX + 240, y: 0 }
}

function newScriptNode(id: string, ui: WorkflowPoint): WorkflowScriptNodeDraft {
  return { kind: 'script', id, title: '', ui, script: '', params: {} }
}

function newGateNode(id: string, ui: WorkflowPoint): WorkflowGateNodeDraft {
  return { kind: 'gate', id, title: '', ui, when: placeholderPredicate() }
}

export function addScriptNode(draft: WorkflowDocDraft, seed = 'step'): WorkflowDocDraft {
  const id = freshNodeId(seed, nodeIdsOf(draft))
  return { ...draft, nodes: [...draft.nodes, newScriptNode(id, nextPosition(draft))] }
}

export function addGateNode(draft: WorkflowDocDraft): WorkflowDocDraft {
  const id = freshNodeId('gate', nodeIdsOf(draft))
  return { ...draft, nodes: [...draft.nodes, newGateNode(id, nextPosition(draft))] }
}

/** `start` is undeletable (plan 301 §3.4) — a no-op when `index` names it. */
export function removeNode(draft: WorkflowDocDraft, index: number): WorkflowDocDraft {
  if (draft.nodes[index]?.kind === 'start') return draft
  return { ...draft, nodes: draft.nodes.filter((_, i) => i !== index) }
}

export function moveNode(draft: WorkflowDocDraft, from: number, to: number): WorkflowDocDraft {
  if (to < 0 || to >= draft.nodes.length || from === to) return draft
  const nodes = [...draft.nodes]
  const [moved] = nodes.splice(from, 1)
  if (!moved) return draft
  nodes.splice(to, 0, moved)
  return { ...draft, nodes }
}

export function updateNode(draft: WorkflowDocDraft, index: number, patch: Partial<WorkflowNodeDraft>): WorkflowDocDraft {
  const nodes = draft.nodes.map((n, i) => (i === index ? ({ ...n, ...patch } as WorkflowNodeDraft) : n))
  return { ...draft, nodes }
}

/**
 * Strips the draft's editing looseness and asks `WorkflowDocSchema` — the
 * REAL protocol schema, never a re-implementation of its rules — whether the
 * result is a valid `WorkflowDoc`. `success: false` carries the same Zod
 * issues `POST /api/workflows` itself would surface for a structurally
 * invalid body (plan 99 §4.5's own `E_WORKFLOW_INVALID` path), so the editor
 * never disagrees with the server about what "valid" means.
 */
export function toWorkflowDoc(draft: WorkflowDocDraft): ReturnType<typeof WorkflowDocSchema.safeParse> {
  return WorkflowDocSchema.safeParse(draft)
}

/**
 * The SAME `WorkflowFinding[]` shape the server produces for a structurally
 * invalid document (`packages/core/src/api/workflows.ts`'s
 * `parseErrorFindings`) — built here, client-side, from a failed
 * `WorkflowDocSchema.safeParse`, so a document that is not even shaped like
 * a `WorkflowDoc` (an empty node list, a malformed node id) renders through
 * the exact same inline-findings UI as a server-side `checkWorkflow`
 * finding, never a second error presentation.
 */
export function zodIssuesToFindings(error: z.ZodError): WorkflowFinding[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: 'E_WORKFLOW_INVALID',
    message: issue.message,
    severity: 'error',
  }))
}

/**
 * The reverse of `toWorkflowDoc` — seeds a draft from an already-published
 * `WorkflowDoc` (the editor's "start from version" load, plan 99 §4.9). A
 * `WorkflowNode`'s shape is already byte-identical to `WorkflowNodeDraft`
 * (the draft only loosens `script`, which a published doc's own `script` is
 * already a valid string for), so this is a plain, non-lossy copy — never a
 * re-derivation of anything `WorkflowDocSchema` already validated.
 */
export function docToDraft(doc: WorkflowDoc): WorkflowDocDraft {
  return {
    schema: 2,
    name: doc.name,
    title: doc.title,
    description: doc.description,
    params: doc.params.map((p) => ({ ...p })),
    entry: doc.entry,
    nodes: doc.nodes.map((n) => ({ ...n })) as WorkflowNodeDraft[],
    maxSteps: doc.maxSteps,
    onFail: doc.onFail ? { script: doc.onFail.script, params: { ...doc.onFail.params } } : undefined,
  }
}

export type { WorkflowDoc }
