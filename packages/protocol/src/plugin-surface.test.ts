import { describe, expect, test } from 'bun:test'
import {
  ActionSpecSchema,
  BINDING_DEVICE_FIELDS,
  BindingSchema,
  DataSourceSchema,
  ICON_NAMES,
  IconNameSchema,
  NavEntrySchema,
  PLUGIN_UI_API_VERSION,
  PluginSurfaceSchema,
  SURFACE_LIMITS,
  SurfaceIdSchema,
  ViewSpecSchema,
  handlerViewsWithoutServiceMessage,
  validatePluginSurface,
  type Binding,
  type PluginSurfaceInput,
} from './plugin-surface'

/**
 * `actions` became optional on the AUTHOR-facing input type in step 111.4 (a
 * tier-C plugin may declare none). This fixture always writes all three keys,
 * so it narrows the field back to required — every cross-reference test below
 * reaches into `surface.actions` directly, and threading an `undefined` check
 * through each one would assert nothing about the code under test.
 */
type SurfaceFixture = PluginSurfaceInput & { actions: NonNullable<PluginSurfaceInput['actions']> }

/** The plan's own worked example (108 §4.3), the fixture every cross-reference test bends out of shape. */
function tiktokSurface(): SurfaceFixture {
  return {
    nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
    views: {
      accounts: {
        title: 'TikTok accounts',
        description: 'Which accounts are signed in on each device.',
        data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: true },
        table: {
          rowKey: 'username',
          selectable: true,
          columns: [
            { field: '$device.label', header: 'Device' },
            { field: 'username', header: 'Account' },
            { field: 'position', header: 'Slot', width: 'narrow' },
            { field: 'current', header: 'Signed in', schema: { type: 'boolean' }, width: 'narrow' },
            { field: '$entry.updatedAt', header: 'Last synced', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
          ],
        },
        toolbar: ['sync'],
        rowActions: ['switchTo'],
        empty: { title: 'No accounts read yet', hint: 'Run Sync accounts.' },
      },
    },
    actions: {
      sync: { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker' },
      switchTo: {
        kind: 'job',
        label: 'Switch to this account',
        script: 'tiktok/switch-account@latest',
        device: 'row',
        params: { target: { $row: 'username' } },
        confirm: 'Switch this device to this account?',
      },
    },
  }
}

function errorsOf(surface: unknown): string[] {
  const result = validatePluginSurface(surface)
  return result.ok ? [] : result.errors
}

describe('IconNameSchema', () => {
  test('accepts every declared name', () => {
    for (const name of ICON_NAMES) expect(IconNameSchema.parse(name)).toBe(name)
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(40)
  })

  test('refuses an unknown name and quotes it', () => {
    const parsed = IconNameSchema.safeParse('rocket-ship')
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('unknown icon "rocket-ship"')
  })
})

describe('SurfaceIdSchema', () => {
  test('accepts an identifier-shaped id', () => {
    expect(SurfaceIdSchema.parse('switchTo')).toBe('switchTo')
    expect(SurfaceIdSchema.parse('list-accounts_2')).toBe('list-accounts_2')
  })

  test('refuses the prototype-colliding names and anything not identifier-shaped', () => {
    for (const id of ['__proto__', 'constructor', 'prototype', '1bad', 'has space', '', 'a'.repeat(65)]) {
      expect(SurfaceIdSchema.safeParse(id).success).toBe(false)
    }
  })
})

describe('DataSourceSchema', () => {
  test('a kv.scan applies its three defaults', () => {
    expect(DataSourceSchema.parse({ kind: 'kv.scan', key: 'accounts' })).toEqual({
      kind: 'kv.scan',
      key: 'accounts',
      rows: 'entry',
      itemsAt: '',
      includeMissing: true,
    })
  })

  test('a kv.list defaults its prefix and accepts only the global scope', () => {
    expect(DataSourceSchema.parse({ kind: 'kv.list', scope: 'global' })).toEqual({ kind: 'kv.list', scope: 'global', prefix: '' })
    expect(DataSourceSchema.safeParse({ kind: 'kv.list', scope: 'device' }).success).toBe(false)
  })

  test('refuses an unknown kind, an empty key, and an undeclared field', () => {
    expect(DataSourceSchema.safeParse({ kind: 'sql.query', key: 'x' }).success).toBe(false)
    expect(DataSourceSchema.safeParse({ kind: 'kv.scan', key: '' }).success).toBe(false)
    expect(DataSourceSchema.safeParse({ kind: 'kv.scan', key: 'x', namespace: 'other-plugin' }).success).toBe(false)
  })
})

describe('BindingSchema', () => {
  test('accepts every declared form', () => {
    expect(BindingSchema.parse({ $row: 'username' })).toEqual({ $row: 'username' })
    expect(BindingSchema.parse({ $form: 'account.name' })).toEqual({ $form: 'account.name' })
    expect(BindingSchema.parse({ $device: 'stableId' })).toEqual({ $device: 'stableId' })
    expect(BindingSchema.parse({ $entry: 'updatedAt' })).toEqual({ $entry: 'updatedAt' })
    expect(BindingSchema.parse({ $literal: 42 })).toEqual({ $literal: 42 })
    expect(BindingSchema.parse({ $literal: null })).toEqual({ $literal: null })
    expect(BindingSchema.parse({ target: { $row: 'username' } })).toEqual({ target: { $row: 'username' } })
    expect(BindingSchema.parse([{ $row: 'a' }, { $literal: 'b' }])).toEqual([{ $row: 'a' }, { $literal: 'b' }])
  })

  test('an array binding stays an array, never a map keyed by index', () => {
    const parsed = BindingSchema.parse([{ $literal: 1 }])
    expect(Array.isArray(parsed)).toBe(true)
  })

  test('handles nesting to arbitrary depth', () => {
    const nested: Binding = { a: { b: { c: [{ $device: 'label' }, { d: { $literal: { deep: true } } }] } } }
    expect(BindingSchema.parse(nested)).toEqual(nested)
  })

  test('refuses an unknown key beside a marker', () => {
    expect(BindingSchema.safeParse({ $row: 'a', $form: 'b' }).success).toBe(false)
    expect(BindingSchema.safeParse({ $row: 'a', extra: 1 }).success).toBe(false)
  })

  /**
   * The device NUMBER is the sixth allowlisted field (plan 108 §3.6, extended
   * on the owner's ruling that a plugin screen shows Device ID, Device Number
   * and Device Name together). Asserted beside the refusal below on purpose:
   * widening an allowlist is only safe while the refusal it widened still
   * refuses everything else.
   */
  test('accepts $device: "number", the sixth allowlisted field', () => {
    expect(BindingSchema.parse({ $device: 'number' })).toEqual({ $device: 'number' })
    expect(BINDING_DEVICE_FIELDS).toEqual(['id', 'stableId', 'label', 'status', 'groupId', 'number'])
  })

  test('refuses an undeclared device or entry field', () => {
    expect(BindingSchema.safeParse({ $device: 'serial' }).success).toBe(false)
    expect(BindingSchema.safeParse({ $entry: 'value' }).success).toBe(false)
    // Near-misses of the newest field, so widening the allowlist widened it by exactly one name.
    expect(BindingSchema.safeParse({ $device: 'deviceNumber' }).success).toBe(false)
    expect(BindingSchema.safeParse({ $device: 'Number' }).success).toBe(false)
  })

  test('refuses a bare literal — a literal must say `$literal`', () => {
    expect(BindingSchema.safeParse('username').success).toBe(false)
    expect(BindingSchema.safeParse(7).success).toBe(false)
    expect(BindingSchema.safeParse(null).success).toBe(false)
  })

  test('refuses an operator, a call, or an interpolation', () => {
    expect(BindingSchema.safeParse({ $concat: [{ $row: 'a' }, { $row: 'b' }] }).success).toBe(false)
    expect(BindingSchema.safeParse({ $if: { $row: 'a' } }).success).toBe(false)
    expect(BindingSchema.safeParse({ $row: 'a', $default: 'x' }).success).toBe(false)
  })

  test('never lets a prototype member through as an object binding key', () => {
    // `constructor`/`prototype` are refused outright by the key schema;
    // `__proto__` never reaches it, because Zod itself drops that key —
    // either way nothing downstream can be handed one.
    expect(BindingSchema.safeParse({ constructor: { $literal: 1 } }).success).toBe(false)
    expect(BindingSchema.safeParse({ prototype: { $literal: 1 } }).success).toBe(false)
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, '__proto__', { value: { $literal: 1 }, enumerable: true, configurable: true })
    const parsed = BindingSchema.safeParse(hostile)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('expected the hostile key to be dropped, not refused')
    expect(Object.hasOwn(parsed.data, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype)
  })
})

describe('ActionSpecSchema', () => {
  test('a job action defaults `device` to the row', () => {
    expect(ActionSpecSchema.parse({ kind: 'job', label: 'Run', script: 'tiktok/login@latest' })).toEqual({
      kind: 'job',
      label: 'Run',
      script: 'tiktok/login@latest',
      device: 'row',
    })
  })

  test('a batch action defaults `target` to the picker', () => {
    const parsed = ActionSpecSchema.parse({ kind: 'batch', label: 'Sync', script: 'tiktok/list-accounts@1.0.0' })
    expect(parsed).toEqual({ kind: 'batch', label: 'Sync', script: 'tiktok/list-accounts@1.0.0', target: 'picker' })
  })

  test('kv.set defaults `secret` to false; kv.delete takes a confirm', () => {
    expect(
      ActionSpecSchema.parse({ kind: 'kv.set', label: 'Save', scope: 'global', key: { $literal: 'k' }, value: { $form: 'v' } }),
    ).toEqual({ kind: 'kv.set', label: 'Save', scope: 'global', key: { $literal: 'k' }, value: { $form: 'v' }, secret: false })
    expect(
      ActionSpecSchema.parse({ kind: 'kv.delete', label: 'Delete', scope: 'device', key: { $row: 'key' }, confirm: 'Sure?' }),
    ).toEqual({ kind: 'kv.delete', label: 'Delete', scope: 'device', key: { $row: 'key' }, confirm: 'Sure?' })
  })

  test('a form action nests another action in `then` and defaults its submit label', () => {
    const parsed = ActionSpecSchema.parse({
      kind: 'form',
      label: 'Add account',
      schema: { type: 'object', properties: { username: { type: 'string' } } },
      then: { kind: 'kv.set', label: 'Save', scope: 'global', key: { $form: 'username' }, value: { $form: 'username' } },
    })
    expect(parsed).toEqual({
      kind: 'form',
      label: 'Add account',
      schema: { type: 'object', properties: { username: { type: 'string' } } },
      submitLabel: 'Save',
      then: { kind: 'kv.set', label: 'Save', scope: 'global', key: { $form: 'username' }, value: { $form: 'username' }, secret: false },
    })
  })

  test('refuses an unknown kind, a malformed script ref, and an undeclared field', () => {
    expect(ActionSpecSchema.safeParse({ kind: 'http', label: 'Call', url: 'https://x' }).success).toBe(false)
    expect(ActionSpecSchema.safeParse({ kind: 'job', label: 'Run', script: 'tiktok/login' }).success).toBe(false)
    expect(ActionSpecSchema.safeParse({ kind: 'job', label: 'Run', script: 'tiktok/login@latest', shell: 'rm -rf /' }).success).toBe(false)
  })

  test('refuses a binding that is not one', () => {
    expect(ActionSpecSchema.safeParse({ kind: 'job', label: 'Run', script: 'a@latest', params: { t: 'raw string' } }).success).toBe(false)
  })
})

describe('ViewSpecSchema', () => {
  test('defaults the toolbar, the row actions, the column width, and selectable', () => {
    const parsed = ViewSpecSchema.parse({
      title: 'Accounts',
      data: { kind: 'kv.list', scope: 'global' },
      table: { rowKey: 'key', columns: [{ field: 'key', header: 'Key' }] },
    })
    expect(parsed.toolbar).toEqual([])
    expect(parsed.rowActions).toEqual([])
    expect(parsed.table?.selectable).toBe(false)
    expect(parsed.table?.columns[0]?.width).toBe('auto')
  })

  test('refuses an empty column list and an undeclared field', () => {
    expect(ViewSpecSchema.safeParse({ title: 'x', table: { rowKey: 'k', columns: [] } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', chart: { kind: 'bar' } }).success).toBe(false)
  })
})

/**
 * Tier C (plan 111 §4.1, §5 step 111.4). `react` replaced plan 108's `frame`
 * outright — 00-overview §4.3, removed and not deprecated — so the last test
 * here is as load-bearing as the others: it is what would fail if a
 * compatibility alias were ever quietly added back.
 */
describe('ViewSpecSchema — the `react` renderer', () => {
  test('a react view parses, keeping both fields exactly as written', () => {
    const parsed = ViewSpecSchema.parse({ title: 'Catalogue', react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION } })
    expect(parsed.react).toEqual({ entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION })
    expect(parsed.table).toBeUndefined()
    // The two list defaults still apply to a React view — a plugin may put its
    // own component beside a declared toolbar action.
    expect(parsed.toolbar).toEqual([])
    expect(parsed.rowActions).toEqual([])
  })

  test('`apiVersion` is required, and is an integer in range — no default guesses it', () => {
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js' } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js', apiVersion: 0 } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js', apiVersion: 1.5 } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js', apiVersion: 1000 } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js', apiVersion: '1' } }).success).toBe(false)
  })

  test('`entry` must be a non-empty path, and nothing else may ride along', () => {
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: '', apiVersion: 1 } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js', apiVersion: 1, height: 'fill' } }).success).toBe(false)
  })

  /**
   * The exact shape `enkaku init` scaffolds (`packages/sdk/src/cli/init.ts`)
   * and the exact shape `publish.test.ts`'s `REACT_SURFACE_SUPPORTED` probe
   * asks about: one nav entry, one React view, and NO `actions` key at all. A
   * tier-C plugin calls `fetch` itself, so it may legitimately declare none.
   */
  test('a whole surface may be one React view with no actions declared', () => {
    const result = validatePluginSurface({
      nav: [{ id: 'main', label: 'Main', icon: 'puzzle', view: 'main' }],
      views: { main: { title: 'Main', react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION } } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.join('; '))
    // Defaulted at PARSE, so every consumer still reads a present record.
    expect(result.value.actions).toEqual({})
  })

  test('`frame` no longer parses at all — tier B was removed, not aliased', () => {
    expect(ViewSpecSchema.safeParse({ title: 'Dashboard', frame: { entry: 'index.html' } }).success).toBe(false)
    // And a view naming BOTH the old and the new member is still refused by the
    // same `.strict()`, so no manifest can straddle the two.
    expect(ViewSpecSchema.safeParse({ title: 'x', react: { entry: 'index.js', apiVersion: 1 }, frame: { entry: 'index.html' } }).success).toBe(false)
  })
})

describe('NavEntrySchema', () => {
  test('accepts a well-formed entry and refuses an unknown icon', () => {
    expect(NavEntrySchema.parse({ id: 'accounts', label: 'Accounts', icon: 'users', view: 'accounts' })).toEqual({
      id: 'accounts',
      label: 'Accounts',
      icon: 'users',
      view: 'accounts',
    })
    expect(NavEntrySchema.safeParse({ id: 'accounts', label: 'Accounts', icon: 'tiktok', view: 'accounts' }).success).toBe(false)
  })
})

describe('the caps, each naming its own limit', () => {
  test('maxNav', () => {
    const surface = tiktokSurface()
    surface.nav = Array.from({ length: SURFACE_LIMITS.maxNav + 1 }, (_unused, index) => ({
      id: `n${index}`,
      label: `Entry ${index}`,
      icon: 'users' as const,
      view: 'accounts',
    }))
    const errors = errorsOf(surface)
    expect(errors.join(' ')).toContain('maxNav')
    expect(errors.join(' ')).toContain(String(SURFACE_LIMITS.maxNav))
  })

  test('maxViews', () => {
    const surface = tiktokSurface()
    const base = surface.views.accounts
    if (base === undefined) throw new Error('fixture lost its view')
    for (let index = 0; index < SURFACE_LIMITS.maxViews; index++) surface.views[`extra${index}`] = base
    const errors = errorsOf(surface)
    expect(errors.join(' ')).toContain('maxViews')
    expect(errors.join(' ')).toContain(String(SURFACE_LIMITS.maxViews))
  })

  test('maxActions', () => {
    const surface = tiktokSurface()
    const base = surface.actions.sync
    if (base === undefined) throw new Error('fixture lost its action')
    for (let index = 0; index < SURFACE_LIMITS.maxActions; index++) surface.actions[`extra${index}`] = base
    const errors = errorsOf(surface)
    expect(errors.join(' ')).toContain('maxActions')
    expect(errors.join(' ')).toContain(String(SURFACE_LIMITS.maxActions))
  })

  test('maxColumns', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view?.table === undefined) throw new Error('fixture lost its table')
    view.table.columns = Array.from({ length: SURFACE_LIMITS.maxColumns + 1 }, (_unused, index) => ({
      field: `f${index}`,
      header: `H${index}`,
    }))
    const errors = errorsOf(surface)
    expect(errors.join(' ')).toContain('maxColumns')
    expect(errors.join(' ')).toContain(String(SURFACE_LIMITS.maxColumns))
  })

  test('maxSurfaceBytes', () => {
    const surface = tiktokSurface()
    surface.actions.bloat = {
      kind: 'kv.set',
      label: 'Bloat',
      scope: 'global',
      key: { $literal: 'k' },
      value: { $literal: 'y'.repeat(SURFACE_LIMITS.maxSurfaceBytes + 1) },
    }
    surface.views.accounts?.toolbar?.push('bloat')
    const errors = errorsOf(surface)
    expect(errors.join(' ')).toContain('maxSurfaceBytes')
    expect(errors.join(' ')).toContain(String(SURFACE_LIMITS.maxSurfaceBytes))
  })

  test('a surface at the limits still passes', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view?.table === undefined) throw new Error('fixture lost its table')
    view.table.columns = Array.from({ length: SURFACE_LIMITS.maxColumns }, (_unused, index) => ({
      field: `f${index}`,
      header: `H${index}`,
    }))
    expect(validatePluginSurface(surface).ok).toBe(true)
  })
})

describe('PluginSurfaceSchema', () => {
  test('parses the plan’s worked example and applies every default', () => {
    const parsed = PluginSurfaceSchema.parse(tiktokSurface())
    expect(parsed.views.accounts?.table?.columns[0]?.width).toBe('auto')
    expect(parsed.views.accounts?.data).toEqual({ kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: true })
    expect(parsed.actions.sync).toEqual({ kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker' })
  })

  test('refuses an undeclared top-level key and a non-identifier view id', () => {
    expect(PluginSurfaceSchema.safeParse({ ...tiktokSurface(), routes: [] }).success).toBe(false)
    const badId = tiktokSurface()
    const view = badId.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    badId.views['not an id'] = view
    expect(PluginSurfaceSchema.safeParse(badId).success).toBe(false)
  })

  test('refuses a view or action id that collides with `Object.prototype`', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    Object.defineProperty(surface.views, 'constructor', { value: view, enumerable: true, configurable: true })
    expect(PluginSurfaceSchema.safeParse(surface).success).toBe(false)
  })
})

describe('validatePluginSurface — the four cross-reference failures', () => {
  test('a nav entry naming a missing view', () => {
    const surface = tiktokSurface()
    surface.nav = [{ id: 'accounts', label: 'Accounts', icon: 'users', view: 'ghost' }]
    const errors = errorsOf(surface)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('nav entry "accounts" names view "ghost", which this surface does not declare')
  })

  test('a toolbar or row action naming a missing action', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    view.toolbar = ['ghostToolbar']
    view.rowActions = ['ghostRow']
    const errors = errorsOf(surface)
    expect(errors).toEqual([
      'view "accounts" `toolbar[0]` names action "ghostToolbar", which this surface does not declare',
      'view "accounts" `rowActions[0]` names action "ghostRow", which this surface does not declare',
    ])
  })

  test('a duplicate nav id', () => {
    const surface = tiktokSurface()
    surface.nav = [
      { id: 'accounts', label: 'Accounts', icon: 'users', view: 'accounts' },
      { id: 'accounts', label: 'Accounts again', icon: 'list', view: 'accounts' },
    ]
    expect(errorsOf(surface)).toEqual(['duplicate nav id "accounts" — nav ids must be unique within one surface'])
  })

  test('a view declaring both a table and a react module', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    view.react = { entry: 'index.js', apiVersion: 1 }
    const errors = errorsOf(surface)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('view "accounts" declares both `table` and `react` — a view has one renderer, never two')
  })

  /**
   * `data` beside `react` is LEGAL, and deliberately so — plan 108 §9 Q4's
   * correction, carried over verbatim by plan 111 §3.4: a React view may
   * declare a source and read it through `/api/plugins/:name/data/*`, exactly
   * as a table does. See `validatePluginSurface`'s own comment.
   */
  test('a react view may declare a data source', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    delete view.table
    view.react = { entry: 'index.js', apiVersion: 1 }
    expect(errorsOf(surface)).toEqual([])
  })

  test('a react view needs no data source', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts', react: { entry: 'index.js', apiVersion: 1 } }
    expect(errorsOf(surface)).toEqual([])
  })

  test('a view declaring neither renderer', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts' }
    const errors = errorsOf(surface)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('view "accounts" declares neither `table` nor `react` — a view needs one renderer')
  })

  test('a table view missing only its data source', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    delete view.data
    expect(errorsOf(surface)).toEqual([
      'view "accounts" declares `table` but no `data` — a table view needs both',
    ])
  })

  test('a react view passes with no data and no table', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts', react: { entry: 'index.js', apiVersion: 1 } }
    surface.actions = {}
    expect(validatePluginSurface(surface).ok).toBe(true)
  })

  /**
   * The compatibility half of `react.apiVersion` is NOT checked here — a
   * surface built against a different `@enkaku/ui` major is well formed, and
   * whether this build can run it is the verify parent's question
   * (`packages/core/src/plugins/verify-child.ts`, which is where the refusal
   * and its test live). Asserting that here is what keeps the two halves from
   * drifting into checking it twice, differently.
   */
  test('a react view built against another @enkaku/ui major is still a VALID surface', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts', react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION + 1 } }
    surface.actions = {}
    expect(validatePluginSurface(surface).ok).toBe(true)
  })

  test('reports every Zod issue as a readable, path-prefixed sentence', () => {
    const result = validatePluginSurface({ nav: [{ id: 'a', label: 'A', icon: 'tiktok', view: 'v' }], views: {}, actions: {} })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.errors[0]).toContain('nav.0.icon: ')
    expect(result.errors[0]).toContain('unknown icon "tiktok"')
  })

  test('refuses a non-object outright, and reports rather than throws', () => {
    for (const value of [null, undefined, 'surface', 7, []]) {
      expect(validatePluginSurface(value).ok).toBe(false)
    }
  })

  test('the happy path returns the PARSED value, not the input', () => {
    const result = validatePluginSurface(tiktokSurface())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.value.views.accounts?.table?.columns[0]?.width).toBe('auto')
  })
})

/**
 * Plan 109 §4.6, step 109.6 — the third data source, and the one cross-check
 * between a surface and a service.
 */
describe('{ kind: "handler" } — rows the plugin`s own code assembles (plan 109 §4.6)', () => {
  test('parses, and carries no `input` member for a caller to smuggle one through', () => {
    expect(DataSourceSchema.parse({ kind: 'handler', name: 'status' })).toEqual({ kind: 'handler', name: 'status' })
    // `.strict()`: a declarative view has nowhere to get an input FROM, so a
    // field for one would only ever hold a literal the handler could write.
    expect(DataSourceSchema.safeParse({ kind: 'handler', name: 'status', input: { a: 1 } }).success).toBe(false)
    // The id shape is `SurfaceIdSchema`'s, so a path segment cannot be smuggled
    // into the handler name either.
    expect(DataSourceSchema.safeParse({ kind: 'handler', name: 'a/b' }).success).toBe(false)
  })

  test('a surface that names a handler source with NO service is refused, naming the views', () => {
    const surface = tiktokSurface()
    surface.views.accounts!.data = { kind: 'handler', name: 'status' }
    const parsed = PluginSurfaceSchema.parse(surface)

    const message = handlerViewsWithoutServiceMessage(parsed, false)
    expect(message).toContain('"accounts"')
    expect(message).toContain('ctx.onQuery')
    expect(message).toContain('service')

    // Control 1: the SAME surface with a service is accepted — so the refusal
    // is about the missing service and not about the data source itself.
    expect(handlerViewsWithoutServiceMessage(parsed, true)).toBeNull()
  })

  test('control: a surface with no handler source is never refused, service or not', () => {
    // The fixture's own `kv.scan` view. Without this, the check above could be
    // refusing every serviceless plugin on the farm and still look correct.
    const parsed = PluginSurfaceSchema.parse(tiktokSurface())
    expect(handlerViewsWithoutServiceMessage(parsed, false)).toBeNull()
    expect(handlerViewsWithoutServiceMessage(parsed, true)).toBeNull()
  })
})
