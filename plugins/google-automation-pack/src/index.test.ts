import { describe, expect, test } from 'bun:test'
import plugin from './index'
import snapshotAccounts from './snapshot-accounts'
import openRegister from './open-register'

describe('google-automation-pack manifest', () => {
  test('identity is stable — the id is what every stored assignment and KV key is keyed on', () => {
    expect(plugin.id).toBe('google')
    expect(plugin.title).toBe('Google automation pack')
  })

  /**
   * The three-site version bump this repo requires (`CLAUDE.md`): `package.json`,
   * `src/index.ts`, and this assertion. It exists so a `build:packs` at an
   * unchanged version — which `seedEmbeddedPacks` skips silently on every farm
   * that has already booted once — fails here first, loudly, in CI.
   */
  test('version matches package.json', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }
    expect(plugin.version).toBe('0.2.0')
    expect(plugin.version).toBe(pkg.version)
  })

  test('every script has a unique id, and each declares params and result schemas', () => {
    const ids = plugin.scripts.map((s) => s.id)
    expect(ids).toEqual(['snapshot-accounts', 'open-register'])
    expect(new Set(ids).size).toBe(ids.length)
    for (const script of plugin.scripts) {
      expect(script.params).toBeDefined()
      expect(script.result).toBeDefined()
    }
  })

  /**
   * `Plugin.scripts: ScriptDefinition[]` erases `title`/`description` from the
   * STATIC type — they survive at runtime, which is why Studio can show them
   * (plan 108 P8). So the members are spelled out here and checked against
   * `plugin.scripts`, the same trade `tiktok-automation-pack`'s own test makes.
   * The first assertion is what keeps the two lists in step as members are
   * added.
   */
  test('every member is presentable in Studio — a title and a description, checked against the real list', () => {
    const members: Array<{ id: string; title?: string; description?: string }> = [snapshotAccounts, openRegister]
    expect(members.map((m) => m.id).sort()).toEqual(plugin.scripts.map((s) => s.id).sort())
    for (const member of members) {
      expect({ id: member.id, titled: (member.title ?? '').length > 0 }).toEqual({ id: member.id, titled: true })
      expect({ id: member.id, described: (member.description ?? '').length > 0 }).toEqual({ id: member.id, described: true })
    }
  })

  /**
   * A permission an operator is shown at install must be one this pack actually
   * uses (plan 113 §3.7): the list is consent, not a wish. Neither member
   * calls `ctx.farm`, so the honest list is still no list at all — and this test is
   * what makes adding one a deliberate act rather than a copy-paste from
   * another pack.
   */
  test('declares no farm permissions, because no member calls a farm capability yet', () => {
    expect(plugin.service).toBeUndefined()
  })
})
