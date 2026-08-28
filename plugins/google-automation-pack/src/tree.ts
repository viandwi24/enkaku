import type { UiNode } from '@enkaku/protocol'

/**
 * Dump-and-walk primitives.
 *
 * The same reasoning `plugins/tiktok-automation-pack/src/tree.ts` records, and
 * it applies to every screen this pack will ever touch: `matchSelector`
 * (`@enkaku/protocol`) is a depth-first walk that returns the FIRST match, and
 * the `ui-server` inspector cannot honestly report `ambiguous` — it forwards
 * whatever the on-device single-match search returned. So a selector matching
 * several nodes does not fail; it silently resolves to whichever the walk
 * reaches first.
 *
 * Android's accounts screen is a `RecyclerView` of near-identical rows, which
 * is exactly the shape that goes wrong. `find()`/`waitFor()` are safe here only
 * for a selector already known to be unique; everything else dumps once and
 * walks the tree itself.
 *
 * Deliberately a copy rather than an import: a pack is bundled standalone by
 * `enkaku publish`, and cross-pack imports are not a thing the packaging
 * supports. Four small functions duplicated is the cheaper half of that trade.
 */

/** Every node in the tree, depth-first — the flat list `dump()` does not hand you directly. */
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
 * Nodes whose `resourceId` ends `:id/<shortId>`. The `endsWith` test mirrors
 * `matches()` in `@enkaku/protocol`'s `selector-match.ts`, so a short id passed
 * here means exactly what it would mean inside an ordinary `{ id }` selector.
 */
export function rowsById(root: UiNode, shortId: string): UiNode[] {
  return all(root, (n) => n.resourceId === shortId || n.resourceId.endsWith(`:id/${shortId}`))
}

/** Every non-empty `text` and `desc` in the tree, depth-first, de-duplicated in first-seen order. */
export function visibleStrings(root: UiNode): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const node of flatten(root)) {
    for (const raw of [node.text, node.desc]) {
      const value = raw.trim()
      if (value === '' || seen.has(value)) continue
      seen.add(value)
      out.push(value)
    }
  }
  return out
}
