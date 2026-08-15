import type { JsonSchemaNode } from '../api/json-schema'

/**
 * Hostile and edge-case parameter schemas (plan 95 §3.8, §7.2, §5 step
 * 95.5) — kept as a PERMANENT regression fixture set, not a throwaway
 * probe: this is the thing that stops a future change quietly reopening
 * F21/R1–R7. Each entry is a real JSON Schema node, the shape an attacker
 * (or merely a careless author) could actually publish.
 *
 * `checkDeclaredSchema` (`./limits.ts`) must refuse every BLOCKING entry (see
 * `HOSTILE_BLOCKING` below) at publish, naming a finding. The render path —
 * `clampSchema` (`./clamp.ts`) here, and `packages/studio`'s resolver
 * for a schema that already made it into the database before this plan —
 * must survive every entry without hanging, whether or not publish would
 * have refused it.
 *
 * Plan 95 §7.2 places this file at
 * `packages/studio/src/components/schema-form/fixtures/hostile.ts`. It
 * lives here instead because `@enkaku/protocol`'s own `limits.test.ts` and
 * `clamp.test.ts` need it, and `@enkaku/protocol` cannot depend on
 * `packages/studio` (plan 95 §3.1's package-graph boundary runs the other
 * way — protocol contains no word that names a control). Studio's own
 * `plan.test.ts` (the resolver's tests, step 95.2/95.3) can still reach
 * this exact set via `@enkaku/protocol`, so there is one fixture list, not
 * two that can drift.
 */

function nestedObject(depth: number): JsonSchemaNode {
  let node: JsonSchemaNode = { type: 'string' }
  for (let i = 0; i < depth; i++) {
    node = { type: 'object', properties: { next: node } }
  }
  return node
}

function wideObject(count: number): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  for (let i = 0; i < count; i++) properties[`field${i}`] = { type: 'number' }
  return { type: 'object', properties }
}

export const HOSTILE_PARAMS_FIXTURES = {
  /** `$defs.A.properties.next → #/$defs/A` — exactly what `z.lazy()` emits (F21, measured). */
  'self-ref-cycle': {
    type: 'object',
    properties: { node: { $ref: '#/$defs/Node' } },
    $defs: {
      Node: { type: 'object', properties: { value: { type: 'string' }, next: { $ref: '#/$defs/Node' } } },
    },
  },
  /** A → B → A: the cycle is not visible from either ref alone. */
  'mutual-ref-cycle': {
    type: 'object',
    properties: { start: { $ref: '#/$defs/A' } },
    $defs: {
      A: { type: 'object', properties: { toB: { $ref: '#/$defs/B' } } },
      B: { type: 'object', properties: { toA: { $ref: '#/$defs/A' } } },
    },
  },
  /** 40 nested objects — 8x `SCHEMA_LIMITS.maxDepth` (5). */
  'deep-40': nestedObject(40),
  /** 5 000 sibling scalars — 25x `SCHEMA_LIMITS.maxFields` (200). */
  'wide-5000': wideObject(5_000),
  /** One field, a 50 000-character description (R4). */
  'giant-description': {
    type: 'object',
    properties: { note: { type: 'string', description: 'x'.repeat(50_000) } },
  },
  /** One field, a 5 000-character title (R4). */
  'giant-title': {
    type: 'object',
    properties: { note: { type: 'string', title: 'x'.repeat(5_000) } },
  },
  /** One enum, 10 000 members — 50x `SCHEMA_LIMITS.maxEnumMembers` (200). */
  'enum-10000': {
    type: 'object',
    properties: { mode: { type: 'string', enum: Array.from({ length: 10_000 }, (_, i) => `v${i}`) } },
  },
  /** Classic catastrophic backtracking. Never compiled by this codebase (§3.8, R2) — the fixture exists to prove that, not to time a hang. */
  'redos-pattern': {
    type: 'object',
    properties: { token: { type: 'string', pattern: '^(a+)+$' } },
  },
  /**
   * A leading digit, a hyphen, and a prototype-pollution vector — a schema
   * is parsed JSON, so `__proto__` as an OWN property name is a real
   * vector, not a hypothetical one. Built with a COMPUTED key
   * (`['__proto__']`, not a literal `__proto__:`) on purpose: a literal
   * `__proto__: value` in a JS/TS object initializer is special-cased by
   * the language itself (Annex B.3.1) to set `[[Prototype]]` instead of
   * creating an own property — which is exactly the footgun this fixture
   * exists to catch downstream, so the fixture's OWN construction must not
   * fall into it. `JSON.parse('{"__proto__": ...}')`, by contrast, always
   * creates a real own property (`[[DefineOwnProperty]]`, not `[[Set]]`) —
   * a computed key reproduces that, a literal key would not.
   */
  'non-identifier-keys': {
    type: 'object',
    properties: {
      '1': { type: 'string' },
      'a-b': { type: 'string' },
      ['__proto__']: { type: 'string' },
    },
  },
  /** A bare `z.record` — `type: 'object'` with no `properties` (F19: never the empty card). */
  'record-no-properties': {
    type: 'object',
    additionalProperties: { type: 'number' },
  },
  /** A discriminated union with several real branches (F20: a labelled escape hatch, not a bare textarea). */
  'oneOf-many': {
    type: 'object',
    properties: {
      shape: {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' } } },
          { type: 'object', properties: { kind: { const: 'b' } } },
          { type: 'object', properties: { kind: { const: 'c' } } },
          { type: 'object', properties: { kind: { const: 'd' } } },
          { type: 'object', properties: { kind: { const: 'e' } } },
        ],
      },
    },
  },
  /** An array of objects (F18: a real row editor, not `[object Object]`). */
  'array-of-objects': {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, n: { type: 'number' } } },
      },
    },
  },
  /** No `x-enkaku` at all — the compatibility floor (criterion 4): a script published before this plan must render at least as well as it does today. */
  'bare-legacy': { type: 'object', properties: { videos: { type: 'integer' } } },
  /** A `kind`/key this build's vocabulary does not know — a schema published by a newer core, read by this one (`readHints` degrades to `{}`; §8's risk table). */
  'future-vocabulary': {
    type: 'object',
    properties: { color: { type: 'string', 'x-enkaku': { kind: 'colour', mood: 'calm' } } },
  },
  /** ~200 KiB serialised — one field, comfortably over `SCHEMA_LIMITS.maxSchemaBytes` (64 KiB) on the description alone. */
  'oversized-200kb': {
    type: 'object',
    properties: { note: { type: 'string', description: 'y'.repeat(200 * 1024) } },
  },
} satisfies Record<string, JsonSchemaNode>

export type HostileFixtureName = keyof typeof HOSTILE_PARAMS_FIXTURES

/**
 * The six named in plan 95 §5 step 95.5's own verifiable result: each MUST
 * be refused at publish with a named finding, and — being simultaneously a
 * schema that could already be sitting in the database from before this
 * check existed — MUST also render a clamped, usable form in under 200 ms
 * with no hang. The rest of `HOSTILE_PARAMS_FIXTURES` are edge cases for the
 * RESOLVER (degrade gracefully, never a blank field or a hang) rather than
 * publish-time rejections — `record-no-properties`, `oneOf-many`,
 * `array-of-objects`, `bare-legacy`, and `future-vocabulary` are all valid,
 * or at least non-hostile, schemas that simply exercise a resolver row.
 */
export const HOSTILE_BLOCKING: HostileFixtureName[] = [
  'self-ref-cycle',
  'mutual-ref-cycle',
  'deep-40',
  'wide-5000',
  'giant-description',
  'redos-pattern',
  'oversized-200kb',
  'non-identifier-keys',
  'giant-title',
  'enum-10000',
]
