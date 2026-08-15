import { afterEach, describe, expect, test } from 'bun:test'
import { readLocalPrefs, readSessionPrefs, TILE_SIZE_PX, writeLocalPrefs, writeSessionPrefs } from './prefs'

/**
 * happy-dom's `sessionStorage`/`localStorage` are registered once for the
 * whole test file (`packages/studio/happydom.ts`) and do not reset between
 * individual `test()`s the way `cleanup()` resets the DOM — so every test
 * here clears both explicitly, the same discipline `app/page.test.tsx`
 * applies for the same reason (its own `afterEach`).
 */
afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('readSessionPrefs / writeSessionPrefs (plan 92 §3.10, §4.9)', () => {
  test('reads {} when nothing has been written yet', () => {
    expect(readSessionPrefs()).toEqual({})
  })

  test('round-trips a written view', () => {
    writeSessionPrefs({ view: 'list' })
    expect(readSessionPrefs()).toEqual({ view: 'list' })
    writeSessionPrefs({ view: 'wall' })
    expect(readSessionPrefs()).toEqual({ view: 'wall' })
  })

  test('a corrupt stored value degrades to {} rather than throwing', () => {
    sessionStorage.setItem('enkaku:session-prefs', 'not json')
    expect(readSessionPrefs()).toEqual({})
  })

  test('a value that fails the schema (bad enum) degrades to {} rather than throwing', () => {
    sessionStorage.setItem('enkaku:session-prefs', JSON.stringify({ view: 'topology' }))
    expect(readSessionPrefs()).toEqual({})
  })

  test('a storage access failure (private browsing) is swallowed, never thrown into the caller', () => {
    const originalGet = sessionStorage.getItem.bind(sessionStorage)
    const originalSet = sessionStorage.setItem.bind(sessionStorage)
    sessionStorage.getItem = () => {
      throw new Error('SecurityError: storage disabled')
    }
    sessionStorage.setItem = () => {
      throw new Error('SecurityError: storage disabled')
    }
    try {
      expect(readSessionPrefs()).toEqual({})
      expect(() => writeSessionPrefs({ view: 'wall' })).not.toThrow()
    } finally {
      sessionStorage.getItem = originalGet
      sessionStorage.setItem = originalSet
    }
  })

  test('sessionStorage and localStorage are genuinely separate backends', () => {
    writeSessionPrefs({ view: 'list' })
    expect(readLocalPrefs()).toEqual({ tileSize: 'm' })
    expect(localStorage.getItem('enkaku:session-prefs')).toBeNull()
  })
})

describe('readLocalPrefs / writeLocalPrefs (plan 92 §3.11, §4.9)', () => {
  test('defaults tileSize to "m" when nothing has been written yet', () => {
    expect(readLocalPrefs()).toEqual({ tileSize: 'm' })
  })

  test('round-trips a written tileSize', () => {
    writeLocalPrefs({ tileSize: 'l' })
    expect(readLocalPrefs()).toEqual({ tileSize: 'l' })
    writeLocalPrefs({ tileSize: 's' })
    expect(readLocalPrefs()).toEqual({ tileSize: 's' })
  })

  test('a corrupt stored value degrades to the schema default rather than throwing', () => {
    localStorage.setItem('enkaku:local-prefs', 'not json')
    expect(readLocalPrefs()).toEqual({ tileSize: 'm' })
  })

  test('a value that fails the schema (bad enum) degrades to the schema default', () => {
    localStorage.setItem('enkaku:local-prefs', JSON.stringify({ tileSize: 'xl' }))
    expect(readLocalPrefs()).toEqual({ tileSize: 'm' })
  })
})

describe('TILE_SIZE_PX (plan 92 §3.11)', () => {
  test('maps S/M/L to the 140/180/260 px minimum widths the plan specifies', () => {
    expect(TILE_SIZE_PX).toEqual({ s: 140, m: 180, l: 260 })
  })
})
