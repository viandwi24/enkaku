import type { UiNode } from '@enkaku/protocol'

/**
 * Dump-and-walk primitives.
 *
 * `matchSelector` (`@enkaku/protocol`) returns the FIRST depth-first match and
 * can never report `ambiguous`, and every Instagram surface this pack touches
 * is a list of near-identical rows (a feed, a grid, a gallery, a story tray).
 * So a script dumps once and walks the tree itself.
 *
 * Deliberately a copy of `youtube-automation-pack/src/tree.ts` rather than an
 * import: a pack is bundled standalone and cross-pack imports are not supported.
 */

/** Every node in the tree, depth-first — the flat list `dump()` does not hand you directly. */
export function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}

/** Every node matching `pred`, depth-first. */
export function all(root: UiNode, pred: (n: UiNode) => boolean): UiNode[] {
  return flatten(root).filter(pred)
}

/** Nodes whose `resourceId` ends `:id/<shortId>` — the same rule an `{ id }` selector uses. */
export function rowsById(root: UiNode, shortId: string): UiNode[] {
  return all(root, (n) => n.resourceId === shortId || n.resourceId.endsWith(`:id/${shortId}`))
}

/** True when `inner` lies entirely inside `outer`. */
export function within(inner: UiNode, outer: UiNode): boolean {
  const a = inner.bounds
  const b = outer.bounds
  return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom
}

/** The frame the tree describes — the widest/tallest bounds in it, since a root can arrive as 0,0,0,0. */
export function treeFrame(tree: UiNode): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const n of flatten(tree)) {
    width = Math.max(width, n.bounds.right)
    height = Math.max(height, n.bounds.bottom)
  }
  return { width: width || 720, height: height || 1640 }
}
