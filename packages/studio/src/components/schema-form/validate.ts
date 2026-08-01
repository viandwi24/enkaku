import { deref, getNodeKind } from './resolve'
import type { JsonSchemaNode } from './types'

/**
 * Validasi client-side dari JSON Schema (subset yang dipakai form ini).
 * Server tetap otoritatif — ini hanya untuk feedback cepat.
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
        errors[path ? `${path}.${key}` : key] = 'wajib diisi'
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
    if (Number.isNaN(num)) errors[path] = 'harus angka'
    else if (n.minimum !== undefined && num < n.minimum) errors[path] = `minimal ${n.minimum}`
    else if (n.maximum !== undefined && num > n.maximum) errors[path] = `maksimal ${n.maximum}`
  } else if (kind === 'string') {
    const str = String(value)
    if (n.minLength !== undefined && str.length < n.minLength) errors[path] = `minimal ${n.minLength} karakter`
    else if (n.maxLength !== undefined && str.length > n.maxLength) errors[path] = `maksimal ${n.maxLength} karakter`
    else if (n.pattern && !new RegExp(n.pattern).test(str)) errors[path] = `tidak cocok pola ${n.pattern}`
  } else if (kind === 'enum' && n.enum && !n.enum.includes(value)) {
    errors[path] = `harus salah satu dari: ${n.enum.join(', ')}`
  } else if (kind === 'range-tuple') {
    const arr = Array.isArray(value) ? value : []
    const [lo, hi] = [Number(arr[0]), Number(arr[1])]
    if (Number.isNaN(lo) || Number.isNaN(hi)) errors[path] = 'kedua nilai harus angka'
    else if (lo > hi) errors[path] = 'nilai minimum tidak boleh lebih besar dari maksimum'
  }
  return errors
}
