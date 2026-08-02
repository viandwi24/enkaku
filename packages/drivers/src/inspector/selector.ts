import type { Bounds, Point, Selector, UiNode } from '@enkaku/protocol'

export function centerOf(b: Bounds): Point {
  return { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) }
}

function matches(node: UiNode, sel: Selector): boolean {
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
    // { point } bypass inspector: node sintetis 1×1 di koordinat tsb.
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
