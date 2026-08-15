import type { Point } from './driver'
import type { Bounds, Selector, UiNode } from './ui-node'

/**
 * Moved here from `@enkaku/drivers` (plan 56 §3.6, §5.2). Studio has to count
 * selector matches for the Inspect tab, and it must never import
 * `@enkaku/drivers` — that package pulls adb and Bun-side transports into a
 * browser bundle. Duplicating the comparison in Studio would be worse: the
 * one thing the Inspect panel promises is that its match count equals what
 * `Inspector.find` actually does. So the comparison lives in `@enkaku/protocol`
 * (zod-only, no runtime deps) and both the drivers and Studio import it from
 * here — divergence between "what the panel says" and "what `find` does" is
 * impossible by construction.
 */

export function centerOf(b: Bounds): Point {
  return { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) }
}

/** Exported (not just used internally) so `countMatches`/`proposeSelectors` (selector-analysis.ts) can walk a whole tree, not just find the first match. */
export function matches(node: UiNode, sel: Selector): boolean {
  if ('id' in sel) {
    // Android uses the "com.app:id/name" form — accept a short name too.
    return node.resourceId === sel.id || node.resourceId.endsWith(`:id/${sel.id}`)
  }
  if ('desc' in sel) return node.desc.trim() === sel.desc.trim()
  if ('text' in sel) return node.text.trim() === sel.text.trim()
  return false
}

/**
 * The deepest node in `root` whose bounds contain `point`, preferring a
 * `clickable` node when the point falls inside more than one child's bounds at
 * the same recursion level (plan 94 §4.6, step 94.1) — the primitive the
 * recorder's anchor-based candidate proposal (`RecordingCandidateSchema`,
 * `./recording.ts`) hit-tests against before calling `proposeSelectors`
 * (`./selector-analysis.ts`, F13). Bounds are inclusive on every edge, so a
 * point exactly on a shared border matches both neighbours — normal for
 * adjacent siblings and resolved the same way as any other tie, by
 * `clickable`.
 *
 * "Deepest, preferring clickable" is depth-first with `clickable` as the
 * tie-break ACROSS SIBLING SUBTREES at one level — not a rule that climbs
 * back up past a genuinely deeper match. A container's own bounds always
 * enclose its children's in a real dump, so the common case (one child chain
 * containing the point) is unambiguous; the tie-break only matters when two
 * siblings both contain the point, which happens with overlapping decoration
 * (a badge drawn over a button, for instance).
 *
 * Returns `null` when `point` falls outside `root` itself — a genuine miss,
 * never a synthetic node the way `matchSelector`'s `{ point }` case fabricates
 * one, because a hit-test's whole purpose is telling a miss from a hit.
 */
export function hitTest(root: UiNode, point: Point): UiNode | null {
  if (!containsPoint(root.bounds, point)) return null
  const hits: UiNode[] = []
  for (const child of root.children) {
    const found = hitTest(child, point)
    if (found) hits.push(found)
  }
  if (hits.length === 0) return root
  return hits.find((n) => n.clickable) ?? hits[0] ?? root
}

function containsPoint(b: Bounds, p: Point): boolean {
  return p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom
}

/** Depth-first traversal, returning the first match. */
export function matchSelector(root: UiNode, sel: Selector): UiNode | null {
  if ('point' in sel) {
    // { point } bypasses the inspector entirely: a synthetic 1×1 node at that coordinate.
    return {
      resourceId: '',
      text: '',
      desc: '',
      className: 'synthetic-point',
      packageName: '',
      bounds: { left: sel.point.x, top: sel.point.y, right: sel.point.x + 1, bottom: sel.point.y + 1 },
      clickable: true,
      enabled: true,
      focused: false,
      index: 0,
      children: [],
    }
  }
  if (matches(root, sel)) return root
  for (const child of root.children) {
    const found = matchSelector(child, sel)
    if (found) return found
  }
  return null
}
