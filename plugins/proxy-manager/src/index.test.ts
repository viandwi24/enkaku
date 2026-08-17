import { describe, expect, test } from 'bun:test'
import type { ActionSpec, JsonSchemaNode, PluginSurface, ViewSpec } from '@enkaku/protocol'
import { ICON_NAMES, PluginSurfaceSchema, validatePluginSurface } from '@enkaku/protocol'
import plugin, { checkScript } from './index'
import { AddFormSchema, EditFormSchema, PROXY_KEY_PREFIX, PROXY_KINDS, ProxyRecordSchema } from './record'

/**
 * The pack is deliberately blank, so almost everything worth testing is about
 * the SHAPE it declares rather than about behaviour it does not have.
 *
 * The one test that is not about the schema is the drift test
 * (`the form writes exactly the shape the columns read`): a form and a table
 * that disagree produce a screen that looks finished and shows empty cells,
 * and nothing else in the toolchain can catch it — the surface is valid, the
 * schemas are valid, the write succeeds, and the row is blank.
 */

function surfaceOf(): PluginSurface {
  const surface = plugin.surface
  if (!surface) throw new Error('the pack declares no surface — the whole point of this plugin is the screen')
  return surface
}

function viewOf(id: string): ViewSpec {
  const view = surfaceOf().views[id]
  if (!view) throw new Error(`no such view: ${id}`)
  return view
}

/** The properties of a form action's JSON Schema, in declaration order. */
function formProperties(action: ActionSpec): string[] {
  if (action.kind !== 'form') throw new Error(`action is a ${action.kind}, not a form`)
  const properties = (action.schema as JsonSchemaNode).properties
  if (properties === null || typeof properties !== 'object') throw new Error('the form schema declares no properties')
  return Object.keys(properties as Record<string, unknown>)
}

/** The keys of the object binding a `kv.set` writes as its value. */
function valueBindingKeys(action: ActionSpec): string[] {
  const terminal = action.kind === 'form' ? action.then : action
  if (terminal.kind !== 'kv.set') throw new Error(`action resolves to ${terminal.kind}, not kv.set`)
  const value = terminal.value
  if (Array.isArray(value) || typeof value !== 'object' || value === null) throw new Error('the value binding is not an object binding')
  return Object.keys(value)
}

const RECORD_FIELDS = Object.keys(ProxyRecordSchema.shape)

/** Every member the pack authors, as authored — see the title/description test for why this is not `plugin.scripts`. */
const MEMBERS = [checkScript]

describe('the plugin definition', () => {
  test('definePlugin accepted the whole thing at import time', () => {
    // `definePlugin` throws on the author's machine for an unknown icon, a nav
    // entry naming a missing view, an action reference naming a missing
    // action, a duplicate nav id, and every cap — so reaching this line at all
    // is the assertion. The identity checks below are what stops a rename from
    // silently changing the KV namespace, which is the plugin id.
    expect(plugin.id).toBe('proxy-manager')
    expect(plugin.version).toBe('0.1.0')
    expect(plugin.scripts.length).toBe(1)
  })

  test('every member carries a title and a description', () => {
    // Read off the AUTHORED members, not `plugin.scripts`: `definePlugin`
    // returns `ScriptDefinition[]`, which does not carry `title`/`description`
    // in its type at all (they are `PluginMemberScript` fields, reported
    // separately by the verify child). The id equality below is what keeps
    // this honest — a member added to `definePlugin` and not to `MEMBERS`
    // fails here rather than skipping the check.
    expect(plugin.scripts.map((s) => s.id)).toEqual(MEMBERS.map((m) => m.id))
    for (const member of MEMBERS) {
      expect(member.title).toBeTruthy()
      expect(member.description).toBeTruthy()
    }
  })

  test('the member is a real, runnable script — not a stub that throws', () => {
    expect(checkScript.id).toBe('check')
    expect(typeof checkScript.run).toBe('function')
    expect(checkScript.params).toBeDefined()
  })

  test("the member's declared result accepts exactly what its run() returns", () => {
    expect(checkScript.result?.safeParse({ proxy: 'proxy:office-uk', reachable: false }).success).toBe(true)
  })

  test('the plugin, the view and the member all say in plain words that nothing runs yet', () => {
    // The honesty requirement, asserted rather than trusted: a later edit that
    // makes the screen sound finished has to delete one of these lines to pass.
    expect(plugin.description).toMatch(/Nothing here starts, stops, tests, or routes/)
    expect(viewOf('proxies').description).toMatch(/does not connect to anything/)
    expect(viewOf('proxies').empty?.hint).toMatch(/is not built yet/)
    expect(checkScript.description).toMatch(/Does nothing yet/)
  })
})

describe('the surface', () => {
  test('parses through PluginSurfaceSchema', () => {
    const parsed = PluginSurfaceSchema.safeParse(surfaceOf())
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  test('passes the same validatePluginSurface the farm runs at verify', () => {
    const checked = validatePluginSurface(surfaceOf())
    expect(checked.ok ? [] : checked.errors).toEqual([])
  })

  test('every nav entry names a view this surface declares, with an allowlisted icon', () => {
    const surface = surfaceOf()
    expect(surface.nav.length).toBe(1)
    for (const entry of surface.nav) {
      expect(Object.keys(surface.views)).toContain(entry.view)
      expect(ICON_NAMES).toContain(entry.icon)
    }
  })

  test('every action id a view references exists in surface.actions', () => {
    const surface = surfaceOf()
    const declared = Object.keys(surface.actions)
    for (const [viewId, view] of Object.entries(surface.views)) {
      for (const id of [...view.toolbar, ...view.rowActions]) {
        expect(`${viewId}:${id}`).toBe(`${viewId}:${declared.find((d) => d === id) ?? 'MISSING'}`)
      }
    }
  })

  test('nothing declared here needs a runtime — no job or batch action, no frame', () => {
    // The claim this whole pack makes: it is functional today. Every action
    // dispatches through `KvStore`, so none of them can report
    // `script_not_found`, and no view needs a `ui/` payload.
    for (const action of Object.values(surfaceOf().actions)) {
      const terminal = action.kind === 'form' ? action.then : action
      expect(['kv.set', 'kv.delete']).toContain(terminal.kind)
    }
    for (const view of Object.values(surfaceOf().views)) {
      expect(view.frame).toBeUndefined()
    }
  })

  test('the catalogue is read from the plugin’s own GLOBAL storage, under the proxy: prefix', () => {
    // Global because a proxy catalogue is not a fact about one phone — plan
    // 108 §3.1: if forgetting the device should forget the fact, it is
    // device-scoped. Forgetting a phone must not empty this table.
    const data = viewOf('proxies').data
    expect(data).toEqual({ kind: 'kv.list', scope: 'global', prefix: PROXY_KEY_PREFIX })
  })

  test('every write is global too, so a row can never be stranded on one device', () => {
    for (const action of Object.values(surfaceOf().actions)) {
      const terminal = action.kind === 'form' ? action.then : action
      if (terminal.kind === 'kv.set' || terminal.kind === 'kv.delete') expect(terminal.scope).toBe('global')
    }
  })

  test('the destructive action confirms, and the two writes do not pretend to', () => {
    const remove = surfaceOf().actions.remove
    expect(remove?.kind).toBe('kv.delete')
    if (remove?.kind === 'kv.delete') expect(remove.confirm).toBeTruthy()
  })
})

describe('the record shape the form writes is the shape the columns read', () => {
  test('the Add form is the storage key plus every record field, in that order', () => {
    expect(formProperties(surfaceOf().actions.add as ActionSpec)).toEqual(['key', ...RECORD_FIELDS])
  })

  test('the Edit form is every record field and NOT the key — a rename is structurally impossible', () => {
    expect(formProperties(surfaceOf().actions.edit as ActionSpec)).toEqual(RECORD_FIELDS)
    expect(Object.keys(EditFormSchema.shape)).toEqual(RECORD_FIELDS)
  })

  test('both writes bind exactly the record fields — no more, no fewer', () => {
    expect(valueBindingKeys(surfaceOf().actions.add as ActionSpec)).toEqual(RECORD_FIELDS)
    expect(valueBindingKeys(surfaceOf().actions.edit as ActionSpec)).toEqual(RECORD_FIELDS)
  })

  test('every non-metadata column names a real field of the record', () => {
    const columns = viewOf('proxies').table?.columns ?? []
    const fields = columns.map((c) => c.field).filter((f) => !f.startsWith('$'))
    expect(fields).toEqual(RECORD_FIELDS)
    // And the metadata column that is left reads the entry allowlist, not the
    // value — `updatedAt` is not a stored field and must never become one.
    const metadata = columns.map((c) => c.field).filter((f) => f.startsWith('$'))
    expect(metadata).toEqual(['$entry.updatedAt'])
  })

  test('the Edit form prefills from the same field names the columns read', () => {
    const edit = surfaceOf().actions.edit
    if (edit?.kind !== 'form') throw new Error('edit is not a form action')
    const prefill = edit.prefill
    if (Array.isArray(prefill) || typeof prefill !== 'object' || prefill === null) throw new Error('prefill is not an object binding')
    expect(Object.keys(prefill)).toEqual(RECORD_FIELDS)
    for (const [field, binding] of Object.entries(prefill)) {
      expect(binding).toEqual({ $row: field })
    }
  })

  test('a record built from what the form collects parses as a ProxyRecord', () => {
    const submitted = { label: 'Office UK', kind: 'socks5', host: '10.4.0.9', port: 1080, notes: 'expires in March' }
    const parsed = ProxyRecordSchema.safeParse(submitted)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  test('the Add form accepts a submission whose key carries the prefix the list filters on', () => {
    const submitted = { key: `${PROXY_KEY_PREFIX}office-uk`, label: 'Office UK', kind: 'http', host: 'proxy.example.test', port: 8080, notes: '' }
    expect(AddFormSchema.safeParse(submitted).success).toBe(true)
    expect(submitted.key.startsWith(PROXY_KEY_PREFIX)).toBe(true)
  })

  test("the key field's own default is the prefix, and is a value the field accepts", () => {
    // A default that violates its own field would put the form in an invalid
    // state before the operator has touched anything — and since `minLength`
    // is not something the renderer enforces (see `AddFormSchema`'s note),
    // they would never be told why.
    expect(AddFormSchema.shape.key.safeParse(PROXY_KEY_PREFIX).success).toBe(true)
    expect(AddFormSchema.shape.key.parse(undefined)).toBe(PROXY_KEY_PREFIX)
  })

  test('the transport is a closed enum, so no row can hold "socks 5"', () => {
    expect(ProxyRecordSchema.shape.kind.safeParse('socks 5').success).toBe(false)
    for (const kind of PROXY_KINDS) expect(ProxyRecordSchema.shape.kind.safeParse(kind).success).toBe(true)
  })
})
