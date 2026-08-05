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
