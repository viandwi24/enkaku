import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { definePlugin, isPlugin, type PluginMemberScript } from './plugin'

function member(id: string, extra?: Partial<PluginMemberScript>): PluginMemberScript {
  return { id, params: z.object({}), run: async () => 'ok', ...extra }
}

describe('definePlugin', () => {
  test('publishes many scripts, each stamped with the plugin version', () => {
    const plugin = definePlugin({
      id: 'tiktok',
      version: '1.0.0',
      scripts: [member('login'), member('switch-account'), member('warmup')],
    })
    expect(plugin.scripts).toHaveLength(3)
    for (const s of plugin.scripts) expect(s.version).toBe('1.0.0')
    expect(plugin.scripts.map((s) => s.id)).toEqual(['login', 'switch-account', 'warmup'])
  })

  test('freezes the plugin and its scripts', () => {
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a')] })
    expect(Object.isFrozen(plugin)).toBe(true)
    expect(Object.isFrozen(plugin.scripts[0])).toBe(true)
  })

  test('rejects a bad id shape', () => {
    expect(() => definePlugin({ id: 'TikTok', version: '1.0.0', scripts: [member('a')] })).toThrow(/id/)
    expect(() => definePlugin({ id: '-bad', version: '1.0.0', scripts: [member('a')] })).toThrow(/id/)
  })

  test('rejects a non-semver version', () => {
    expect(() => definePlugin({ id: 'p', version: 'v1', scripts: [member('a')] })).toThrow(/semver/)
  })

  test('rejects an empty scripts array', () => {
    expect(() => definePlugin({ id: 'p', version: '1.0.0', scripts: [] })).toThrow(/non-empty/)
  })

  test('rejects duplicate script ids, naming it (criterion 22)', () => {
    expect(() => definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a'), member('a')] })).toThrow(/duplicate script id "a"/)
  })

  test('rejects a member whose declared version diverges from the plugin (criterion 10)', () => {
    expect(() =>
      definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a', { version: '2.0.0' })] }),
    ).toThrow(/does not match the plugin's own/)
  })

  test('accepts a member whose declared version matches the plugin exactly', () => {
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a', { version: '1.0.0' })] })
    expect(plugin.scripts[0]?.version).toBe('1.0.0')
  })

  test('rejects a member missing `run`', () => {
    expect(() =>
      definePlugin({ id: 'p', version: '1.0.0', scripts: [{ id: 'a', params: z.object({}) } as unknown as PluginMemberScript] }),
    ).toThrow(/run/)
  })

  test('rejects a member missing a Zod `params`', () => {
    expect(() =>
      definePlugin({ id: 'p', version: '1.0.0', scripts: [{ id: 'a', params: {} as never, run: async () => {} }] }),
    ).toThrow(/params/)
  })
})

describe('isPlugin', () => {
  test('true for a definePlugin() result', () => {
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a')] })
    expect(isPlugin(plugin)).toBe(true)
  })

  test('false for a standalone ScriptDefinition (has `run`, no `scripts` array)', () => {
    expect(isPlugin({ id: 'x', version: '1.0.0', params: z.object({}), run: async () => {} })).toBe(false)
  })

  test('false for null/undefined/primitives', () => {
    expect(isPlugin(null)).toBe(false)
    expect(isPlugin(undefined)).toBe(false)
    expect(isPlugin('plugin')).toBe(false)
  })
})
