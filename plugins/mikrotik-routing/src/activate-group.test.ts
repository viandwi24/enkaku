import { describe, expect, test } from 'bun:test'
import type { ScriptContext } from '@enkaku/sdk'
import activateGroupScript from './activate-group'
import { groupKeyFor, writeGroup, type Group } from './service/groups'

type ActivateGroupParams = { group: string; force: boolean }

/**
 * `activate-group`'s own wiring (plan 122 §4.8, step 122.10) — that it is a
 * genuinely THIN wrapper: it forwards `ctx.params.group`/`.force` into
 * `groups-service.ts`'s real `activateGroup(ctx, ...)` unchanged, and passes
 * its `ok`/`code`/`message` straight through, reimplementing none of the
 * §4.6 conflict check or the §3.2 local-exception gate itself.
 *
 * Every case here reaches a refusal `activateGroup` itself produces BEFORE
 * ever touching the router — no fake `RouterDriver` is wired in (the script
 * calls `activateGroup(ctx, ...)` with no `deps` override, exactly as it
 * will run for real), so these tests never attempt a network call. The full
 * activation transaction (a clean activate, a `force` activate, deactivation
 * under each `onDeactivate` policy) is already exhaustively covered against
 * a fake `RouterDriver` in `service/groups-service.test.ts` — duplicating
 * that here, unable to inject a fake driver through the script's own params,
 * would mean either a real network attempt or a second, parallel fixture
 * that could drift from the one already proven correct.
 */

function groupFixture(overrides: Partial<Group> = {}): Group {
  return { id: 'jadwal-1', name: 'Jadwal-1', note: '', entries: [], active: false, onDeactivate: 'remove-rules', failoverPolicy: 'none', updatedAt: 0, ...overrides }
}

function fakeCtx(opts: { groups?: Group[] } = {}) {
  const globalStore = new Map<string, unknown>()
  for (const g of opts.groups ?? []) globalStore.set(groupKeyFor(g.id), writeGroup(g))
  const warnings: unknown[] = []
  const ctx = {
    storage: {
      global: {
        getRaw: async (key: string) => (globalStore.has(key) ? globalStore.get(key) : null),
        set: async (key: string, value: unknown) => {
          globalStore.set(key, value)
          return { version: 1 }
        },
        list: async (listOpts?: { prefix?: string }) => {
          const prefix = listOpts?.prefix ?? ''
          const items = [...globalStore.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }))
          return { items, nextCursor: null }
        },
        delete: async (key: string) => globalStore.delete(key),
      },
      forDevice: () => ({ getRaw: async () => null, set: async () => ({ version: 1 }), delete: async () => false }),
    },
    farm: { call: async (_id: string, _input: unknown, schema: { parse: (v: unknown) => unknown }) => schema.parse({ items: [] }) },
    log: {
      info: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      error: () => {},
      debug: () => {},
    },
    params: { group: 'jadwal-1', force: false } as ActivateGroupParams,
  }
  return { ctx, warnings }
}

describe('activate-group — the wrapper', () => {
  test('an unknown group forwards E_GROUP_NOT_FOUND verbatim from activateGroup, before any router call', async () => {
    const { ctx, warnings } = fakeCtx()
    ctx.params = { group: 'no-such-group', force: false }
    const result = await activateGroupScript.run(ctx as unknown as ScriptContext<ActivateGroupParams>)
    expect(result).toEqual({ ok: false, code: 'E_GROUP_NOT_FOUND', message: expect.stringContaining('no-such-group') })
    expect(warnings).toHaveLength(1)
  })

  test('a conflicting activation without force forwards E_GROUP_CONFLICT, naming the overlap, before any router call', async () => {
    const { ctx } = fakeCtx({
      groups: [
        groupFixture({ id: 'jadwal-1', active: true, entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }] }),
        groupFixture({ id: 'jadwal-2', name: 'Jadwal-2', entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem2' }] }),
      ],
    })
    ctx.params = { group: 'jadwal-2', force: false }
    const result = await activateGroupScript.run(ctx as unknown as ScriptContext<ActivateGroupParams>)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('E_GROUP_CONFLICT')
    expect(result.message).toContain('d1')
  })

  // `force`'s own default (false, when a caller omits it) is the SDK runtime's job — it parses raw
  // job input through `activateGroupScript.params` BEFORE `run(ctx)` is ever called, so `ctx.params`
  // here always already carries a concrete boolean. That default is proven directly against the
  // schema itself in `index.test.ts` ("activate-group requires a group id, defaults force to false").

  test('router not configured reaches activateGroup’s REAL refusal (E_ROUTER_NOT_CONFIGURED) with no network attempt — the script injects no fake driver', async () => {
    const { ctx } = fakeCtx({ groups: [groupFixture({ entries: [{ deviceId: 'd1', lanIp: '192.168.10.215', pathId: 'via-modem1' }] })] })
    ctx.params = { group: 'jadwal-1', force: false }
    const result = await activateGroupScript.run(ctx as unknown as ScriptContext<ActivateGroupParams>)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('E_ROUTER_NOT_CONFIGURED')
  })
})
