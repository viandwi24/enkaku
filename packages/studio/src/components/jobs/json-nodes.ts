/**
 * The JSON node tree the handoff draws for Inputs and Output (design
 * handoff, "Screen: Jobs", "Inputs / Output"): "each node indents 16px per
 * depth with a `ph-caret-down` (object/array) or `ph-dot-outline` (leaf),
 * the key in `Geist Mono` `var(--text)`, the value colored by type ... and
 * the type name at the right edge".
 */

export type JsonNodeType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

export interface JsonNodeRow {
  /** Dot/bracket path, unique per row; the collapse key and the diff key. */
  path: string
  depth: number
  key: string
  /** Already display-formatted: `"warm_a"`, `143`, `true`, `null`, `12 items`, `''` for an object. */
  value: string
  type: JsonNodeType
  /** Object and array rows carry a caret; leaves carry a dot. */
  collapsible: boolean
}

/** The handoff's own value wording: a string is JSON-quoted, an array reads
 *  "N items", an object's value column is empty, and everything else is its
 *  JSON literal. */
export function formatNodeValue(value: unknown): { value: string; type: JsonNodeType } {
  if (value === null || value === undefined) return { value: 'null', type: 'null' }
  if (Array.isArray(value)) return { value: `${value.length} item${value.length === 1 ? '' : 's'}`, type: 'array' }
  switch (typeof value) {
    case 'string':
      return { value: JSON.stringify(value), type: 'string' }
    case 'number':
      return { value: String(value), type: 'number' }
    case 'boolean':
      return { value: String(value), type: 'boolean' }
    case 'object':
      return { value: '', type: 'object' }
    default:
      return { value: String(value), type: 'null' }
  }
}

export const MAX_JSON_NODES = 2000

/**
 * Depth-first rows for a JSON value, honouring `collapsed` (a set of paths
 * whose descendants are omitted). Capped at `MAX_JSON_NODES`; when the cap
 * is hit the last row is a synthetic `{ type: 'null', key: '…', value: '<n>
 * more not shown' }` at depth 0, because a 40 000-row tree is not a reading
 * surface and silently stopping would be the omission this screen is not
 * allowed to make. Copy JSON always copies the whole value.
 */
export function jsonNodes(value: unknown, collapsed: ReadonlySet<string>): JsonNodeRow[] {
  const rows: JsonNodeRow[] = []

  function walk(v: unknown, depth: number, key: string, path: string): boolean {
    if (rows.length >= MAX_JSON_NODES) return false
    const { value: formatted, type } = formatNodeValue(v)
    const isContainer = type === 'object' || type === 'array'
    rows.push({ path, depth, key, value: formatted, type, collapsible: isContainer })
    if (!isContainer || collapsed.has(path)) return true

    if (type === 'array' && Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (!walk(v[i], depth + 1, String(i), `${path}[${i}]`)) return false
      }
    } else if (type === 'object' && v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (!walk(child, depth + 1, k, path ? `${path}.${k}` : k)) return false
      }
    }
    return true
  }

  // The top-level value is never given its own row: `job.params`/`run.result`
  // is already the object the reader wants to see the FIELDS of, and a
  // synthetic "root" row with an empty key would be one indent level of pure
  // noise. A top-level primitive (a script that returned a bare string) still
  // gets its one row, so the tree is never truly empty for a real value.
  let finished = true
  if (value !== null && value !== undefined && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!walk(value[i], 0, String(i), `[${i}]`)) {
          finished = false
          break
        }
      }
    } else {
      for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
        if (!walk(child, 0, k, k)) {
          finished = false
          break
        }
      }
    }
  } else {
    finished = walk(value, 0, '', '$')
  }

  if (!finished) {
    const shown = rows.length
    rows.push({ path: '$__more', depth: 0, key: '…', value: `${shown} more not shown`, type: 'null', collapsible: false })
  }
  return rows
}
