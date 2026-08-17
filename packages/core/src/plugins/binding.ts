import {
  BINDING_DEVICE_FIELDS,
  BINDING_ENTRY_FIELDS,
  DANGEROUS_FIELD_NAMES,
  type Binding,
  type BindingDeviceField,
  type BindingEntryField,
} from '@enkaku/protocol'

/**
 * The evaluator for plan 108 §3.4's closed binding language — the ONE place a
 * declared `Binding` turns into a value, shared by every action kind
 * (`action-executor.ts`).
 *
 * Four properties, all load-bearing, all tested in `binding.test.ts`:
 *
 * - **Pure.** No database, no clock, no I/O. The same binding and the same
 *   scope always produce the same value.
 * - **DOM-free.** Nothing here imports React or touches a document, so the
 *   identical function could run in the browser if a later plan ever wants a
 *   preview — and, more importantly, so the farm-side evaluation is testable
 *   without a renderer (criterion 13: "tested with no DOM and no React import").
 * - **Total.** It never throws. An unresolvable path, a missing scope, a
 *   `$row` against a row that is a string — every one of those is a DATA
 *   condition, answered with `undefined`. An action clicked on a row whose
 *   scrape drifted must fail as "this job needs a `target`", never as a 500
 *   from the evaluator.
 * - **Closed.** Only the six declared forms are evaluated. Anything else —
 *   a bare string, a number, an object whose key is a `$`-marker the language
 *   does not have — yields `undefined` rather than being passed through as a
 *   literal. `{ $literal: … }` is the only way to say "a value the author
 *   wrote", exactly as `BindingSchema`'s own doc comment states.
 *
 * The DEPTH CAP lives here rather than in `@enkaku/protocol`'s
 * `BindingSchema`, deliberately (plan §3.4 leaves it to the evaluator): the
 * schema's job is to say what a binding may look like, and this function's
 * job is to be safe to run on one — including on a document that reached this
 * process some other way (a `plugins.manifest` row written by an older
 * vocabulary, re-validated on read but not re-depth-checked).
 */

/**
 * How deeply an object/array binding may nest before evaluation stops.
 *
 * Eight, not a larger round number, because the vocabulary gives an author no
 * reason to go deeper: a binding's leaves are row/form paths, and a path's own
 * depth is spelled inside the string (`{ $row: 'a.b.c.d' }` is depth 1),
 * so nesting only ever mirrors the shape of a params object. The worked
 * example in plan §4.3 is depth 2.
 */
export const BINDING_MAX_DEPTH = 8

/**
 * What an action can see. Every member is optional and every member is
 * allowed to be absent, malformed, or of the wrong type — this is the scope a
 * BROWSER supplied (`{ row?, form?, deviceIds? }` on the wire), so nothing
 * here may be assumed well-shaped.
 */
export interface BindingScope {
  /** The table row the action was invoked from, verbatim. */
  row?: unknown
  /** What a `form` action's dialog collected, verbatim. */
  form?: unknown
  /** The six allowlisted device fields of plan §3.6, or nothing. */
  device?: Partial<Record<BindingDeviceField, unknown>> | null
  /** The three allowlisted KV entry fields, or nothing. */
  entry?: Partial<Record<BindingEntryField, unknown>> | null
}

/** The five markers, and nothing else. A seventh would be a protocol change with a review attached. */
const BINDING_MARKERS = new Set(['$row', '$form', '$device', '$entry', '$literal'])

const DEVICE_FIELDS: ReadonlySet<string> = new Set(BINDING_DEVICE_FIELDS)
const ENTRY_FIELDS: ReadonlySet<string> = new Set(BINDING_ENTRY_FIELDS)

/**
 * One own-property read. `Reflect.get` rather than an index expression so
 * nothing has to be `as`-cast to `Record<string, unknown>` on the way in —
 * the value crossed a wire and is genuinely `unknown`, and pretending
 * otherwise is what 00-overview §4 forbids.
 */
function ownProperty(target: object, key: string): unknown {
  if (!Object.hasOwn(target, key)) return undefined
  const value: unknown = Reflect.get(target, key)
  return value
}

/**
 * `a.b.0.c` against an arbitrary value. Own properties only, and never a
 * prototype member: `DANGEROUS_FIELD_NAMES` is the SAME set
 * `@enkaku/protocol`'s schema limits already keep (imported, not restated), so
 * `{ $row: 'constructor.name' }` reads as "no such field" rather than as a
 * function name — and `Object.hasOwn` means it could not have anyway.
 *
 * `undefined` for every failure: an empty segment, a missing key, a path
 * through a primitive, a path through `null`.
 */
function readPath(root: unknown, path: string): unknown {
  if (path.length === 0) return undefined
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (segment.length === 0) return undefined
    if (DANGEROUS_FIELD_NAMES.has(segment)) return undefined
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = ownProperty(current, segment)
  }
  return current
}

function evaluateNode(node: unknown, scope: BindingScope, depth: number): unknown {
  // The cap applies to the STRUCTURE of the binding, never to the value it
  // produces: `{ $literal: <a deeply nested object> }` is depth 1 and is
  // returned whole. What is bounded here is recursion this function performs.
  if (depth > BINDING_MAX_DEPTH) return undefined

  if (Array.isArray(node)) return node.map((child) => evaluateNode(child, scope, depth + 1))
  // A bare string/number/boolean/null is NOT a binding (see `BindingSchema`'s
  // own note: a literal is spelled `{ $literal: … }`), so it is refused rather
  // than passed through — otherwise "a value read from the row" and "a value
  // the author typed" would be indistinguishable to a reader of the manifest.
  if (node === null || typeof node !== 'object') return undefined

  const keys = Object.keys(node)
  const markers = keys.filter((key) => key.startsWith('$'))
  if (markers.length > 0) {
    // A `$` key means the author reached for a marker. Exactly one key, and it
    // must be one of the five — `{ $concat: [...] }`, `{ $row: 'a', $form: 'b' }`
    // and `{ $row: 'a', extra: 1 }` are all refused here, the runtime half of
    // the reservation `BindingKeySchema` makes at the boundary.
    if (keys.length !== 1) return undefined
    const marker = markers[0]
    if (marker === undefined || !BINDING_MARKERS.has(marker)) return undefined
    const argument = ownProperty(node, marker)
    if (marker === '$literal') return argument
    if (typeof argument !== 'string') return undefined
    if (marker === '$row') return readPath(scope.row, argument)
    if (marker === '$form') return readPath(scope.form, argument)
    if (marker === '$device') return DEVICE_FIELDS.has(argument) ? readPath(scope.device ?? undefined, argument) : undefined
    if (marker === '$entry') return ENTRY_FIELDS.has(argument) ? readPath(scope.entry ?? undefined, argument) : undefined
    return undefined
  }

  const out: Record<string, unknown> = {}
  for (const key of keys) {
    // Same refusal `BindingKeySchema` makes: a binding may not BUILD a
    // `__proto__`/`constructor`/`prototype` key either.
    if (DANGEROUS_FIELD_NAMES.has(key)) continue
    out[key] = evaluateNode(ownProperty(node, key), scope, depth + 1)
  }
  return out
}

/**
 * Evaluate one declared binding against one scope. Never throws; see this
 * module's own doc comment for why that is a property and not an omission.
 */
export function evaluateBinding(binding: Binding, scope: BindingScope): unknown {
  return evaluateNode(binding, scope, 0)
}

/**
 * A binding that must produce a usable KV key or script parameter STRING.
 * `null` when it did not — the caller turns that into a coded refusal naming
 * the action, which is a much better message than `kv.set` failing on a key of
 * `"undefined"`.
 */
export function evaluateBindingAsString(binding: Binding, scope: BindingScope): string | null {
  const value = evaluateBinding(binding, scope)
  return typeof value === 'string' && value.length > 0 ? value : null
}
