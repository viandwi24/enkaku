import { formatNodeValue } from './json-nodes'

export type DiffState = 'same' | 'changed' | 'only-left' | 'only-right'

export interface DiffRow {
  /** The same path shape `jsonNodes` emits, so the two views agree on what a field is called. */
  path: string
  left: string
  right: string
  state: DiffState
}

/** Every leaf path reachable in `value`, `path` -> the leaf's own value. Containers are not leaves; a
 *  container's identity IS its leaves (plan 218 §4.11's own reasoning). */
function leaves(value: unknown, path: string, out: Map<string, unknown>): void {
  if (value !== null && value !== undefined && typeof value === 'object') {
    if (Array.isArray(value)) {
      if (value.length === 0) out.set(path || '$', value)
      for (let i = 0; i < value.length; i++) leaves(value[i], path ? `${path}[${i}]` : `[${i}]`, out)
      return
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      out.set(path || '$', value)
      return
    }
    for (const [k, child] of entries) leaves(child, path ? `${path}.${k}` : k, out)
    return
  }
  out.set(path || '$', value)
}

/**
 * A field-by-field comparison of two JSON values (MVP 14 §2: "structured
 * results (`resultSchema`, plan 97) get a field-by-field diff"). Leaves only:
 * a container's identity is its leaves, and reporting "interactions changed"
 * above three rows that already say which one changed is noise. Sorted by
 * path, so the two runs' rows line up.
 */
export function diffJson(left: unknown, right: unknown): DiffRow[] {
  const leftLeaves = new Map<string, unknown>()
  const rightLeaves = new Map<string, unknown>()
  leaves(left, '', leftLeaves)
  leaves(right, '', rightLeaves)

  const paths = [...new Set([...leftLeaves.keys(), ...rightLeaves.keys()])].sort()
  const rows: DiffRow[] = []
  for (const path of paths) {
    const hasLeft = leftLeaves.has(path)
    const hasRight = rightLeaves.has(path)
    const leftVal = leftLeaves.get(path)
    const rightVal = rightLeaves.get(path)
    let state: DiffState
    if (!hasLeft) state = 'only-right'
    else if (!hasRight) state = 'only-left'
    else state = JSON.stringify(leftVal) === JSON.stringify(rightVal) ? 'same' : 'changed'
    rows.push({
      path,
      left: hasLeft ? formatNodeValue(leftVal).value : '—',
      right: hasRight ? formatNodeValue(rightVal).value : '—',
      state,
    })
  }
  return rows
}
