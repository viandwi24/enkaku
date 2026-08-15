import { describe, expect, test } from 'bun:test'
import { applyDefaults, getAtPath, setAtPath } from './resolve'
import type { JsonSchemaNode } from './types'

/**
 * A parameter schema is untrusted input — a shared script's author names every
 * field in it. These tests pin the prototype-hijack guard in `resolve.ts`.
 *
 * The first test is the important one: it demonstrates that the underlying
 * hazard is real in plain JavaScript, so the guard below is protecting against
 * something rather than warding off a theory. Without it, `applyDefaults` on a
 * schema with a `__proto__` property replaces the params object's prototype
 * with author-chosen data.
 */
describe('prototype-hijack guard', () => {
  test('the hazard being guarded against is real', () => {
    const naive: Record<string, unknown> = {}
    naive['__proto__'] = { hijacked: true }

    // Not global pollution — a fresh object elsewhere is unaffected — but this
    // object's own prototype is now attacker-controlled.
    expect((Object.getPrototypeOf(naive) as { hijacked?: boolean }).hijacked).toBe(true)
    expect(({} as { hijacked?: boolean }).hijacked).toBeUndefined()
  })

  test('applyDefaults skips a __proto__ property instead of writing through it', () => {
    // Built with `JSON.parse`, not an object literal — and the distinction is
    // the whole point. In a literal, `__proto__:` is special syntax that sets
    // the prototype instead of creating an own property, so a literal fixture
    // would silently test nothing. `JSON.parse` creates a real own property,
    // which is exactly how a schema arrives from the database.
    const schema = JSON.parse(
      '{"type":"object","properties":{"videos":{"type":"number","default":5},' +
        '"__proto__":{"type":"object","properties":{},"default":{"hijacked":true}}}}',
    ) as JsonSchemaNode

    const result = applyDefaults(schema, undefined, schema) as Record<string, unknown>

    expect(result.videos).toBe(5)
    // Prototype identity is the assertion that matters. Writing through
    // `__proto__` replaces it — with `{}` on this path rather than with the
    // author's `default`, which still strips the object of everything it
    // inherits. Checking for a marker value instead would pass either way and
    // prove nothing; this fails the moment the guard is removed.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  test('setAtPath refuses a write whose path contains an unsafe segment', () => {
    const before = { videos: 5 }

    for (const path of ['__proto__', 'constructor', 'prototype', 'nested.__proto__']) {
      const after = setAtPath(before, path, { hijacked: true })
      expect((Object.getPrototypeOf(after) as { hijacked?: boolean }).hijacked).toBeUndefined()
      // Refused whole, never half-applied.
      expect(after).toEqual(before)
    }
  })

  test('ordinary paths still write, so the guard is not over-broad', () => {
    expect(setAtPath({ videos: 5 }, 'videos', 9)).toEqual({ videos: 9 })
    expect(setAtPath({}, 'a.b', 1)).toEqual({ a: { b: 1 } })
    expect(getAtPath({ a: { b: 1 } }, 'a.b')).toBe(1)
  })

  test('clearing an optional field still deletes the key rather than assigning undefined', () => {
    // `JSON.stringify` drops an `undefined` property, so assigning one would
    // silently no-op a "clear this field" edit on the way to the server.
    const cleared = setAtPath({ videos: 5, region: 'id' }, 'region', undefined)
    expect(Object.prototype.hasOwnProperty.call(cleared, 'region')).toBe(false)
    expect(JSON.stringify(cleared)).toBe('{"videos":5}')
  })
})
