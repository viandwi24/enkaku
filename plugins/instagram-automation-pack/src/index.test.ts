import { describe, expect, test } from 'bun:test'
import plugin from './index'
import scrollReels from './scroll-reels'
import checkInbox from './check-inbox'
import checkActivity from './check-activity'
import checkProfile from './check-profile'
import searchKeyword from './search-keyword'
import { keywordBoost } from './behavior'

describe('instagram-automation-pack manifest', () => {
  test('identity is stable', () => {
    expect(plugin.id).toBe('instagram')
    expect(plugin.title).toBe('Instagram automation pack')
  })

  /** The three-site version bump: `package.json`, `src/index.ts`, and this assertion. */
  test('version matches package.json', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }
    expect(plugin.version).toBe('0.1.1')
    expect(plugin.version).toBe(pkg.version)
  })

  test('every script has a unique id and declares params and result schemas', () => {
    const ids = plugin.scripts.map((s) => s.id)
    expect(ids).toEqual(['scroll-reels', 'check-inbox', 'check-activity', 'check-profile', 'search-keyword'])
    expect(new Set(ids).size).toBe(ids.length)
    for (const script of plugin.scripts) {
      expect(script.params).toBeDefined()
      expect(script.result).toBeDefined()
    }
  })

  test('every member is presentable in Studio', () => {
    const members = [scrollReels, checkInbox, checkActivity, checkProfile, searchKeyword]
    expect(members.map((m) => m.id).sort()).toEqual(plugin.scripts.map((s) => s.id).sort())
    for (const member of members) {
      expect((member.title ?? '').length).toBeGreaterThan(0)
      expect((member.description ?? '').length).toBeGreaterThan(0)
    }
  })
})

describe('keyword tilt', () => {
  test('a matching keyword multiplies the base chance, capped at 1', () => {
    expect(keywordBoost('Jual Emas Murah Hari Ini', ['emas'], 0.2, 3)).toBeCloseTo(0.6)
    expect(keywordBoost('gold price today', ['gold', 'emas'], 0.3, 4)).toBe(1)
  })

  test('no match keeps the base untouched — tilt never punishes', () => {
    expect(keywordBoost('resep nasi goreng', ['emas'], 0.2, 3)).toBe(0.2)
  })

  test('empty keywords or zero base return the base', () => {
    expect(keywordBoost('anything', [], 0.2, 3)).toBe(0.2)
    expect(keywordBoost('anything', ['x'], 0, 3)).toBe(0)
  })
})
