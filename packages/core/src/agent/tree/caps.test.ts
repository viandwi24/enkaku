import { describe, expect, test } from 'bun:test'
import { checkDepthCap, checkTreeSizeCap, DEFAULT_MAX_RUNS_PER_TREE, DEFAULT_MAX_TREE_DEPTH, treeTokenBudgetExhausted } from './caps'
import { EnkakuError } from '../../util/errors'

/** Plan 67 §3.6, §7 — each cap at its boundary, and every one failing closed. */

describe('checkDepthCap (plan 67 §3.6)', () => {
  test('spawning from depth 1 (root) to depth 2 is allowed under the default cap of 3', () => {
    expect(() => checkDepthCap(1)).not.toThrow()
  })
  test('spawning from depth 2 to depth 3 is allowed', () => {
    expect(() => checkDepthCap(2)).not.toThrow()
  })
  test('spawning from depth 3 to depth 4 is refused — exactly at the boundary', () => {
    expect(() => checkDepthCap(3)).toThrow(EnkakuError)
    try {
      checkDepthCap(3)
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_DEPTH_LIMIT')
    }
  })
  test('a custom, smaller depth cap is honoured', () => {
    expect(() => checkDepthCap(1, 1)).toThrow(EnkakuError)
  })
  test('the default constant is 3', () => {
    expect(DEFAULT_MAX_TREE_DEPTH).toBe(3)
  })
})

describe('checkTreeSizeCap (plan 67 §3.6)', () => {
  test('below the cap is allowed', () => {
    expect(() => checkTreeSizeCap(24)).not.toThrow()
  })
  test('at the cap is refused — exactly at the boundary', () => {
    expect(() => checkTreeSizeCap(25)).toThrow(EnkakuError)
    try {
      checkTreeSizeCap(25)
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_TREE_SIZE_LIMIT')
    }
  })
  test('over the cap (e.g. a race left it briefly over) is still refused', () => {
    expect(() => checkTreeSizeCap(26)).toThrow(EnkakuError)
  })
  test('the default constant is 25', () => {
    expect(DEFAULT_MAX_RUNS_PER_TREE).toBe(25)
  })
})

describe('treeTokenBudgetExhausted (plan 67 §3.6)', () => {
  test('under budget is not exhausted', () => {
    expect(treeTokenBudgetExhausted(999, 1000)).toBe(false)
  })
  test('exactly at budget IS exhausted — fails closed at the boundary, not past it', () => {
    expect(treeTokenBudgetExhausted(1000, 1000)).toBe(true)
  })
  test('over budget is exhausted', () => {
    expect(treeTokenBudgetExhausted(1001, 1000)).toBe(true)
  })
  test('a shared budget consumed by three children sums correctly — 3×400 against a 1000 cap is not yet exhausted, +300 more is', () => {
    let spent = 400 + 400
    expect(treeTokenBudgetExhausted(spent, 1000)).toBe(false)
    spent += 300 // three children have now spent 1100 combined
    expect(treeTokenBudgetExhausted(spent, 1000)).toBe(true)
  })
})
