import { describe, expect, test } from 'bun:test'
import type { PluginLogPage } from '@enkaku/protocol'
import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import { DEFAULT_DRAIN_MS, DEFAULT_MAX_CONNECTIONS, PROXY_LOGS_DEFAULT_LIMIT, type ProxyRecord } from '../shared'
import { PROXY_ROUTES, PROXY_ROUTE_PERMISSIONS, STOP_TIMEOUT_MS, proxyIdFromPath, registerProxyRoutes, type HandlerHost } from './handlers'
import type { ProxyRuntime, ProxyState, ProxyView, Supervisor } from './supervisor'

/**
 * Plan 112 step 112.9 — the five routes.
 *
 * The property this file is buying is not "start works": the supervisor's own
 * tests prove that, against real sockets. It is that **the routes are a door
 * and not a second lifecycle** — every one of them ends in a supervisor call,
 * none of them keeps a state, and a proxy id that names nothing is refused here
 * rather than thrown out of the plugin as a fault.
 */

function record(over: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    label: 'Office UK',
    listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 },
    upstream: { proto: 'socks5', host: 'up.example', port: 1080, username: 'country-id-r9931204', bindAddress: '', resolveThroughEgress: true },
    enabled: true,
    logDestinations: false,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
    drainMs: DEFAULT_DRAIN_MS,
    capacity: 0,
    exclusive: false,
    listenerAuth: false,
    notes: '',
    ...over,
  }
}

function runtime(over: Partial<ProxyRuntime> = {}): ProxyRuntime {
  return {
    id: 'office-uk',
    state: 'stopped' as ProxyState,
    since: Date.now() - 5_000,
    port: null,
    liveConnections: 0,
    totalConnections: 0,
    refusedConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    lastError: null,
    ...over,
  }
}

interface Registration {
  id: string
  handler: (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>
  opts?: { permission?: string; methods?: readonly string[]; timeoutMs?: number; description?: string }
}

interface Rig {
  routes: Map<string, Registration>
  calls: string[]
  lines: { level: string; message: string; fields?: Record<string, unknown> }[]
  logPages: { cursor?: number | null; subject?: string | null; limit?: number }[]
  call(id: string, over?: Partial<PluginRequest>): Promise<PluginResponse>
}

function rig(opts: { views?: ProxyView[]; logs?: () => Promise<PluginLogPage> } = {}): Rig {
  const views = opts.views ?? [{ id: 'office-uk', record: record(), runtime: runtime(), problems: [] }]
  const routes = new Map<string, Registration>()
  const calls: string[] = []
  const lines: Rig['lines'] = []
  const logPages: Rig['logPages'] = []
  let refreshed = 0

  const supervisor: Supervisor = {
    list: () => views.map((v) => v.runtime),
    snapshot: () => views,
    runtimeOf: (id) => views.find((v) => v.id === id)?.runtime ?? null,
    has: (id) => views.some((v) => v.id === id),
    refresh: async () => {
      refreshed += 1
      calls.push('refresh')
    },
    start: async (id) => {
      calls.push(`start:${id}`)
      return runtime({ state: 'running', port: 9902, since: Date.now() })
    },
    stop: async (id, stopOpts) => {
      calls.push(`stop:${id}:${stopOpts?.force === true ? 'force' : 'drain'}`)
      return runtime({ state: 'stopped' })
    },
    restart: async (id) => {
      calls.push(`restart:${id}`)
      return runtime({ state: 'running', port: 9902 })
    },
    startEnabled: async () => {},
    destroyAll: async () => {},
  }

  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, ...(fields ? { fields } : {}) })
  }

  const host: HandlerHost = {
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    logs: {
      page: async (pageOpts) => {
        logPages.push(pageOpts ?? {})
        if (opts.logs) return await opts.logs()
        return { plugin: 'proxy-manager', lines: [], truncated: false, nextSeq: 0, subject: pageOpts?.subject ?? null }
      },
    },
    onRequest: (id, handler, handlerOpts) => {
      routes.set(id, { id, handler, ...(handlerOpts ? { opts: handlerOpts } : {}) })
    },
  }

  registerProxyRoutes(host, supervisor)
  void refreshed

  return {
    routes,
    calls,
    lines,
    logPages,
    async call(id, over) {
      const registration = routes.get(id)
      if (!registration) throw new Error(`no route registered as "${id}"`)
      const request: PluginRequest = {
        method: 'GET',
        path: '/',
        query: {},
        headers: {},
        body: null,
        caller: { id: 'ops@example', role: 'operator' },
        ...over,
      }
      const result = await registration.handler(request, new AbortController().signal)
      return result ?? { status: 204 }
    },
  }
}

describe('the route table, and the permission each one declares', () => {
  test('five routes, and they are the five plan 112 §4.6 asked for', () => {
    const { routes } = rig()
    expect([...routes.keys()].sort()).toEqual(['logs', 'proxies', 'restart', 'start', 'stop'])
    expect(Object.values(PROXY_ROUTES).map(String).sort()).toEqual([...routes.keys()].sort())
  })

  test('the two that READ are gated on script.view; the three that ACT are gated on plugin.runtime', () => {
    const { routes } = rig()
    expect(routes.get('proxies')?.opts?.permission).toBe('script.view')
    expect(routes.get('logs')?.opts?.permission).toBe('script.view')
    for (const id of ['start', 'stop', 'restart']) {
      // `plugin.runtime` is the farm's own answer to "may this person start and
      // stop a plugin's long-lived half" — the same permission
      // `POST /api/plugins/:name/runtime/restart` requires. Deliberately not
      // `plugin.data`: nobody is editing a record here, they are changing what
      // is listening on the machine.
      expect(routes.get(id)?.opts?.permission).toBe('plugin.runtime')
    }
    // The exported table is the same table, so a screen and a test read the
    // declaration rather than the implementation's memory of it.
    expect(PROXY_ROUTE_PERMISSIONS).toEqual({ list: 'script.view', start: 'plugin.runtime', stop: 'plugin.runtime', restart: 'plugin.runtime', logs: 'script.view' })
  })

  test('the reads answer GET and the actions answer POST — never both', () => {
    const { routes } = rig()
    expect(routes.get('proxies')?.opts?.methods).toEqual(['GET'])
    expect(routes.get('logs')?.opts?.methods).toEqual(['GET'])
    for (const id of ['start', 'stop', 'restart']) expect(routes.get(id)?.opts?.methods).toEqual(['POST'])
  })

  test('every route describes itself, because the description is what the runtime panel shows an operator', () => {
    const { routes } = rig()
    for (const registration of routes.values()) expect(registration.opts?.description ?? '').not.toBe('')
  })

  test('only STOP widens its deadline, and it is wider than the widest drain a record can ask for', () => {
    const { routes } = rig()
    // `drainMs` is bounded at 120 000 by the record schema, and the handler
    // waits for the supervisor's own promise rather than returning early and
    // inventing a second notion of "stopping".
    expect(STOP_TIMEOUT_MS).toBeGreaterThan(120_000)
    // …and inside the host's own clamp of 300 000, or the override would be
    // silently cut back to something narrower than the drain it exists for.
    expect(STOP_TIMEOUT_MS).toBeLessThan(300_000)
    expect(routes.get('stop')?.opts?.timeoutMs).toBe(STOP_TIMEOUT_MS)
    expect(routes.get('start')?.opts?.timeoutMs).toBeUndefined()
    expect(routes.get('restart')?.opts?.timeoutMs).toBeUndefined()
  })
})

describe('GET …/http/proxies — the record joined with what is observed about it', () => {
  test('intent and observation are both present and are kept apart', async () => {
    const harness = rig({
      views: [
        { id: 'office-uk', record: record({ enabled: true }), runtime: runtime({ state: 'failed', lastError: { code: 'E_PROXY_LISTEN_ADDR_IN_USE', message: 'taken' } }), problems: [] },
      ],
    })
    const response = await harness.call('proxies')
    const rows = (response.body as { items: Record<string, unknown>[] }).items
    expect(rows).toHaveLength(1)
    const row = rows[0] as { record: ProxyRecord; state: string; lastError: unknown; key: string; startable: boolean; uptimeMs: number | null }
    // `enabled` says it SHOULD be listening; `state` says it is not. A shape
    // that collapsed the two would have nothing to say about the interesting
    // row on the screen (plan 112 §3.5).
    expect(row.record.enabled).toBe(true)
    expect(row.state).toBe('failed')
    expect(row.lastError).toEqual({ code: 'E_PROXY_LISTEN_ADDR_IN_USE', message: 'taken' })
    expect(row.key).toBe('proxy:office-uk')
    expect(row.startable).toBe(true)
    // An uptime for something that is not up is a number that reads as a lie.
    expect(row.uptimeMs).toBeNull()
  })

  test('a running row DOES report an uptime — the control for the assertion above', async () => {
    const harness = rig({ views: [{ id: 'office-uk', record: record(), runtime: runtime({ state: 'running', port: 9902, since: Date.now() - 4_000 }), problems: [] }] })
    const row = ((await harness.call('proxies')).body as { items: { uptimeMs: number }[] }).items[0]
    expect(row?.uptimeMs).toBeGreaterThanOrEqual(3_500)
  })

  test('a record that cannot start says why on its own row, and is not reported startable', async () => {
    const problems = [{ code: 'E_PROXY_PORT_UNASSIGNED', kind: 'precondition' as const, message: 'this record needs a local port' }]
    const harness = rig({ views: [{ id: 'legacy', record: record({ listen: { proto: 'http', bindHost: '127.0.0.1', port: null } }), runtime: runtime(), problems }] })
    const row = ((await harness.call('proxies')).body as { items: { problems: unknown[]; startable: boolean }[] }).items[0]
    expect(row?.problems).toEqual(problems)
    expect(row?.startable).toBe(false)
  })

  test('the catalogue is re-read before it is answered, or a record saved a moment ago would not be in it', async () => {
    const harness = rig()
    await harness.call('proxies')
    expect(harness.calls).toEqual(['refresh'])
  })

  test('no password, no secret key, anywhere in the answer', async () => {
    const harness = rig()
    const rendered = JSON.stringify((await harness.call('proxies')).body)
    expect(rendered).not.toContain('password')
    expect(rendered).not.toContain('proxy-secret:')
  })
})

describe('start, stop and restart drive the supervisor — there is no second lifecycle here', () => {
  test('each verb calls its own supervisor method, once, with the id from the path', async () => {
    const harness = rig()
    await harness.call('start', { method: 'POST', path: '/office-uk' })
    await harness.call('restart', { method: 'POST', path: '/office-uk' })
    expect(harness.calls).toEqual(['refresh', 'start:office-uk', 'refresh', 'restart:office-uk'])
  })

  test('`{ "force": true }` reaches the supervisor as a force stop, and its absence does not', async () => {
    const harness = rig()
    await harness.call('stop', { method: 'POST', path: '/office-uk', body: { force: true } })
    await harness.call('stop', { method: 'POST', path: '/office-uk', body: {} })
    await harness.call('stop', { method: 'POST', path: '/office-uk', body: null })
    expect(harness.calls.filter((c) => c.startsWith('stop'))).toEqual(['stop:office-uk:force', 'stop:office-uk:drain', 'stop:office-uk:drain'])
  })

  test('`ok` is about the state that was reached, not about the request having been accepted', async () => {
    const harness = rig()
    const started = (await harness.call('start', { method: 'POST', path: '/office-uk' })).body as { ok: boolean; runtime: ProxyRuntime }
    expect(started.ok).toBe(true)
    expect(started.runtime.state).toBe('running')
    const stopped = (await harness.call('stop', { method: 'POST', path: '/office-uk' })).body as { ok: boolean; runtime: ProxyRuntime }
    expect(stopped.ok).toBe(true)
    expect(stopped.runtime.state).toBe('stopped')
  })

  test('a proxy id that names no record is a 404 about the RECORD — never a throw, never a silent success', async () => {
    const harness = rig()
    const response = await harness.call('start', { method: 'POST', path: '/deleted-yesterday' })
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ ok: false, code: 'E_PROXY_UNKNOWN' })
    expect((response.body as { message: string }).message).toMatch(/reload the tab/)
    // And nothing was started. A throw here would become the host's 502 naming
    // this plugin as faulty, which is a claim about the code rather than about
    // a row somebody deleted.
    expect(harness.calls).toEqual(['refresh'])
  })

  test('a missing id says what the path should look like rather than 404ing anonymously', async () => {
    const harness = rig()
    const response = await harness.call('stop', { method: 'POST', path: '/' })
    expect(response.status).toBe(404)
    expect((response.body as { message: string }).message).toMatch(/\/start\/office-uk/)
  })

  test('the id is read off the path, tolerating the trailing slash a browser will eventually send', () => {
    expect(proxyIdFromPath('/office-uk')).toBe('office-uk')
    expect(proxyIdFromPath('/office-uk/')).toBe('office-uk')
    expect(proxyIdFromPath('/office-uk/anything/else')).toBe('office-uk')
    expect(proxyIdFromPath('/')).toBe('')
  })

  test('who pressed it is recorded on THAT proxy’s own line, which the audit row cannot carry', async () => {
    const harness = rig()
    await harness.call('start', { method: 'POST', path: '/office-uk', caller: { id: 'ada@example', role: 'admin' } })
    const line = harness.lines.find((l) => l.message.includes('start'))
    // The farm audits the request itself as `plugin.http`, naming the human and
    // the verb — but its target is `<plugin>/<handler>` and it carries neither
    // the sub-path nor the body, so WHICH proxy is only ever knowable from here.
    expect(line?.fields).toEqual({ subject: 'proxy:office-uk', by: 'ada@example' })
  })
})

describe('GET …/http/logs — one stream, filtered by the FARM', () => {
  test('“all” is the unfiltered page and “per proxy” is the same page with a subject', async () => {
    const harness = rig()
    await harness.call('logs')
    await harness.call('logs', { query: { proxy: 'office-uk' } })
    expect(harness.logPages).toEqual([
      { cursor: null, subject: null, limit: PROXY_LOGS_DEFAULT_LIMIT },
      { cursor: null, subject: 'proxy:office-uk', limit: PROXY_LOGS_DEFAULT_LIMIT },
    ])
  })

  test('a cursor and a limit are passed through, and junk falls back rather than throwing', async () => {
    const harness = rig()
    await harness.call('logs', { query: { cursor: '412', limit: '25' } })
    await harness.call('logs', { query: { cursor: 'nonsense', limit: '-3' } })
    expect(harness.logPages[0]).toEqual({ cursor: 412, subject: null, limit: 25 })
    expect(harness.logPages[1]).toEqual({ cursor: null, subject: null, limit: PROXY_LOGS_DEFAULT_LIMIT })
  })

  test('the page is answered verbatim — `truncated` included, because it is the honest half', async () => {
    const harness = rig({
      logs: async () => ({ plugin: 'proxy-manager', lines: [{ seq: 9, ts: 1, level: 'info', subject: 'proxy:office-uk', msg: 'proxy is listening' }], truncated: true, nextSeq: 9, subject: 'proxy:office-uk' }),
    })
    const body = (await harness.call('logs', { query: { proxy: 'office-uk' } })).body as { truncated: boolean; nextSeq: number; proxy: string | null; lines: unknown[] }
    expect(body.truncated).toBe(true)
    expect(body.nextSeq).toBe(9)
    expect(body.lines).toHaveLength(1)
    // Echoed beside the farm's own `subject`, so the screen can tell a filtered
    // page from an empty plugin without re-deriving the tag.
    expect(body.proxy).toBe('office-uk')
  })

  test('a farm with no log store is reported as such — and NEVER as an empty page', async () => {
    const err = Object.assign(new Error('this host has no log store wired'), { code: 'E_PLUGIN_LOGS_UNAVAILABLE' })
    const harness = rig({
      logs: async () => {
        throw err
      },
    })
    const response = await harness.call('logs')
    expect(response.status).toBe(503)

    // The envelope is the FARM's — `{ error: { code, message } }` — and that
    // is the whole point of this assertion rather than a shape preference.
    // `api()` unwraps only this form, so the flat `{ ok, code, message }` this
    // route first shipped reached the operator as a bare "Request failed (HTTP
    // 503)" with the code and the sentence dropped on the floor. A coded
    // refusal nobody can read is the same as an uncoded one.
    expect(response.body).toMatchObject({
      error: { code: 'E_PLUGIN_LOGS_UNAVAILABLE', message: 'this host has no log store wired' },
    })
    expect(response.body).not.toHaveProperty('ok')
    expect(response.body).not.toHaveProperty('code')

    // The load-bearing absence: `lines: []` would render as "this plugin has
    // logged nothing", which is a different and false claim. The farm refuses
    // rather than answering an empty page, and this route must not undo that.
    expect(response.body).not.toHaveProperty('lines')
  })

  test('this pack builds no filter of its own — the subject goes to the farm and the farm decides', async () => {
    const source = await Bun.file(new URL('./handlers.ts', import.meta.url)).text()
    // Plan 112 §3.8 planned to filter client-side in v1 and widen plan 109 step
    // 109.8's route later. 109.8 shipped the server-side filter from day one,
    // so the v1 workaround must never be built: a second filter is a second
    // answer to "which lines are this proxy's".
    expect(source).toContain('host.logs.page(opts)')
    expect(source).not.toMatch(/\.filter\(/)
  })
})
