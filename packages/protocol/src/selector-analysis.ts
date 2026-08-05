import { centerOf, matches } from './selector-match'
import type { Selector, UiNode } from './ui-node'

/**
 * Selector proposal and match counting for the Inspect tab (plan 56 §3.5,
 * §5.6). Pure and side-effect-free — Studio calls it directly against a
 * dumped tree, no round trip per candidate. This is the module the whole
 * feature's credibility rests on: every count here must equal what
 * `Inspector.find` will actually do, which is guaranteed by construction
 * because both call the same `matches()` from `./selector-match`.
 */

/** How many nodes in `root` this selector matches. `{ point }` never touches the tree — it always "matches" the single synthetic node it fabricates, so counting it is meaningless; callers should not call this for a point selector. */
export function countMatches(root: UiNode, sel: Selector): number {
  if ('point' in sel) return 1
  let count = 0
  const walk = (node: UiNode): void => {
    if (matches(node, sel)) count++
    for (const child of node.children) walk(child)
  }
  walk(root)
  return count
}

export type SelectorCandidateKind = 'id' | 'desc' | 'text' | 'point'

export interface SelectorCandidate {
  kind: SelectorCandidateKind
  selector: Selector
  /** Matches counted against the tree the candidate was proposed from. `null` only for `point`, which bypasses the inspector and is never counted (§3.5). */
  count: number | null
  /**
   * Set only for an `id` candidate whose value was shortened from a full
   * `pkg:id/name` resource id — the regex `ui-server` expands it to
   * (`ui-server/selector.ts`'s `toUiSelector`). Informational only: the
   * match COUNT above is always computed by the shared `matches()`, engine
   * -agnostic; this string exists solely so the operator is not surprised by
   * what crosses the wire to `ui-server`.
   */
  expandsTo?: string
  /** Always set — a human-readable read on the count (or, for `point`, why it carries no count at all). */
  note: string
}

/** `com.app:id/feed_action` → `feed_action`; a bare id (no `:id/` marker) passes through unchanged — it is already in the short form `matches()` accepts. */
function shortIdOf(resourceId: string): string {
  const marker = ':id/'
  const idx = resourceId.indexOf(marker)
  return idx === -1 ? resourceId : resourceId.slice(idx + marker.length)
}

/** Mirrors `ui-server/selector.ts`'s `escapeRegex` — display-only (see `expandsTo` above), never used to decide a match. */
function escapeForDisplay(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function noteFor(count: number): string {
  if (count === 0) return 'matches 0 nodes in this tree'
  if (count === 1) return '1 match — safe to use'
  return `${count} matches — find always returns the first one, in depth-first order`
}

/**
 * Ranked candidates for `node`, stable → fragile: `id` → `desc` → `text` →
 * `point` (§3.5). A kind is proposed only when the node actually carries
 * that field (empty after trimming is treated as absent); `point` is always
 * offered last, as the honest fallback when nothing else is available.
 */
export function proposeSelectors(root: UiNode, node: UiNode): SelectorCandidate[] {
  const out: SelectorCandidate[] = []

  const resourceId = node.resourceId.trim()
  if (resourceId) {
    const short = shortIdOf(resourceId)
    const selector: Selector = { id: short }
    const count = countMatches(root, selector)
    out.push({
      kind: 'id',
      selector,
      count,
      ...(short !== resourceId ? { expandsTo: `resourceIdMatches: .*:id/${escapeForDisplay(short)}` } : {}),
      note: noteFor(count),
    })
  }

  const desc = node.desc.trim()
  if (desc) {
    const selector: Selector = { desc }
    const count = countMatches(root, selector)
    out.push({ kind: 'desc', selector, count, note: noteFor(count) })
  }

  const text = node.text.trim()
  if (text) {
    const selector: Selector = { text }
    const count = countMatches(root, selector)
    out.push({ kind: 'text', selector, count, note: noteFor(count) })
  }

  out.push({
    kind: 'point',
    selector: { point: centerOf(node.bounds) },
    count: null,
    note: 'bypasses the inspector entirely — it is not counted against the tree and can never be used as an existence check',
  })

  return out
}
