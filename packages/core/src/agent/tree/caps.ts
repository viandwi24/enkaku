import { EnkakuError } from '../../util/errors'

/**
 * The tree's three caps (plan 67 §3.6) — depth, run count, and a token
 * budget SHARED across the whole tree (not per-run: twenty children each
 * with the root's budget would be twenty times the authorised spend).
 *
 * Every one fails CLOSED: there is no path — no parse failure, no timeout,
 * no provider error — by which a failure produces more depth, more runs, or
 * more tokens. Depth and run-count are enforced by `agent.spawn` itself
 * (`capability/agent.ts`), failing the CALL with a named error the model can
 * act on rather than destroying the run (§3.6's own distinction). The token
 * budget is enforced by the loop (`loop/run.ts`), which stops a RUN with
 * `stopReason: 'max-tokens'` once the tree's shared spend is exhausted.
 */

export const DEFAULT_MAX_TREE_DEPTH = 3
export const DEFAULT_MAX_RUNS_PER_TREE = 25

/** root = depth 1, so a root, its children, and their children (default 3) — throws naming both the
 * limit and the run's own depth so the model can tell it is already at the edge. */
export function checkDepthCap(parentDepth: number, maxDepth: number = DEFAULT_MAX_TREE_DEPTH): void {
  const childDepth = parentDepth + 1
  if (childDepth > maxDepth) {
    throw new EnkakuError('E_DEPTH_LIMIT', `spawning here would put the child at depth ${childDepth}, beyond this tree's ${maxDepth}-level depth limit`)
  }
}

/** The whole tree, for its lifetime — CUMULATIVE (every run that ever existed in the tree, not just
 * the currently-active ones), so a tree cannot dodge the cap by letting runs finish and spawning more. */
export function checkTreeSizeCap(currentRunCount: number, maxRuns: number = DEFAULT_MAX_RUNS_PER_TREE): void {
  if (currentRunCount >= maxRuns) {
    throw new EnkakuError('E_TREE_SIZE_LIMIT', `this run tree has already reached its ${maxRuns}-run limit`)
  }
}

/** Whether the tree's shared output-token spend has reached the root's resolved `maxOutputTokens`
 * (plan 67 §3.6's table: "inherited from the root's maxOutputTokens"). Pure predicate, not a throw —
 * `loop/run.ts` calls this before every new model call and stops the RUN (not just this call) with
 * `stopReason: 'max-tokens'` when it is true, exactly like plan 66's own per-run budget check. */
export function treeTokenBudgetExhausted(spentAcrossTree: number, rootMaxOutputTokens: number): boolean {
  return spentAcrossTree >= rootMaxOutputTokens
}
