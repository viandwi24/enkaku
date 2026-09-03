import { describe, expect, test } from 'bun:test'
import plugin from './index'
import searchChannel from './search-channel'
import scrollShorts from './scroll-shorts'
import scrollLive from './scroll-live'
import downloadHome from './download-home'
import searchPlay from './search-play'

describe('youtube-automation-pack manifest', () => {
  test('identity is stable — the id is what every stored job and KV key is keyed on', () => {
    expect(plugin.id).toBe('youtube')
    expect(plugin.title).toBe('YouTube automation pack')
  })

  /** The three-site version bump `CLAUDE.md` requires: `package.json`, `src/index.ts`, and this assertion. */
  test('version matches package.json', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }
    expect(plugin.version).toBe('0.9.0')
    expect(plugin.version).toBe(pkg.version)
  })

  test('every script has a unique id and declares params and result schemas', () => {
    const ids = plugin.scripts.map((s) => s.id)
    expect(ids).toEqual(['search-channel', 'scroll-shorts', 'scroll-live', 'download-home', 'search-play'])
    expect(new Set(ids).size).toBe(ids.length)
    for (const script of plugin.scripts) {
      expect(script.params).toBeDefined()
      expect(script.result).toBeDefined()
    }
  })

  /** `Plugin.scripts: ScriptDefinition[]` erases `title`/`description` from the static type; they survive at runtime, which is how Studio shows them (plan 108 P8). */
  test('every member is presentable in Studio, checked against the real list', () => {
    const members: Array<{ id: string; title?: string; description?: string }> = [searchChannel, scrollShorts, scrollLive, downloadHome, searchPlay]
    expect(members.map((m) => m.id).sort()).toEqual(plugin.scripts.map((s) => s.id).sort())
    for (const member of members) {
      expect({ id: member.id, titled: (member.title ?? '').length > 0 }).toEqual({ id: member.id, titled: true })
      expect({ id: member.id, described: (member.description ?? '').length > 0 }).toEqual({ id: member.id, described: true })
    }
  })

  test('declares no farm permissions, because no member calls a farm capability', () => {
    expect(plugin.service).toBeUndefined()
  })
})
