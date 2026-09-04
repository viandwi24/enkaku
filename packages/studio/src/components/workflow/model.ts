import type { z } from 'zod'
import type { GateOutcome, Predicate, ValueExpr, WorkflowDoc, WorkflowFinding, WorkflowParam } from '@enkaku/protocol'
import { WorkflowDocSchema } from '@enkaku/protocol'

/**
 * The editor's own working shape for one node (plan 99 §3.1, §4.1, §5 step
 * 99.9). `WorkflowNodeSchema` (`@enkaku/protocol`) already IS this shape once
 * a document is valid — a draft is looser only in `script` (a `ScriptRef`
 * string once picked, `''` before the operator has chosen one), which is why
 * `toWorkflowDoc` below exists: it is the one place a draft is asked to prove
 * it is actually a `WorkflowDoc`, through the real Zod schema, never a
 * hand-rolled duplicate of its rules.
 */
export interface WorkflowScriptNodeDraft {
  kind: 'script'
  id: string
  title: string
  script: string
  params: Record<string, ValueExpr>
  reset?: 'farm' | 'none'
  retries?: number
  onFailure: GateOutcome
  next?: string
}

export interface WorkflowGateNodeDraft {
  kind: 'gate'
  id: string
  title: string
  when: Predicate
  then: GateOutcome
  else: GateOutcome
  message: string
}

export type WorkflowNodeDraft = WorkflowScriptNodeDraft | WorkflowGateNodeDraft

export interface WorkflowDocDraft {
  schema: 1
  name: string
  title: string
  description: string
  params: WorkflowParam[]
  nodes: WorkflowNodeDraft[]
  maxSteps: number
  onFail?: { script: string; params: Record<string, ValueExpr> }
}

/** A brand-new, empty document — the `/workflows/editor` (no `?name=`) starting point. */
export function emptyDraft(): WorkflowDocDraft {
  return {
    schema: 1,
    name: '',
    title: '',
    description: '',
    params: [],
    nodes: [],
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

/** Plan 99 §3.3 — the position-based default; a node may override either way. */
export function defaultReset(index: number): 'farm' | 'none' {
  return index === 0 ? 'farm' : 'none'
}

/** The plain-language sentence the editor shows for a script node (§3.3, §4.11) — never a toggle labelled "reset". */
export function startsFromLabel(reset: 'farm' | 'none'): string {
  return reset === 'farm' ? 'a clean device' : 'where the previous node finished'
}

function newScriptNode(id: string): WorkflowScriptNodeDraft {
  return { kind: 'script', id, title: '', script: '', params: {}, onFailure: { go: 'fail' } }
}

function newGateNode(id: string): WorkflowGateNodeDraft {
  return { kind: 'gate', id, title: '', when: placeholderPredicate(), then: { go: 'continue' }, else: { go: 'stop' }, message: '' }
}

export function addScriptNode(draft: WorkflowDocDraft, seed = 'step'): WorkflowDocDraft {
  const id = freshNodeId(seed, nodeIdsOf(draft))
  return { ...draft, nodes: [...draft.nodes, newScriptNode(id)] }
}

export function addGateNode(draft: WorkflowDocDraft): WorkflowDocDraft {
  const id = freshNodeId('gate', nodeIdsOf(draft))
  return { ...draft, nodes: [...draft.nodes, newGateNode(id)] }
}

export function removeNode(draft: WorkflowDocDraft, index: number): WorkflowDocDraft {
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
    schema: 1,
    name: doc.name,
    title: doc.title,
    description: doc.description,
    params: doc.params.map((p) => ({ ...p })),
    nodes: doc.nodes.map((n) => ({ ...n })) as WorkflowNodeDraft[],
    maxSteps: doc.maxSteps,
    onFail: doc.onFail ? { script: doc.onFail.script, params: { ...doc.onFail.params } } : undefined,
  }
}

export type { WorkflowDoc }
