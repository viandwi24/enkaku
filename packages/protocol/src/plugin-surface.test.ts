import { describe, expect, test } from 'bun:test'
import {
  ActionSpecSchema,
  BINDING_DEVICE_FIELDS,
  BindingSchema,
  DataSourceSchema,
  ICON_NAMES,
  IconNameSchema,
  NavEntrySchema,
  PluginSurfaceSchema,
  SURFACE_LIMITS,
  SurfaceIdSchema,
  ViewSpecSchema,
  validatePluginSurface,
  type Binding,
  type PluginSurfaceInput,
} from './plugin-surface'

/** The plan's own worked example (108 §4.3), the fixture every cross-reference test bends out of shape. */
function tiktokSurface(): PluginSurfaceInput {
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
    expect(BINDING_DEVICE_FIELDS).toEqual(['id', 'stableId', 'label', 'status', 'clusterId', 'number'])
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

  test('a frame view defaults its height', () => {
    const parsed = ViewSpecSchema.parse({ title: 'Dashboard', frame: { entry: 'index.html' } })
    expect(parsed.frame).toEqual({ entry: 'index.html', height: 'fill' })
  })

  test('refuses an empty column list and an undeclared field', () => {
    expect(ViewSpecSchema.safeParse({ title: 'x', table: { rowKey: 'k', columns: [] } }).success).toBe(false)
    expect(ViewSpecSchema.safeParse({ title: 'x', chart: { kind: 'bar' } }).success).toBe(false)
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

  test('a view declaring both a table and a frame', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    view.frame = { entry: 'index.html' }
    const errors = errorsOf(surface)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('view "accounts" declares both `table` and `frame`')
  })

  /**
   * `data` beside a `frame` is LEGAL, and deliberately so: a frame with no
   * declared source can read nothing at all (its `data.query` RPC has nothing
   * to answer from, and its CSP gives it no fetch of its own), which would
   * leave tier B able to hold only static markup. See `validatePluginSurface`'s
   * own comment for the full reasoning.
   */
  test('a frame view may declare a data source', () => {
    const surface = tiktokSurface()
    const view = surface.views.accounts
    if (view === undefined) throw new Error('fixture lost its view')
    delete view.table
    view.frame = { entry: 'index.html' }
    expect(errorsOf(surface)).toEqual([])
  })

  test('a frame view needs no data source', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts', frame: { entry: 'index.html' } }
    expect(errorsOf(surface)).toEqual([])
  })

  test('a view declaring neither renderer', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts' }
    const errors = errorsOf(surface)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('declares neither `table` nor `frame`')
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

  test('a frame view passes with no data or table', () => {
    const surface = tiktokSurface()
    surface.views.accounts = { title: 'Accounts', frame: { entry: 'index.html' } }
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
