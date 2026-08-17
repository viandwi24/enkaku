import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PluginSurfaceInput } from '@enkaku/protocol'
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

  // Plan 110 §4.2 removed `defineScript`, and `define-script.test.ts` with
  // it. These two carried over from that file: the checks they cover are
  // `definePlugin`'s own and always were (a member never went through
  // `defineScript`), but they were only ever ASSERTED there — so without them
  // the removal would have quietly cost the SDK two tests.
  test('rejects a member whose `result`, when present, is not a Zod schema', () => {
    expect(() =>
      definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a', { result: {} as never })] }),
    ).toThrow(/result/)
  })

  test('accepts a member declaring no `result` at all — an output schema is optional and always optional', () => {
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a')] })
    expect(plugin.scripts[0]?.result).toBeUndefined()
  })

  describe('the timeout/retries ⇒ runtime fold per member (plan 98 §4.2)', () => {
    test('a member declaring neither `timeout`/`retries` nor `runtime` gets no envelope at all', () => {
      const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a')] })
      expect(plugin.scripts[0]?.runtime).toBeUndefined()
    })

    test('a member\'s deprecated `timeout` folds into `runtime.timeoutMs`', () => {
      const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a', { timeout: 20_000 })] })
      expect(plugin.scripts[0]?.runtime?.timeoutMs).toBe(20_000)
    })

    test('a member\'s `runtime` object is validated and kept', () => {
      const plugin = definePlugin({
        id: 'p',
        version: '1.0.0',
        scripts: [member('a', { runtime: { maxRssBytes: 128 * 1024 * 1024 } })],
      })
      expect(plugin.scripts[0]?.runtime?.maxRssBytes).toBe(128 * 1024 * 1024)
    })

    test('two members can declare DIFFERENT runtimes independently — the fold is per member, not per plugin', () => {
      const plugin = definePlugin({
        id: 'p',
        version: '1.0.0',
        scripts: [member('a', { timeout: 5_000 }), member('b', { timeout: 9_000 })],
      })
      expect(plugin.scripts[0]?.runtime?.timeoutMs).toBe(5_000)
      expect(plugin.scripts[1]?.runtime?.timeoutMs).toBe(9_000)
    })

    test('a member\'s `timeout` and `runtime.timeoutMs` DISAGREEING throws, naming the script and both numbers, at import time', () => {
      expect(() =>
        definePlugin({ id: 'p', version: '1.0.0', scripts: [member('login', { timeout: 10_000, runtime: { timeoutMs: 20_000 } })] }),
      ).toThrow(/"login".*10000.*20000|"login".*20000.*10000/)
    })

    test('a member\'s `retries` and `runtime.retries` DISAGREEING throws', () => {
      expect(() =>
        definePlugin({ id: 'p', version: '1.0.0', scripts: [member('login', { retries: 1, runtime: { retries: 4 } })] }),
      ).toThrow(/"login"/)
    })

    // Also carried over from the deleted `define-script.test.ts`: a bound
    // violation fails loudly on the author's machine, not as a confusing 400
    // from the farm weeks later.
    test('a member\'s `runtime` below a declared floor throws at import time', () => {
      expect(() => definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a', { runtime: { timeoutMs: 500 } })] })).toThrow()
      expect(() => definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a', { runtime: { maxRssBytes: 1024 } })] })).toThrow()
    })
  })
})

// Plan 108 (M73 — plugin surface), step 108.1, §4.1: `definePlugin` runs the
// SAME `validatePluginSurface` the farm runs at verify, at import time on the
// author's own machine, so a surface that would be refused there is refused
// here first — before any network call.
describe('definePlugin — the surface (plan 108 §4.1)', () => {
  function surface(): PluginSurfaceInput {
    return {
      nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
      views: {
        accounts: {
          title: 'TikTok accounts',
          data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts' },
          table: {
            rowKey: 'username',
            columns: [
              { field: '$device.label', header: 'Device' },
              { field: 'username', header: 'Account' },
            ],
          },
          toolbar: ['sync'],
          rowActions: ['switchTo'],
        },
      },
      actions: {
        sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest' },
        switchTo: { kind: 'job', label: 'Switch', script: 'tiktok/switch-account@latest', params: { target: { $row: 'username' } } },
      },
    }
  }

  test('a plugin with no surface carries no `surface` key at all', () => {
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a')] })
    expect(plugin.surface).toBeUndefined()
    expect(Object.hasOwn(plugin, 'surface')).toBe(false)
  })

  test('a valid surface passes and is stored PARSED, with every default applied', () => {
    const plugin = definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('list-accounts')], surface: surface() })
    expect(plugin.surface?.nav[0]?.view).toBe('accounts')
    expect(plugin.surface?.views.accounts?.table?.columns[0]?.width).toBe('auto')
    expect(plugin.surface?.views.accounts?.table?.selectable).toBe(false)
    expect(plugin.surface?.views.accounts?.data).toEqual({
      kind: 'kv.scan',
      key: 'accounts',
      rows: 'items',
      itemsAt: 'accounts',
      includeMissing: true,
    })
    expect(plugin.surface?.actions.sync).toEqual({
      kind: 'batch',
      label: 'Sync accounts',
      script: 'tiktok/list-accounts@latest',
      target: 'picker',
    })
  })

  test('a nav entry naming a missing view throws, naming both', () => {
    const bad = surface()
    bad.nav = [{ id: 'accounts', label: 'Accounts', icon: 'users', view: 'ghost' }]
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })).toThrow(
      /definePlugin: surface — nav entry "accounts" names view "ghost"/,
    )
  })

  test('an action reference naming a missing action throws, naming the slot', () => {
    const bad = surface()
    const view = bad.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    view.rowActions = ['ghost']
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })).toThrow(
      /`rowActions\[0\]` names action "ghost"/,
    )
  })

  test('a duplicate nav id throws', () => {
    const bad = surface()
    bad.nav = [
      { id: 'accounts', label: 'Accounts', icon: 'users', view: 'accounts' },
      { id: 'accounts', label: 'Accounts again', icon: 'list', view: 'accounts' },
    ]
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })).toThrow(
      /duplicate nav id "accounts"/,
    )
  })

  test('an unknown icon throws, quoting it', () => {
    const bad = surface()
    bad.nav = [{ id: 'accounts', label: 'Accounts', icon: 'tiktok', view: 'accounts' } as unknown as PluginSurfaceInput['nav'][number]]
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })).toThrow(/unknown icon "tiktok"/)
  })

  test('a cap exceeded throws, naming the limit', () => {
    const bad = surface()
    const view = bad.views.accounts
    if (view?.table === undefined) throw new Error('fixture lost its table')
    view.table.columns = Array.from({ length: 13 }, (_unused, index) => ({ field: `f${index}`, header: `H${index}` }))
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })).toThrow(/maxColumns/)
  })

  test('a view declaring neither a table nor a react module throws', () => {
    const bad = surface()
    bad.views.accounts = { title: 'Accounts' }
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })).toThrow(
      /view "accounts" declares neither `table` nor `react`/,
    )
  })

  /**
   * Plan 111 §5 step 111.4 — a React view is accepted by the SAME author-time
   * gate a table is, so an author who scaffolds one (`enkaku init`) finds out
   * at import time rather than at publish. `definePlugin` deliberately does
   * NOT check `apiVersion` compatibility: that is a property of the farm doing
   * the asking, and it is refused at verify (`verify-child.ts`).
   */
  test('a react view is accepted, with a data source beside it', () => {
    const ok = surface()
    ok.views.accounts = {
      title: 'Accounts',
      data: { kind: 'kv.list', scope: 'global' },
      react: { entry: 'index.js', apiVersion: 1 },
    }
    ok.actions = {}
    expect(() => definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: ok })).not.toThrow()
  })

  test('every defect is reported in ONE throw, not one import cycle each', () => {
    const bad = surface()
    bad.nav = [
      { id: 'accounts', label: 'Accounts', icon: 'users', view: 'ghost' },
      { id: 'accounts', label: 'Accounts', icon: 'users', view: 'accounts' },
    ]
    let message = ''
    try {
      definePlugin({ id: 'tiktok', version: '1.0.0', scripts: [member('a')], surface: bad })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('names view "ghost"')
    expect(message).toContain('duplicate nav id "accounts"')
  })

  test('the surface is checked AFTER the member checks, so a broken member is still reported first', () => {
    expect(() =>
      definePlugin({ id: 'tiktok', version: 'v1', scripts: [member('a')], surface: { nav: [], views: {}, actions: {} } }),
    ).toThrow(/semver/)
  })
})

describe('isPlugin', () => {
  test('true for a definePlugin() result', () => {
    const plugin = definePlugin({ id: 'p', version: '1.0.0', scripts: [member('a')] })
    expect(isPlugin(plugin)).toBe(true)
  })

  test('false for a lone script object (has `run`, no `scripts` array)', () => {
    expect(isPlugin({ id: 'x', version: '1.0.0', params: z.object({}), run: async () => {} })).toBe(false)
  })

  test('false for null/undefined/primitives', () => {
    expect(isPlugin(null)).toBe(false)
    expect(isPlugin(undefined)).toBe(false)
    expect(isPlugin('plugin')).toBe(false)
  })
})
