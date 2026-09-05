import type { ValueExpr } from './workflow'

/**
 * Everything a `set` node's assignment editor needs that is not the raw
 * schema (plan 312 §4.3, §4.5): the pure `setPath` write the executor also
 * uses, and the JSON ⇄ assignments codec (`AssignmentEditor.tsx`'s JSON
 * tab). All of it lives here, in `@enkaku/protocol`, rather than in Studio
 * or the core executor, so the SAME code both `checkWorkflow`-adjacent
 * tooling and the executor use, and so it is testable with a pure codec test
 * (plan 200 §8.3 — Studio has no tests of its own, so G11/G12 are proven
 * here instead).
 */

export interface SetAssignment {
  name: ValueExpr
  value: ValueExpr
}

// ---------------------------------------------------------------------------
// setPath — a `set` node's dot-notation write (plan 312 §3.4, §4.3).
// ---------------------------------------------------------------------------

const DIGITS_ONLY_RE = /^\d+$/

/** A field name segment made only of digits — refused everywhere a `set` node's name is checked (§3.4): dot notation builds nested OBJECTS only, never an array index, because writing into an array by index needs a rule for the gaps that no author has needed. */
export function isDigitsOnlySegment(segment: string): boolean {
  return DIGITS_ONLY_RE.test(segment)
}

export class SetPathError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Writes `value` at `name`'s dotted path into a COPY of `base`, building
 * nested objects along the way as needed — never mutating `base` (plan 312
 * §4.3: "It never mutates `$input`"). Throws `SetPathError` for an empty
 * segment or a digits-only one (§3.4); the checker (`workflow-check.ts`)
 * runs the same rule at publish time for a literal name, so an author sees
 * the refusal before a run ever reaches it.
 */
export function setPath(base: Record<string, unknown>, name: string, value: unknown): Record<string, unknown> {
  const segments = name.split('.')
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new SetPathError(`"${name}" has an empty segment — dot notation needs a name on both sides of every "."`)
    }
    if (isDigitsOnlySegment(segment)) {
      throw new SetPathError(`"${name}": the segment "${segment}" is only digits — dot notation builds nested objects, never an array index (plan 312 §3.4)`)
    }
  }
  const root: Record<string, unknown> = { ...base }
  let cursor: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string
    const existing = cursor[segment]
    const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {}
    cursor[segment] = next
    cursor = next
  }
  cursor[segments[segments.length - 1] as string] = value
  return root
}

// ---------------------------------------------------------------------------
// The interpolation splitter (plan 312 §4.5 rule 2) — `"run-{{ $now }}"`
// compiles to the ordinary expression source `"run-" + toText($now)`, parsed
// by the SAME `@enkaku/expr` parser as any other `{ expr }` binding. No new
// `ValueExpr` form, no executor change, no second evaluator: this is a
// splitter, the text between markers is literal and the text inside is
// handed to the existing parser untouched.
// ---------------------------------------------------------------------------

const TEMPLATE_MARKER_RE = /\{\{([\s\S]*?)\}\}/

/** Does `text` contain at least one `{{ ... }}` marker? */
export function hasTemplateMarkers(text: string): boolean {
  return TEMPLATE_MARKER_RE.test(text)
}

/**
 * Compiles a template string to `@enkaku/expr` source: literal runs become
 * quoted string literals, each `{{ ... }}` becomes `toText(<its contents>)`,
 * and the pieces are joined with `+`. A string with no markers at all still
 * compiles (to a single quoted literal) so this function is total over any
 * input, though callers only reach for it once `hasTemplateMarkers` says yes.
 */
export function compileTemplate(text: string): string {
  const parts: string[] = []
  const re = new RegExp(TEMPLATE_MARKER_RE, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) parts.push(JSON.stringify(text.slice(lastIndex, match.index)))
    parts.push(`toText(${(match[1] ?? '').trim()})`)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) parts.push(JSON.stringify(text.slice(lastIndex)))
  return parts.length > 0 ? parts.join(' + ') : JSON.stringify(text)
}

// ---------------------------------------------------------------------------
// The JSON codec (plan 312 §4.5) — a projection, never a second source of
// truth: `assignments[]` is the one stored shape, and both directions below
// either produce a value that round-trips exactly, or refuse with a reason
// (rule 3: "what cannot round-trip is refused in the editor, never stored
// raw"). A hand-rolled, minimal recursive-descent JSON reader backs the
// decode direction rather than `JSON.parse` — `JSON.parse` silently keeps
// the LAST of two duplicate keys, discarding the fact that there were two,
// which is exactly the case this codec must refuse (G12).
// ---------------------------------------------------------------------------

type JsonLeaf = string | number | boolean | null | JsonLeaf[]
interface JsonObj {
  readonly isObj: true
  entries: [string, JsonNode][]
}
type JsonNode = JsonLeaf | JsonObj

function isJsonObj(v: JsonNode): v is JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'isObj' in v
}

class DuplicateKeyError extends Error {
  constructor(readonly key: string) {
    super(`duplicate key "${key}"`)
  }
}

class JsonSyntaxError extends Error {}

/** A tiny, total, duplicate-key-aware JSON reader (see this module's own header comment for why `JSON.parse` cannot be used here). Throws `DuplicateKeyError` or `JsonSyntaxError`; never anything else. */
function readJson(text: string): JsonNode {
  let i = 0
  const n = text.length

  function skipWs(): void {
    while (i < n && /\s/.test(text[i] as string)) i++
  }
  function expect(lit: string): void {
    if (text.slice(i, i + lit.length) !== lit) throw new JsonSyntaxError(`expected "${lit}" at position ${i}`)
    i += lit.length
  }
  function readValue(): JsonNode {
    skipWs()
    const c = text[i]
    if (c === '{') return readObject()
    if (c === '[') return readArray()
    if (c === '"') return readString()
    if (c === 't') {
      expect('true')
      return true
    }
    if (c === 'f') {
      expect('false')
      return false
    }
    if (c === 'n') {
      expect('null')
      return null
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return readNumber()
    throw new JsonSyntaxError(`unexpected token at position ${i}`)
  }
  function readObject(): JsonObj {
    i++ // '{'
    const entries: [string, JsonNode][] = []
    const seen = new Set<string>()
    skipWs()
    if (text[i] === '}') {
      i++
      return { isObj: true, entries }
    }
    for (;;) {
      skipWs()
      if (text[i] !== '"') throw new JsonSyntaxError(`expected a string key at position ${i}`)
      const key = readString()
      if (seen.has(key)) throw new DuplicateKeyError(key)
      seen.add(key)
      skipWs()
      if (text[i] !== ':') throw new JsonSyntaxError(`expected ":" at position ${i}`)
      i++
      entries.push([key, readValue()])
      skipWs()
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '}') {
        i++
        break
      }
      throw new JsonSyntaxError(`expected "," or "}" at position ${i}`)
    }
    return { isObj: true, entries }
  }
  function readArray(): JsonLeaf[] {
    i++ // '['
    const out: JsonLeaf[] = []
    skipWs()
    if (text[i] === ']') {
      i++
      return out
    }
    for (;;) {
      const v = readValue()
      if (isJsonObj(v)) throw new JsonSyntaxError(`an object inside an array cannot become part of a "set" node's output at position ${i}`)
      out.push(v)
      skipWs()
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === ']') {
        i++
        break
      }
      throw new JsonSyntaxError(`expected "," or "]" at position ${i}`)
    }
    return out
  }
  function readString(): string {
    i++ // opening quote
    let s = ''
    while (text[i] !== '"') {
      if (i >= n) throw new JsonSyntaxError('unterminated string')
      const c = text[i] as string
      if (c === '\\') {
        i++
        const e = text[i]
        if (e === 'n') s += '\n'
        else if (e === 't') s += '\t'
        else if (e === 'r') s += '\r'
        else if (e === 'b') s += '\b'
        else if (e === 'f') s += '\f'
        else if (e === '"' || e === '\\' || e === '/') s += e
        else if (e === 'u') {
          s += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16))
          i += 4
        } else throw new JsonSyntaxError(`bad escape "\\${e}" at position ${i}`)
        i++
      } else {
        s += c
        i++
      }
    }
    i++ // closing quote
    return s
  }
  function readNumber(): number {
    const start = i
    if (text[i] === '-') i++
    while (i < n && (text[i] as string) >= '0' && (text[i] as string) <= '9') i++
    if (text[i] === '.') {
      i++
      while (i < n && (text[i] as string) >= '0' && (text[i] as string) <= '9') i++
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++
      if (text[i] === '+' || text[i] === '-') i++
      while (i < n && (text[i] as string) >= '0' && (text[i] as string) <= '9') i++
    }
    return Number(text.slice(start, i))
  }

  const value = readValue()
  skipWs()
  if (i < n) throw new JsonSyntaxError(`unexpected trailing content at position ${i}`)
  return value
}

export type JsonRefuseReason = 'top_level_not_object' | 'duplicate_key' | 'digits_only_key' | 'syntax'
export type JsonToAssignmentsResult = { ok: true; assignments: SetAssignment[] } | { ok: false; reason: JsonRefuseReason; message: string }

/** A leaf JSON value (string, number, boolean, null, or an array of those) as a `ValueExpr` — rules from §4.5: `"=..."` is an expression, `"==..."` is the escaped literal `"=..."`, a string with `{{ }}` markers is a compiled template, everything else is a plain literal. */
function decodeLeaf(value: JsonLeaf): ValueExpr {
  if (typeof value === 'string') {
    if (value.startsWith('==')) return { const: value.slice(1) }
    if (value.startsWith('=')) return { expr: value.slice(1) }
    if (hasTemplateMarkers(value)) return { expr: compileTemplate(value) }
    return { const: value }
  }
  return { const: value }
}

/** Walks a parsed `JsonObj` recursively, building one assignment per LEAF (a nested object descends; anything else — string/number/boolean/null/array — is a leaf, exactly as `set`'s own dot notation never indexes an array, §3.4). */
function collectAssignments(obj: JsonObj, prefix: readonly string[], out: SetAssignment[]): JsonToAssignmentsResult | null {
  for (const [key, value] of obj.entries) {
    if (isDigitsOnlySegment(key)) {
      return {
        ok: false,
        reason: 'digits_only_key',
        message: `the key "${key}" is only digits — dot notation builds nested objects, never an array index (plan 312 §3.4)`,
      }
    }
    const path = [...prefix, key]
    if (isJsonObj(value)) {
      const failure = collectAssignments(value, path, out)
      if (failure) return failure
      continue
    }
    out.push({ name: { const: path.join('.') }, value: decodeLeaf(value) })
  }
  return null
}

/**
 * Parses a JSON document (the "JSON Output" tab's own text) into
 * `assignments[]` (plan 312 §4.5). Refuses, rather than storing, exactly the
 * shapes that cannot round-trip (G12): a top-level array (or any other
 * non-object), a duplicate key at any nesting level, and a digits-only key
 * (which cannot become a dot-notation segment — the one value shape no
 * assignment can hold, since `set`'s dot notation never indexes an array).
 */
export function jsonToAssignments(text: string): JsonToAssignmentsResult {
  let parsed: JsonNode
  try {
    parsed = readJson(text)
  } catch (err) {
    if (err instanceof DuplicateKeyError) return { ok: false, reason: 'duplicate_key', message: err.message }
    return { ok: false, reason: 'syntax', message: err instanceof Error ? err.message : String(err) }
  }
  if (!isJsonObj(parsed)) {
    const isArray = Array.isArray(parsed)
    return {
      ok: false,
      reason: 'top_level_not_object',
      message: isArray
        ? 'the JSON document must be an object mapping field names to values — a top-level array cannot become assignments'
        : 'the JSON document must be an object mapping field names to values',
    }
  }
  const out: SetAssignment[] = []
  const failure = collectAssignments(parsed, [], out)
  if (failure) return failure
  return { ok: true, assignments: out }
}

export type AssignmentsToJsonResult = { ok: true; json: string } | { ok: false; message: string }

/** The inverse of `decodeLeaf` — a literal string starting with `=` is escaped as `==...` so it round-trips as the literal it is, an expression becomes `=<source>`, and anything else (a `{ param }`/`{ from }`/`{ run }` value) cannot be represented, since the JSON tab only ever offers Fixed-or-Expression, exactly like `ExprField`'s own toggle (§4.4). */
function encodeLeaf(value: ValueExpr): { ok: true; value: unknown } | { ok: false; message: string } {
  if ('const' in value) {
    if (typeof value.const === 'string' && value.const.startsWith('=')) return { ok: true, value: `=${value.const}` }
    return { ok: true, value: value.const }
  }
  if ('expr' in value) return { ok: true, value: `=${value.expr}` }
  return { ok: false, message: 'this value is a workflow parameter, a node reference, or the run summary — switch it to Fixed or fx before viewing it as JSON' }
}

/**
 * Renders `assignments[]` as the JSON document the JSON tab shows (plan 312
 * §4.5) — the exact inverse of `jsonToAssignments`. Every assignment must
 * have a literal, non-empty string NAME (an expression name has no fixed
 * key to project into JSON) and a literal-or-expression VALUE; anything else
 * is refused with a reason rather than guessed at, matching this module's
 * own "never stored raw, never rendered raw either" discipline.
 */
export function assignmentsToJson(assignments: readonly SetAssignment[]): AssignmentsToJsonResult {
  let root: Record<string, unknown> = {}
  for (const a of assignments) {
    if (!('const' in a.name) || typeof a.name.const !== 'string' || a.name.const.length === 0) {
      return { ok: false, message: 'a field whose NAME is an expression cannot be shown as JSON — switch its name to Fixed first' }
    }
    const encoded = encodeLeaf(a.value)
    if (!encoded.ok) return encoded
    try {
      root = setPath(root, a.name.const, encoded.value)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: true, json: JSON.stringify(root, null, 2) }
}
