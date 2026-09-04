#!/usr/bin/env bun
/**
 * Plan 301 §5 step 301.8 — proves the v1 → v2 workflow document migration
 * (`packages/core/src/workflows/upgrade.ts`) is behaviourally a no-op before
 * it is trusted anywhere. Reads every `workflows` row and every non-null
 * `jobs.workflow_doc` from a given data directory, upgrades each v1
 * document, and diffs the SUCCESSOR RELATION the v1 document implies against
 * the one the upgraded v2 document implies.
 *
 * "Successor relation," precisely: for every real node (never the synthetic
 * `start`/`finish` nodes plan 301 §3.2/§3.4 adds), what the v1 executor and
 * checker would compute as that node's success target and (for a script
 * node) failure target — each classified as `<nodeId>`, `END_SUCCEEDED`, or
 * `END_FAILED`. The SAME classification is computed against the upgraded v2
 * document by walking `next`/`onFailure`/`then`/`else`, treating a `finish`
 * node's own `status` as the terminal outcome and a dangling edge exactly as
 * plan 301 §3.2 defines it (absent `next` ⇒ succeeded, absent `onFailure` ⇒
 * failed). If every node's classification agrees between the two, every
 * possible run of the document — however many branches or loops it takes —
 * visits the identical real nodes in the identical order, because the walk
 * is defined node-by-node and this proves the two walks agree at every node.
 * That is what "diff the two step sequences" means here without actually
 * running scripts against a device.
 *
 * Usage: `bun run scripts/check-workflow-upgrade.ts <dataDir>`
 * (`.dev-data` by default). Exits non-zero on any divergence, or when the
 * data directory holds no `enkaku.db` at all (nothing to check is reported,
 * never silently treated as "passed").
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { upgradeWorkflowDoc } from '../packages/core/src/workflows/upgrade'
import type { WorkflowDoc } from '@enkaku/protocol'

// ---------------------------------------------------------------------------
// The v1 successor relation, computed directly against the RAW v1 JSON (not
// through any protocol schema — this script must be able to point at the
// v1 shape the same way `upgrade.ts`'s own frozen `WorkflowDocV1Schema`
// does, without importing it, so a bug in that schema cannot hide a real
// divergence from itself). Deliberately loose or malformed input is reported
// as a divergence, not silently skipped.
// ---------------------------------------------------------------------------

type Target = { kind: 'node'; id: string } | { kind: 'end'; status: 'succeeded' | 'failed' }

function nodeTarget(id: string): Target {
  return { kind: 'node', id }
}
const END_SUCCEEDED: Target = { kind: 'end', status: 'succeeded' }
const END_FAILED: Target = { kind: 'end', status: 'failed' }

function targetKey(t: Target): string {
  return t.kind === 'node' ? `node:${t.id}` : `end:${t.status}`
}

interface RawV1Node {
  kind: 'script' | 'gate'
  id: string
  next?: string
  onFailure?: { go: 'continue' | 'stop' | 'fail' } | { go: 'goto'; node: string }
  then?: { go: 'continue' | 'stop' | 'fail' } | { go: 'goto'; node: string }
  else?: { go: 'continue' | 'stop' | 'fail' } | { go: 'goto'; node: string }
}

/** One node's { success, failure } targets under v1 semantics — `failure` is `null` for a gate (it has no failure path of its own). */
interface NodeRelation {
  success: Target
  failure: Target | null
}

function v1OutcomeTarget(outcome: RawV1Node['next'] | RawV1Node['onFailure'] | RawV1Node['then'] | RawV1Node['else'], arrayNext: string | undefined): Target | null {
  if (outcome === undefined) return null // caller decides the default
  if (typeof outcome === 'string') return nodeTarget(outcome) // 'next' is a bare id in v1
  if (outcome.go === 'goto') return nodeTarget(outcome.node)
  if (outcome.go === 'continue') return arrayNext !== undefined ? nodeTarget(arrayNext) : END_SUCCEEDED
  if (outcome.go === 'stop') return END_SUCCEEDED
  return END_FAILED // 'fail'
}

function v1Relations(nodes: readonly RawV1Node[]): Map<string, NodeRelation> {
  const out = new Map<string, NodeRelation>()
  nodes.forEach((node, i) => {
    const arrayNext = nodes[i + 1]?.id
    if (node.kind === 'script') {
      const success = node.next !== undefined ? nodeTarget(node.next) : arrayNext !== undefined ? nodeTarget(arrayNext) : END_SUCCEEDED
      const failure = v1OutcomeTarget(node.onFailure, arrayNext) ?? END_FAILED // default onFailure: { go: 'fail' }
      out.set(node.id, { success, failure })
    } else {
      const then = v1OutcomeTarget(node.then, arrayNext) ?? (arrayNext !== undefined ? nodeTarget(arrayNext) : END_SUCCEEDED) // default { go: 'continue' }
      const els = v1OutcomeTarget(node.else, arrayNext) ?? END_SUCCEEDED // default { go: 'stop' }
      out.set(node.id, { success: then, failure: els })
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// The v2 successor relation — walked over the ALREADY-UPGRADED document,
// skipping straight through `start` (which costs no step, plan 301 §3.4) so
// a real v1 node's relation compares against a real v1 node's relation, not
// against the synthetic entry.
// ---------------------------------------------------------------------------

function v2EdgeTarget(id: string | undefined, endsAs: 'succeeded' | 'failed'): Target {
  if (id === undefined) return endsAs === 'succeeded' ? END_SUCCEEDED : END_FAILED
  return nodeTarget(id)
}

/** Resolves a v2 target through any chain of `finish` nodes (a `finish` costs no step, same as `start`) to the terminal it ultimately represents, or to the next REAL node it points at. */
function resolveThroughFinish(target: Target, finishById: Map<string, { status: 'succeed' | 'fail' }>): Target {
  if (target.kind === 'end') return target
  const finish = finishById.get(target.id)
  if (!finish) return target
  return finish.status === 'succeed' ? END_SUCCEEDED : END_FAILED
}

function v2Relations(doc: WorkflowDoc): Map<string, NodeRelation> {
  const out = new Map<string, NodeRelation>()
  const finishById = new Map<string, { status: 'succeed' | 'fail' }>()
  for (const n of doc.nodes) if (n.kind === 'finish') finishById.set(n.id, { status: n.status })

  for (const node of doc.nodes) {
    if (node.kind === 'script') {
      const success = resolveThroughFinish(v2EdgeTarget(node.next, 'succeeded'), finishById)
      const failure = resolveThroughFinish(v2EdgeTarget(node.onFailure, 'failed'), finishById)
      out.set(node.id, { success, failure })
    } else if (node.kind === 'gate') {
      const then = resolveThroughFinish(v2EdgeTarget(node.then, 'succeeded'), finishById)
      const els = resolveThroughFinish(v2EdgeTarget(node.else, 'succeeded'), finishById)
      out.set(node.id, { success: then, failure: els })
    }
    // `start`/`finish` are not real steps — excluded from the comparison.
  }
  return out
}

// ---------------------------------------------------------------------------
// The diff.
// ---------------------------------------------------------------------------

interface DiffResult {
  ok: boolean
  divergences: string[]
}

function diffOneDoc(name: string, raw: unknown): DiffResult {
  const divergences: string[] = []
  if (!isPlainObject(raw)) return { ok: false, divergences: [`"${name}": document is not a JSON object`] }

  if (raw.schema === 2) {
    return { ok: true, divergences: [] } // already v2 — nothing to migrate, nothing to diff
  }
  if (raw.schema !== 1) {
    return { ok: false, divergences: [`"${name}": unrecognised schema ${JSON.stringify(raw.schema)}`] }
  }

  const v1Nodes = Array.isArray(raw.nodes) ? (raw.nodes as RawV1Node[]) : []
  const before = v1Relations(v1Nodes)

  let upgraded: WorkflowDoc
  try {
    upgraded = upgradeWorkflowDoc(raw)
  } catch (err) {
    return { ok: false, divergences: [`"${name}": upgrade threw — ${err instanceof Error ? err.message : String(err)}`] }
  }
  const after = v2Relations(upgraded)

  for (const [id, rel] of before) {
    const afterRel = after.get(id)
    if (!afterRel) {
      divergences.push(`"${name}": node "${id}" is missing from the upgraded document entirely`)
      continue
    }
    if (targetKey(rel.success) !== targetKey(afterRel.success)) {
      divergences.push(`"${name}": node "${id}" success target diverges — v1: ${targetKey(rel.success)}, v2: ${targetKey(afterRel.success)}`)
    }
    if (rel.failure !== null && afterRel.failure !== null && targetKey(rel.failure) !== targetKey(afterRel.failure)) {
      divergences.push(`"${name}": node "${id}" failure target diverges — v1: ${targetKey(rel.failure)}, v2: ${targetKey(afterRel.failure)}`)
    }
  }

  return { ok: divergences.length === 0, divergences }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main(): void {
  const dataDir = process.argv[2] ?? '.dev-data'
  const dbPath = join(dataDir, 'enkaku.db')

  if (!existsSync(dbPath)) {
    console.log(`check-workflow-upgrade: no database at ${dbPath} — nothing to check.`)
    console.log(`Run with a real data directory: bun run scripts/check-workflow-upgrade.ts <dataDir>`)
    process.exitCode = 1
    return
  }

  const sqlite = new Database(dbPath, { readonly: true })
  let total = 0
  let divergent = 0
  const allDivergences: string[] = []

  const workflowRows = sqlite.query('SELECT name, doc FROM workflows').all() as { name: string; doc: string }[]
  for (const row of workflowRows) {
    total += 1
    const label = `workflows/${row.name}`
    let raw: unknown
    try {
      raw = JSON.parse(row.doc)
    } catch {
      divergent += 1
      allDivergences.push(`"${label}": doc column is not valid JSON`)
      console.log(`FAIL ${label}`)
      continue
    }
    const result = diffOneDoc(label, raw)
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${label}`)
    if (!result.ok) {
      divergent += 1
      allDivergences.push(...result.divergences)
    }
  }

  const jobRows = sqlite.query("SELECT id, workflow_doc FROM jobs WHERE workflow_doc IS NOT NULL").all() as { id: string; workflow_doc: string }[]
  for (const row of jobRows) {
    total += 1
    const label = `jobs/${row.id}`
    let raw: unknown
    try {
      raw = JSON.parse(row.workflow_doc)
    } catch {
      divergent += 1
      allDivergences.push(`"${label}": workflow_doc column is not valid JSON`)
      console.log(`FAIL ${label}`)
      continue
    }
    const result = diffOneDoc(label, raw)
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${label}`)
    if (!result.ok) {
      divergent += 1
      allDivergences.push(...result.divergences)
    }
  }

  sqlite.close()

  console.log('')
  console.log(`checked ${total} document(s), ${divergent} divergent`)
  if (allDivergences.length > 0) {
    console.log('')
    console.log('divergences:')
    for (const d of allDivergences) console.log(`  - ${d}`)
  }

  process.exitCode = divergent > 0 ? 1 : 0
}

main()
