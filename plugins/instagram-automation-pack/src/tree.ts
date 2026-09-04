import type { UiNode } from '@enkaku/protocol'

/** Every node in the tree, depth-first — the flat list `dump()` does not hand you directly. */
export function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}
