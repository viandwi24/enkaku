import type { Bounds, UiNode } from '@enkaku/protocol'

/**
 * Dump-and-walk primitives — the answer to plan 86 §0.1: `matchSelector` (`@enkaku/protocol`,
 * `selector-match.ts`) is a depth-first walk that returns the FIRST match, and the `ui-server`
 * inspector this farm runs can never honestly report `ambiguous` (it forwards whatever the
 * on-device single-match search returns). So a selector that matches several nodes does not fail —
 * it silently resolves to whichever one the walk reaches first. Reproduced live against the
 * switch-account sheet, where three rows all share `id=l_z`: `find({id:'l_z'})` answered `ok` with
 * row 0's node every time, never `ambiguous`.
 *
 * On any screen shaped like a list — the switch-account sheet, a search-results page, a drawer —
 * `find()`/`waitFor()` are safe only for a selector already known to be unique. Everything else has
 * to call `dump()` once and walk the tree itself, which is what these five functions are for.
 */

/**
 * Every node in the tree, in depth-first order — the flat list `dump()` does not give you directly,
 * but every other helper in this file needs. One recursion, written once, so a script never has to
 * get `root.children` traversal right a second time.
 */
export function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}

/** Every node matching `pred`, depth-first — the `findAll` the SDK does not have. */
export function all(root: UiNode, pred: (n: UiNode) => boolean): UiNode[] {
  return flatten(root).filter(pred)
}

/**
 * Nodes whose `resourceId` ends `:id/<shortId>` — the repeated-row case of §0.1. On the
 * switch-account sheet, every row (the current account, every other logged-in account, and "Tambah
 * akun") shares `id=l_z`; `rowsById(tree, 'l_z')` is how a script sees all three instead of silently
 * getting row 0 back from `find`. The `endsWith(':id/<shortId>')` test mirrors `matches()` in
 * `@enkaku/protocol`'s `selector-match.ts` (the same rule a `{ id }` selector uses), so a short id
 * passed here means exactly what it would mean inside a normal selector.
 */
export function rowsById(root: UiNode, shortId: string): UiNode[] {
  return all(root, (n) => n.resourceId === shortId || n.resourceId.endsWith(`:id/${shortId}`))
}

/**
 * Depth-first text/desc lookup INSIDE one subtree — the scoping `find()`/`waitFor()` cannot
 * express, because both always walk from the tree ROOT. Two rows can legitimately share a child
 * value (an unread badge, a "Tanda centang" checkmark) and asking "is this row's checkmark here"
 * with a root-scoped selector would answer for whichever row the walk reaches first, not
 * necessarily the row being asked about. Starting the walk at `node` instead of the document root
 * is the other half of the §0.1 answer: `rowsById` finds the row containers, `textIn` reads safely
 * inside one of them. Prefers `text`, falls back to `desc` (a marker like the checkmark carries only
 * a `desc`), and returns the raw string so a caller can compare it — `null` means "not in this
 * subtree", not "empty string".
 */
export function textIn(node: UiNode, pred: (n: UiNode) => boolean): string | null {
  for (const n of flatten(node)) {
    if (pred(n)) return n.text || n.desc || null
  }
  return null
}

/**
 * True when `inner`'s box sits entirely inside `outer`'s — how a child node gets attributed to the
 * row that contains it, since a `UiNode` carries no pointer back to its parent row. Inclusive on
 * every edge: a row's own container and its immediate children commonly share an edge exactly (see
 * the sheet dump in plan 86 §4.2 — a row's children start flush against its top and bottom), and a
 * strict `<`/`>` comparison would wrongly exclude those.
 */
export function within(outer: Bounds, inner: Bounds): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom
}

/** Bounds centre; re-exported from `@enkaku/protocol` so a caller of this module needs one import, not two. */
export { centerOf } from '@enkaku/protocol'
