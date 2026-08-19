import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { readProxyRecord } from '../shared'
import { resetProxyManager, type ResetHost, type ResetSupervisor } from './reset'
import type { ProxyRuntime, ProxyView } from './supervisor'

/**
 * Proxy manager's **Reset data** cleanup handler.
 *
 * Every claim here is one the farm relies on before it deletes a row:
 *
 * - a phone this pack routed is un-routed FIRST, and the un-routing is reported
 *   as done only when the phone was actually told;
 * - a phone somebody else routed is left exactly as it is;
 * - an unreachable phone is `pending` and never `cleared`, because `pending` is
 *   what makes the delete safe (the debt has moved to the device's own row) and
 *   `cleared` would be a claim about a phone that was never contacted;
 * - a refusal is `failed`, which is what keeps every row of this pack's data.
 */

interface Call {
  id: string
  input: unknown
}

interface Status {
  engine: string
  enabled: boolean
  setBy?: { kind: string; id: string; at: number } | null
  pendingClear?: { reason: string; since: number } | null
}

const OURS = { kind: 'plugin', id: 'proxy-manager', at: 1 }

function host(opts: {
  devices: { id: string; stableId: string; label?: string }[]
  assigned?: Record<string, string>
  get?: Record<string, Status>
  clear?: Record<string, Status | Error>
  listFails?: boolean
}): ResetHost & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    storage: {
      forDevice: (deviceId) => ({
        getRaw: async (key) => {
          if (key !== 'assigned') return null
          const proxy = opts.assigned?.[deviceId]
          return proxy ? { proxy } : null
        },
      }),
    },
    farm: {
      async call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
        calls.push({ id, input })
        if (id === 'device.list') {
          if (opts.listFails) throw new Error('the farm could not be reached')
          return schema.parse({ items: opts.devices })
        }
        const deviceId = (input as { deviceId: string }).deviceId
        if (id === 'device.network.get') {
          return schema.parse(opts.get?.[deviceId] ?? { engine: 'none', enabled: false })
        }
        if (id === 'device.network.clear') {
          const answer = opts.clear?.[deviceId]
          if (answer instanceof Error) throw answer
          return schema.parse(answer ?? { engine: 'none', enabled: false })
        }
        throw new Error(`unexpected capability ${id}`)
      },
    },
    log: { info: () => {}, warn: () => {} },
  }
}

function supervisor(views: { id: string; state: ProxyRuntime['state']; port?: number }[], stopFails = new Set<string>()): ResetSupervisor & { stopped: string[] } {
  const stopped: string[] = []
  const runtimeOf = (id: string, state: ProxyRuntime['state'], port: number | null): ProxyRuntime => ({
    id,
    state,
    since: 0,
    port,
    liveConnections: 0,
    totalConnections: 0,
    refusedConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    lastError: null,
  })
  return {
    stopped,
    snapshot: (): ProxyView[] =>
      views.map((v) => ({ id: v.id, record: readProxyRecord({ label: v.id }), runtime: runtimeOf(v.id, v.state, v.port ?? null), problems: [] })),
    stop: async (id) => {
      if (stopFails.has(id)) throw new Error('the port would not release')
      stopped.push(id)
      return runtimeOf(id, 'stopped', null)
    },
  }
}

const noBridges = supervisor([])

describe('resetProxyManager — the phones', () => {
  test('a route this pack applied is turned off, and reported as cleared only because the phone was told', async () => {
    const h = host({
      devices: [{ id: 'd1', stableId: 's1', label: 'Pixel 1' }],
      assigned: { d1: 'proxy:soax' },
      get: { d1: { engine: 'adb-reverse-proxy', enabled: true, setBy: OURS } },
      clear: { d1: { engine: 'none', enabled: false, pendingClear: null } },
    })
    const report = await resetProxyManager(h, noBridges)

    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ kind: 'device', id: 's1', label: 'Pixel 1', outcome: 'cleared' })
    expect(h.calls.map((c) => c.id)).toEqual(['device.list', 'device.network.get', 'device.network.clear'])
  })

  test('an unreachable phone is `pending`, never `cleared` — the route is still live on it', async () => {
    const h = host({
      devices: [{ id: 'd1', stableId: 's1' }],
      assigned: { d1: 'proxy:soax' },
      get: { d1: { engine: 'vpn-helper', enabled: true, setBy: OURS } },
      clear: { d1: { engine: 'vpn-helper', enabled: false, pendingClear: { reason: 'the device is offline', since: 10 } } },
    })
    const report = await resetProxyManager(h, noBridges)

    expect(report.items[0]?.outcome).toBe('pending')
    expect(report.items[0]?.message).toContain('the device is offline')
    expect(report.items[0]?.message).toContain('next time the device is admitted')
  })

  test("a route somebody ELSE set is left alone, and clear is never called on it", async () => {
    const h = host({
      devices: [{ id: 'd1', stableId: 's1' }],
      assigned: { d1: 'proxy:soax' },
      get: { d1: { engine: 'adb-proxy', enabled: true, setBy: { kind: 'user', id: 'ada', at: 1 } } },
    })
    const report = await resetProxyManager(h, noBridges)

    expect(report.items[0]?.outcome).toBe('unchanged')
    expect(report.items[0]?.message).toContain('ada, by hand')
    expect(h.calls.some((c) => c.id === 'device.network.clear')).toBe(false)
  })

  test('another PLUGIN’s route is left alone too, and named', async () => {
    const h = host({
      devices: [{ id: 'd1', stableId: 's1' }],
      assigned: { d1: 'proxy:soax' },
      get: { d1: { engine: 'vpn-helper', enabled: true, setBy: { kind: 'plugin', id: 'networking', at: 1 } } },
    })
    const report = await resetProxyManager(h, noBridges)
    expect(report.items[0]?.outcome).toBe('unchanged')
    expect(report.items[0]?.message).toContain('“networking” plugin')
    expect(h.calls.some((c) => c.id === 'device.network.clear')).toBe(false)
  })

  test('a phone with a note but no live route needs no visit — which is also what a SECOND reset sees', async () => {
    const h = host({
      devices: [{ id: 'd1', stableId: 's1' }],
      assigned: { d1: 'proxy:soax' },
      get: { d1: { engine: 'none', enabled: false } },
    })
    const report = await resetProxyManager(h, noBridges)
    expect(report.items[0]?.outcome).toBe('unchanged')
    expect(h.calls.some((c) => c.id === 'device.network.clear')).toBe(false)
  })

  test('a phone this pack never assigned is not reported at all', async () => {
    const h = host({ devices: [{ id: 'd1', stableId: 's1' }, { id: 'd2', stableId: 's2' }], assigned: { d2: 'proxy:soax' }, get: { d2: { engine: 'none', enabled: false } } })
    const report = await resetProxyManager(h, noBridges)
    expect(report.items.map((i) => i.id)).toEqual(['s2'])
  })

  test('a refusal from the farm is `failed`, and says the phone is still carrying it', async () => {
    const busy = Object.assign(new Error('device_busy: a job is running on this device'), { code: 'device_busy' })
    const h = host({
      devices: [{ id: 'd1', stableId: 's1' }],
      assigned: { d1: 'proxy:soax' },
      get: { d1: { engine: 'adb-reverse-proxy', enabled: true, setBy: OURS } },
      clear: { d1: busy },
    })
    const report = await resetProxyManager(h, noBridges)
    expect(report.items[0]?.outcome).toBe('failed')
    expect(report.items[0]?.message).toContain('device_busy')
    expect(report.items[0]?.message).toContain('still carrying it')
  })

  test('a `device.list` that fails throws rather than reporting an all-clear over nothing', async () => {
    const h = host({ devices: [], listFails: true })
    await expect(resetProxyManager(h, noBridges)).rejects.toThrow()
  })
})

describe('resetProxyManager — the bridges', () => {
  test('every listening bridge is stopped, and a stopped one is left alone', async () => {
    const sup = supervisor([
      { id: 'a', state: 'running', port: 9902 },
      { id: 'b', state: 'stopped' },
    ])
    const report = await resetProxyManager(host({ devices: [] }), sup)

    expect(sup.stopped).toEqual(['a'])
    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ kind: 'resource', id: 'proxy:a', outcome: 'cleared' })
    expect(report.items[0]?.message).toContain('9902')
  })

  test('a bridge that will not stop is `failed`, because its port is still bound', async () => {
    const sup = supervisor([{ id: 'a', state: 'running', port: 9902 }], new Set(['a']))
    const report = await resetProxyManager(host({ devices: [] }), sup)
    expect(report.items[0]?.outcome).toBe('failed')
    expect(report.items[0]?.message).toContain('still bound')
  })

  test('devices are handled BEFORE bridges — a phone must not be pointed at a port that has already gone', async () => {
    const sup = supervisor([{ id: 'a', state: 'running', port: 9902 }])
    const h = host({
      devices: [{ id: 'd1', stableId: 's1' }],
      assigned: { d1: 'proxy:a' },
      get: { d1: { engine: 'adb-reverse-proxy', enabled: true, setBy: OURS } },
      clear: { d1: { engine: 'none', enabled: false } },
    })
    const report = await resetProxyManager(h, sup)
    expect(report.items.map((i) => i.kind)).toEqual(['device', 'resource'])
  })

  test('nothing assigned and nothing listening says so, rather than answering with an empty list', async () => {
    const report = await resetProxyManager(host({ devices: [{ id: 'd1', stableId: 's1' }] }), noBridges)
    expect(report.items).toHaveLength(0)
    expect(report.note).toContain('nothing on any phone')
  })
})
