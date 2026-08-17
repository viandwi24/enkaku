import { afterEach, describe, expect, test } from 'bun:test'
import { PAGE_SIZE_OPTIONS, readLocalPrefs, readSessionPrefs, TILE_SIZE_PX, writeLocalPrefs, writeSessionPrefs } from './prefs'

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
    expect(readLocalPrefs()).toEqual({ tileSize: 'l', sidebarCollapsed: false, workflowEditorView: 'list', pageSize: 24 })
    expect(localStorage.getItem('enkaku:session-prefs')).toBeNull()
  })
})

describe('readLocalPrefs / writeLocalPrefs (plan 92 §3.11, §4.9)', () => {
  // Plan 101 §5 step 101.8 (owner-specified, 2026-08-16) bumped this from
  // "m" to "l" — see prefs.ts's own comment on the `tileSize` schema field.
  test('defaults tileSize to "l" when nothing has been written yet', () => {
    expect(readLocalPrefs()).toEqual({ tileSize: 'l', sidebarCollapsed: false, workflowEditorView: 'list', pageSize: 24 })
  })

  test('round-trips a written tileSize', () => {
    writeLocalPrefs({ tileSize: 'l' })
    expect(readLocalPrefs()).toEqual({ tileSize: 'l', sidebarCollapsed: false, workflowEditorView: 'list', pageSize: 24 })
    writeLocalPrefs({ tileSize: 's' })
    expect(readLocalPrefs()).toEqual({ tileSize: 's', sidebarCollapsed: false, workflowEditorView: 'list', pageSize: 24 })
  })

  test('a corrupt stored value degrades to the schema default rather than throwing', () => {
    localStorage.setItem('enkaku:local-prefs', 'not json')
    expect(readLocalPrefs()).toEqual({ tileSize: 'l', sidebarCollapsed: false, workflowEditorView: 'list', pageSize: 24 })
  })

  test('a value that fails the schema (bad enum) degrades to the schema default', () => {
    localStorage.setItem('enkaku:local-prefs', JSON.stringify({ tileSize: 'xl' }))
    expect(readLocalPrefs()).toEqual({ tileSize: 'l', sidebarCollapsed: false, workflowEditorView: 'list', pageSize: 24 })
  })

  // Plan 101 (M66) §3.4, step 101.2 — the sidebar's collapsed state.
  test('defaults sidebarCollapsed to false, and round-trips a written value', () => {
    expect(readLocalPrefs().sidebarCollapsed).toBe(false)
    writeLocalPrefs({ sidebarCollapsed: true })
    expect(readLocalPrefs().sidebarCollapsed).toBe(true)
    writeLocalPrefs({ sidebarCollapsed: false })
    expect(readLocalPrefs().sidebarCollapsed).toBe(false)
  })

  test('writing sidebarCollapsed does not disturb an already-set tileSize, and vice versa', () => {
    writeLocalPrefs({ tileSize: 'l' })
    writeLocalPrefs({ sidebarCollapsed: true })
    expect(readLocalPrefs()).toEqual({ tileSize: 'l', sidebarCollapsed: true, workflowEditorView: 'list', pageSize: 24 })
  })

  // Plan 102 (M67) §5 step 102.6 — the workflow editor's List <-> Canvas toggle.
  test('defaults workflowEditorView to "list" (the editor of record, plan 102 §3.5), and round-trips a written value', () => {
    expect(readLocalPrefs().workflowEditorView).toBe('list')
    writeLocalPrefs({ workflowEditorView: 'canvas' })
    expect(readLocalPrefs().workflowEditorView).toBe('canvas')
    writeLocalPrefs({ workflowEditorView: 'list' })
    expect(readLocalPrefs().workflowEditorView).toBe('list')
  })

  // Plan 101 (M66) §5 step 101.7 — the devices grid's page size.
  test('defaults pageSize to 24 (the reference\'s own fixed value), and round-trips a written one', () => {
    expect(readLocalPrefs().pageSize).toBe(24)
    writeLocalPrefs({ pageSize: 96 })
    expect(readLocalPrefs().pageSize).toBe(96)
    writeLocalPrefs({ pageSize: 12 })
    expect(readLocalPrefs().pageSize).toBe(12)
  })

  test('a pageSize outside the closed set degrades to the schema default', () => {
    localStorage.setItem('enkaku:local-prefs', JSON.stringify({ pageSize: 1000 }))
    expect(readLocalPrefs().pageSize).toBe(24)
  })
})

describe('TILE_SIZE_PX (plan 92 §3.11)', () => {
  test('maps S/M/L to the 140/180/260 px minimum widths the plan specifies', () => {
    expect(TILE_SIZE_PX).toEqual({ s: 140, m: 180, l: 260 })
  })
})

describe('PAGE_SIZE_OPTIONS (plan 101 §5 step 101.7)', () => {
  test('offers 12/24/48/96, the reference\'s own 24 among them', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([12, 24, 48, 96])
  })
})
