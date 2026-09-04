import { describe, expect, test } from 'bun:test'
import { BindingSchema, type Binding } from '@enkaku/protocol'
import { BINDING_MAX_DEPTH, evaluateBinding, evaluateBindingAsString, type BindingScope } from './binding'

/**
 * Plan 108 §3.4, criterion 13 — "a binding evaluates every declared form,
 * refuses depth beyond the cap, and is tested with no DOM and no React
 * import."
 *
 * This file imports neither, and must never come to: the whole point of the
 * evaluator being pure and total is that it is testable without a renderer.
 */

const scope: BindingScope = {
  row: {
    username: 'alice',
    position: 2,
    nested: { deep: { value: 'found' } },
    list: [{ tag: 'first' }, { tag: 'second' }],
    nul: null,
  },
  form: { label: 'Renamed', count: 7 },
  device: { id: 'd1', stableId: 's1', label: 'Pixel 7', status: 'online', groupId: null, number: 7 },
  entry: { key: 'accounts', version: 3, updatedAt: 1_700_000_000 },
}

describe('every declared form', () => {
  test('$literal returns the author-written value verbatim, whatever its type', () => {
    expect(evaluateBinding({ $literal: 'username' }, scope)).toBe('username')
    expect(evaluateBinding({ $literal: 42 }, scope)).toBe(42)
    expect(evaluateBinding({ $literal: null }, scope)).toBe(null)
    expect(evaluateBinding({ $literal: { any: ['shape'] } }, scope)).toEqual({ any: ['shape'] })
  })

  test('$row reads a dot path out of the row, including through arrays', () => {
    expect(evaluateBinding({ $row: 'username' }, scope)).toBe('alice')
    expect(evaluateBinding({ $row: 'nested.deep.value' }, scope)).toBe('found')
    expect(evaluateBinding({ $row: 'list.1.tag' }, scope)).toBe('second')
  })

  test('$form reads the submitted values', () => {
    expect(evaluateBinding({ $form: 'label' }, scope)).toBe('Renamed')
    expect(evaluateBinding({ $form: 'count' }, scope)).toBe(7)
  })

  test('$device reads only the six allowlisted fields', () => {
    expect(evaluateBinding({ $device: 'stableId' }, scope)).toBe('s1')
    expect(evaluateBinding({ $device: 'label' }, scope)).toBe('Pixel 7')
    expect(evaluateBinding({ $device: 'groupId' }, scope)).toBe(null)
    expect(evaluateBinding({ $device: 'number' }, scope)).toBe(7)
  })

  /**
   * The device NUMBER is the sixth allowlisted field, and it is the one that
   * is legitimately absent: a device whose reservation was released, or one
   * admitted before any was allocated, carries no number at all. That must
   * read as `undefined` — the evaluator's own "this is data, not a defect"
   * answer — and never as a throw, because the row it came from is a row an
   * operator is looking at right now.
   */
  test('$device.number is undefined, never a throw, for a device that has none', () => {
    const noNumber: BindingScope = { device: { id: 'd2', stableId: 's2', label: 'Pixel 4a', status: 'online', groupId: null, number: null } }
    expect(evaluateBinding({ $device: 'number' }, noNumber)).toBe(null)
    // And a scope that does not carry the key at all — an older row, or a caller that sent less.
    const absent: BindingScope = { device: { id: 'd3' } }
    expect(evaluateBinding({ $device: 'number' }, absent)).toBeUndefined()
    expect(evaluateBinding({ $device: 'number' }, {})).toBeUndefined()
  })

  test('$entry reads only the three allowlisted metadata fields', () => {
    expect(evaluateBinding({ $entry: 'key' }, scope)).toBe('accounts')
    expect(evaluateBinding({ $entry: 'version' }, scope)).toBe(3)
    expect(evaluateBinding({ $entry: 'updatedAt' }, scope)).toBe(1_700_000_000)
  })

  test('an object binding evaluates each leaf and keeps its own keys', () => {
    const binding: Binding = { target: { $row: 'username' }, slot: { $row: 'position' }, mode: { $literal: 'switch' } }
    expect(evaluateBinding(binding, scope)).toEqual({ target: 'alice', slot: 2, mode: 'switch' })
  })

  test('an array binding evaluates element-wise and stays an array', () => {
    const binding: Binding = [{ $row: 'username' }, { $device: 'stableId' }, { $literal: 3 }]
    const value = evaluateBinding(binding, scope)
    expect(Array.isArray(value)).toBe(true)
    expect(value).toEqual(['alice', 's1', 3])
  })
})

describe('nesting', () => {
  test('objects inside arrays inside objects all resolve', () => {
    const binding: Binding = {
      accounts: [
        { name: { $row: 'username' }, device: { $device: 'label' } },
        { name: { $literal: 'bob' }, device: { $form: 'label' } },
      ],
      meta: { syncedAt: { $entry: 'updatedAt' } },
    }
    expect(evaluateBinding(binding, scope)).toEqual({
      accounts: [
        { name: 'alice', device: 'Pixel 7' },
        { name: 'bob', device: 'Renamed' },
      ],
      meta: { syncedAt: 1_700_000_000 },
    })
  })

  test('the shape the schema accepts is the shape the evaluator walks — an array is never turned into a map', () => {
    // `BindingSchema` orders `z.array` BEFORE `z.record` precisely so this
    // holds; the evaluator must not undo it either.
    const parsed = BindingSchema.parse([{ $literal: 'a' }, { $literal: 'b' }])
    expect(Array.isArray(evaluateBinding(parsed, scope))).toBe(true)
  })
})

describe('the depth cap', () => {
  /** An object binding nested `depth` levels, with a `$row` leaf at the bottom. */
  function nest(depth: number): Binding {
    let node: Binding = { $row: 'username' }
    for (let i = 0; i < depth; i++) node = { k: node }
    return node
  }

  /** Walks `depth` `k` keys down and returns whatever is there. */
  function dig(value: unknown, depth: number): unknown {
    let current: unknown = value
    for (let i = 0; i < depth; i++) {
      if (current === null || typeof current !== 'object') return undefined
      current = Reflect.get(current, 'k')
    }
    return current
  }

  test('a binding nested exactly to the cap still resolves its leaf', () => {
    const depth = BINDING_MAX_DEPTH - 1
    expect(dig(evaluateBinding(nest(depth), scope), depth)).toBe('alice')
  })

  test('a binding nested past the cap yields undefined at the over-deep node, and never throws', () => {
    const depth = BINDING_MAX_DEPTH + 4
    const value = evaluateBinding(nest(depth), scope)
    expect(dig(value, depth)).toBeUndefined()
    // Everything above the cap is still an object — the cap truncates, it does
    // not crash, which is what "total" means here.
    expect(dig(value, BINDING_MAX_DEPTH - 1)).toBeDefined()
  })

  test('a deep VALUE inside $literal is not walked and comes back whole', () => {
    let deep: unknown = 'bottom'
    for (let i = 0; i < 50; i++) deep = { k: deep }
    expect(evaluateBinding({ $literal: deep }, scope)).toBe(deep)
  })
})

describe('an unresolvable path yields undefined, never a throw', () => {
  test.each([
    ['a missing top-level field', { $row: 'nope' } as Binding],
    ['a missing nested field', { $row: 'nested.missing.value' } as Binding],
    ['a path through a primitive', { $row: 'username.length' } as Binding],
    ['a path through null', { $row: 'nul.anything' } as Binding],
    ['an out-of-range array index', { $row: 'list.9.tag' } as Binding],
    ['a non-numeric array index', { $row: 'list.tag' } as Binding],
    ['an empty segment', { $row: 'nested..value' } as Binding],
  ])('%s', (_name, binding) => {
    expect(evaluateBinding(binding, scope)).toBeUndefined()
  })

  test('an empty scope resolves every marker to undefined rather than failing', () => {
    const empty: BindingScope = {}
    expect(evaluateBinding({ $row: 'username' }, empty)).toBeUndefined()
    expect(evaluateBinding({ $form: 'label' }, empty)).toBeUndefined()
    expect(evaluateBinding({ $device: 'stableId' }, empty)).toBeUndefined()
    expect(evaluateBinding({ $entry: 'key' }, empty)).toBeUndefined()
    expect(evaluateBinding({ a: { $row: 'username' } }, empty)).toEqual({ a: undefined })
  })

  test('a prototype member is not reachable through a path', () => {
    expect(evaluateBinding({ $row: 'constructor' }, scope)).toBeUndefined()
    expect(evaluateBinding({ $row: '__proto__.polluted' }, scope)).toBeUndefined()
    expect(evaluateBinding({ $row: 'nested.constructor.name' }, scope)).toBeUndefined()
  })
})

describe('an undeclared shape is refused', () => {
  /**
   * These are values `BindingSchema` would already have rejected at the
   * boundary. They are tested against the EVALUATOR anyway, because a
   * `plugins.manifest` row can outlive the vocabulary that wrote it and the
   * evaluator is the last thing standing between a stored document and a job's
   * parameters. `unknown`-typed and cast to `Binding` only to reach the
   * function — that is the whole point of the test.
   */
  function refused(node: unknown): unknown {
    return evaluateBinding(node as Binding, scope)
  }

  test('a bare literal is not a binding — a literal is spelled { $literal: … }', () => {
    expect(refused('username')).toBeUndefined()
    expect(refused(42)).toBeUndefined()
    expect(refused(true)).toBeUndefined()
    expect(refused(null)).toBeUndefined()
  })

  test('an invented operator is refused, not read as a one-key map', () => {
    expect(refused({ $concat: [{ $row: 'username' }, { $literal: '!' }] })).toBeUndefined()
    expect(refused({ $if: { $row: 'username' } })).toBeUndefined()
    expect(refused({ $sql: 'select 1' })).toBeUndefined()
  })

  test('a marker mixed with any other key is refused whole', () => {
    expect(refused({ $row: 'username', extra: { $literal: 1 } })).toBeUndefined()
    expect(refused({ $row: 'username', $form: 'label' })).toBeUndefined()
  })

  test('a marker whose argument is not a string is refused', () => {
    expect(refused({ $row: 7 })).toBeUndefined()
    expect(refused({ $device: { nested: true } })).toBeUndefined()
  })

  test('a device/entry field outside the allowlist is refused even if the scope carries it', () => {
    const wide: BindingScope = { device: { id: 'd1' }, entry: { key: 'k' } }
    expect(refused({ $device: 'ownerId' })).toBeUndefined()
    expect(refused({ $entry: 'value' })).toBeUndefined()
    expect(evaluateBinding({ $device: 'id' }, wide)).toBe('d1')
  })

  test('a binding may not BUILD a prototype-colliding key', () => {
    // `JSON.parse`, not an object literal: an object literal's `__proto__`
    // sets the prototype and is not an own key at all, so it would not
    // exercise the guard. A manifest read back out of SQLite arrives exactly
    // this way.
    const node: unknown = JSON.parse('{"__proto__": {"$literal": "x"}, "safe": {"$literal": "y"}}')
    const value = evaluateBinding(node as Binding, scope)
    expect(value).toEqual({ safe: 'y' })
    expect(Object.hasOwn(Object(value), '__proto__')).toBe(false)
  })
})

describe('evaluateBindingAsString', () => {
  test('a string leaf comes through; anything else is null so the caller can name the action', () => {
    expect(evaluateBindingAsString({ $row: 'username' }, scope)).toBe('alice')
    expect(evaluateBindingAsString({ $row: 'position' }, scope)).toBeNull()
    expect(evaluateBindingAsString({ $row: 'nope' }, scope)).toBeNull()
    expect(evaluateBindingAsString({ $literal: '' }, scope)).toBeNull()
  })
})
