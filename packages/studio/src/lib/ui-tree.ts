import type { Bounds, UiNode } from '@enkaku/protocol'

/**
 * Reading a `UiNode` tree as rows — shared by Device Control's live
 * Inspector and the job Timeline's recorded one, so a node reads the same
 * way in both places.
 */

/** `android.widget.FrameLayout` → `FrameLayout`. */
export function shortClassName(className: string): string {
  const idx = className.lastIndexOf('.')
  return idx === -1 ? className : className.slice(idx + 1)
}

/** The most identifying thing about a node: its resource id, then its text, then its description. */
export function primaryLabel(node: UiNode): string {
  if (node.resourceId.trim()) return node.resourceId
  if (node.text.trim()) return node.text
  if (node.desc.trim()) return node.desc
  return ''
}

export interface FlatRow {
  node: UiNode
  depth: number
  path: number[]
}

export function flatten(node: UiNode, depth = 0, path: number[] = []): FlatRow[] {
  const rows: FlatRow[] = [{ node, depth, path }]
  node.children.forEach((child, i) => rows.push(...flatten(child, depth + 1, [...path, i])))
  return rows
}

/**
 * The screen size a tree was laid out on, read from the tree itself: the
 * furthest right and bottom edge any node reaches. A recorded tree carries
 * no frame size of its own, and the root of a multi-window dump is a
 * zero-bounds `hierarchy` node, so the root's bounds alone cannot be used.
 */
export function treeExtent(root: UiNode): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const { node } of flatten(root)) {
    width = Math.max(width, node.bounds.right)
    height = Math.max(height, node.bounds.bottom)
  }
  return { width, height }
}

/** `left,top right,bottom` — the same shape the Inspector has always shown. */
export function formatBounds(b: Bounds): string {
  return `${b.left},${b.top} ${b.right},${b.bottom}`
}
