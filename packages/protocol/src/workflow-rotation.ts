import type { WorkflowDoc } from './workflow'

/**
 * Does this document actually rotate — and on the slot the schedules pass?
 *
 * ## Why this is a check and not a comment in a plan
 *
 * The Rotation dialog creates one schedule per session, each carrying a
 * different `slot`. That is the whole mechanism: the document is expected to
 * branch on `slot`, so session 1 sends a phone to TikTok and session 2 sends
 * the same phone to Instagram (plan 314 §4's Latin square).
 *
 * Nothing checked that the chosen document branches on anything. Pick a
 * single-platform warm-up — the shape every farm has several of — and the
 * dialog would happily create three schedules that all run TikTok, three
 * times a day, forever. Three green batches, nothing red, and the phones
 * never see the other two platforms. That is the client's own stated fear,
 * arrived at through the very feature built to prevent it.
 *
 * So this answers the only question that matters before those rows are
 * written: *if I hand this document a different slot, does it do anything
 * different?*
 *
 * ## What counts
 *
 * A `switch` node with at least two cases whose predicates mention the slot
 * parameter. Deliberately shallow — it does not evaluate the expression, and
 * it does not insist on `($device.number + $params.slot) % 3`. An author may
 * write the rotation any number of ways, and a checker that recognised only
 * the one shape a plan happened to draw would reject correct documents, which
 * is a worse failure than the one it prevents. Referencing the slot at all is
 * the honest line between "this branches per session" and "this cannot".
 */
export interface RotationReading {
  /** The switch that branches on the slot, or null when nothing does. */
  nodeId: string | null
  /** How many branches that switch has — the number of platforms a rotation covers. */
  caseCount: number
  /** Null when the document rotates; otherwise what to tell the operator, in their own terms. */
  refusal: string | null
}

/** `$params.slot`, `$params['slot']`, and the bare `slot` an author may write inside a larger expression. */
function mentionsParam(expr: string, param: string): boolean {
  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\$params\\s*(?:\\.\\s*${escaped}\\b|\\[\\s*['"]${escaped}['"]\\s*\\])`).test(expr)
}

/** Every expression a switch case can carry, flattened — both sides of every predicate. */
function caseExpressions(node: Extract<WorkflowDoc['nodes'][number], { kind: 'switch' }>): string[] {
  const out: string[] = []
  for (const cs of node.cases) {
    const when = cs.when as { left?: unknown; right?: unknown } | undefined
    for (const side of [when?.left, when?.right]) {
      if (side && typeof side === 'object' && 'expr' in side && typeof side.expr === 'string') out.push(side.expr)
    }
  }
  return out
}

export function readRotation(doc: WorkflowDoc, slotParam: string): RotationReading {
  const empty: RotationReading = { nodeId: null, caseCount: 0, refusal: null }
  if (slotParam.trim() === '') {
    return { ...empty, refusal: 'Pick the parameter that carries the session number first.' }
  }
  if (!doc.params.some((p) => p.name === slotParam)) {
    return { ...empty, refusal: `This workflow has no parameter called "${slotParam}", so the session number would go nowhere.` }
  }

  const switches = doc.nodes.filter((n) => n.kind === 'switch')
  if (switches.length === 0) {
    return {
      ...empty,
      refusal: 'This workflow has no branch, so every session would do exactly the same thing. A rotation needs a switch that reads the session number.',
    }
  }

  for (const node of switches) {
    if (node.kind !== 'switch') continue
    if (!caseExpressions(node).some((e) => mentionsParam(e, slotParam))) continue
    if (node.cases.length < 2) {
      return { nodeId: node.id, caseCount: node.cases.length, refusal: 'The branch that reads the session number has only one case, so there is nothing to rotate between.' }
    }
    return { nodeId: node.id, caseCount: node.cases.length, refusal: null }
  }

  return {
    ...empty,
    refusal: `No branch in this workflow reads "${slotParam}", so all the sessions would run the same platform. Every session would be a copy of the first.`,
  }
}
