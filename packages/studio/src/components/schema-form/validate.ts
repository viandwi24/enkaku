import { deref, getNodeKind } from './resolve'
import type { JsonSchemaNode } from './types'

/**
 * Client-side validation from JSON Schema (the subset this form uses).
 * The server stays authoritative — this only exists for fast feedback.
 */
export function validateAgainstSchema(
  node: JsonSchemaNode,
  value: unknown,
  root: JsonSchemaNode,
  path = '',
): Record<string, string> {
  const errors: Record<string, string> = {}
  const n = deref(node, root)
  const kind = getNodeKind(n, root)

  if (kind === 'object' && n.properties) {
    const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    for (const key of n.required ?? []) {
      if (obj[key] === undefined || obj[key] === '') {
        errors[path ? `${path}.${key}` : key] = 'required'
      }
    }
    for (const [key, child] of Object.entries(n.properties)) {
      Object.assign(errors, validateAgainstSchema(child, obj[key], root, path ? `${path}.${key}` : key))
    }
    return errors
  }

  if (value === undefined || value === null) return errors

  if (kind === 'number') {
    const num = typeof value === 'number' ? value : Number(value)
    if (Number.isNaN(num)) errors[path] = 'must be a number'
    else if (n.minimum !== undefined && num < n.minimum) errors[path] = `must be at least ${n.minimum}`
    else if (n.maximum !== undefined && num > n.maximum) errors[path] = `must be at most ${n.maximum}`
  } else if (kind === 'string') {
    const str = String(value)
    if (n.minLength !== undefined && str.length < n.minLength) errors[path] = `must be at least ${n.minLength} characters`
    else if (n.maxLength !== undefined && str.length > n.maxLength) errors[path] = `must be at most ${n.maxLength} characters`
    else if (n.pattern && !new RegExp(n.pattern).test(str)) errors[path] = `does not match ${n.pattern}`
  } else if (kind === 'enum' && n.enum && !n.enum.includes(value)) {
    errors[path] = `must be one of: ${n.enum.join(', ')}`
  } else if (kind === 'range-tuple') {
    const arr = Array.isArray(value) ? value : []
    const [lo, hi] = [Number(arr[0]), Number(arr[1])]
    if (Number.isNaN(lo) || Number.isNaN(hi)) errors[path] = 'both values must be numbers'
    else if (lo > hi) errors[path] = 'the minimum cannot be greater than the maximum'
  }
  return errors
}
