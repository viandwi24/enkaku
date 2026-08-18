import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { applyAssignment, type ApplyHost } from './apply'
import { ASSIGNMENT_KEY, DEFAULT_DRAIN_MS, DEFAULT_MAX_CONNECTIONS, PROXY_PROBLEM_CODES, proxyKeyFor, writeProxyRecord, type ProxyRecord } from '../shared'

/**
 * Plan 117 step 117.11 — the capacity guard (§3.8, §4.2, step 117.10), the
 * one code (`E_PROXY_CAPACITY_FULL`) `record.test.ts`'s own completeness
 * check names as unreachable from `validateProxyRecord`/`routeForRecord`/
 * `vpnAgentProblem` because its producer lives here, in `applyAssignment`,
 * which needs a device list and per-device storage those three pure
 * functions do not take.
 *
 * `ApplyHost` is deliberately narrow (`apply.ts`'s own doc comment: "so a
 * test supplies three functions, not a runtime") — this file is what
 * exercises that seam.
 */

const DEVICE_A = { id: 'dev-a', stableId: 'stable-a', agent: 'ready', label: 'Phone A' }
const DEVICE_B = { id: 'dev-b', stableId: 'stable-b', agent: 'ready', label: 'Phone B' }
const DEVICE_C = { id: 'dev-c', stableId: 'stable-c', agent: 'ready', label: 'Phone C' }

function record(over: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    label: 'Office UK',
    listen: { proto: 'http', bindHost: '127.0.0.1', port: 9902 },
    upstream: { proto: 'socks5', host: '10.4.0.9', port: 1080, username: '', bindAddress: '', resolveThroughEgress: true },
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

const NetworkStatusSchema = z.looseObject({
  engine: z.string(),
  enabled: z.boolean(),
  health: z.string(),
  setBy: z.object({ kind: z.string(), id: z.string(), at: z.number() }).nullable().optional(),
})

interface Harness {
  host: ApplyHost
  networkSetCalls: unknown[]
}

/**
 * `devices` is the farm-wide list; `assignments` maps a device id to the
 * `assigned` key it holds (or none). Both mutable so a test can move an
 * assignment between calls, the way a real "device already holds it, then
 * re-applies" scenario does.
 */
function harness(devices: { id: string; stableId: string; agent?: string; label?: string }[], proxyId: string, proxyRecord: ProxyRecord, assignments: Record<string, string | undefined>): Harness {
  const networkSetCalls: unknown[] = []
  const host: ApplyHost = {
    storage: {
      global: {
        getRaw: async (key) => (key === proxyKeyFor(proxyId) ? writeProxyRecord(proxyRecord) : null),
      },
      forDevice: (deviceId) => ({
        getRaw: async (key) => {
          if (key !== ASSIGNMENT_KEY) return null
          const proxy = assignments[deviceId]
          return proxy ? { proxy } : null
        },
      }),
    },
    farm: {
      call: async <T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> => {
        if (id === 'device.list') return schema.parse({ items: devices })
        if (id === 'device.network.set') {
          networkSetCalls.push(input)
          return schema.parse({ engine: 'adb-reverse-proxy', enabled: true, health: 'ok', setBy: { kind: 'plugin', id: 'proxy-manager', at: 0 } })
        }
        throw new Error(`unexpected capability call: ${id}`)
      },
    },
    log: { info: () => {}, warn: () => {} },
  }
  return { host, networkSetCalls }
}

describe('the capacity guard is skipped entirely for an ordinary record', () => {
  test('capacity: 0, exclusive: false — never refused, whatever the fleet looks like', async () => {
    // Three devices already noted against the same record — if `capacity`
    // or `exclusive` were mistakenly enforced with their FALSY defaults, this
    // would refuse. It does not, because `record.capacity > 0 || record.exclusive`
    // is false and the whole block is skipped.
    const h = harness(
      [DEVICE_A, DEVICE_B, DEVICE_C],
      'office-uk',
      record(),
      { [DEVICE_A.id]: proxyKeyFor('office-uk'), [DEVICE_B.id]: proxyKeyFor('office-uk'), [DEVICE_C.id]: proxyKeyFor('office-uk') },
    )
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_C.stableId })
    expect(outcome.ok).toBe(true)
    expect(h.networkSetCalls.length).toBe(1)
  })
})

describe('exclusive — refuses a second concurrent assignment outright', () => {
  test('DEVICE_A already holds it; DEVICE_B is refused, and the message names DEVICE_A', async () => {
    const h = harness(
      [DEVICE_A, DEVICE_B],
      'office-uk',
      record({ exclusive: true }),
      { [DEVICE_A.id]: proxyKeyFor('office-uk'), [DEVICE_B.id]: proxyKeyFor('office-uk') },
    )
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_B.stableId })
    expect(outcome).toMatchObject({ ok: false, code: 'E_PROXY_CAPACITY_FULL', kind: 'refusal' })
    if (!outcome.ok) expect(outcome.message).toContain('Phone A')
    expect(h.networkSetCalls.length).toBe(0)
  })

  test('the re-apply case — DEVICE_A re-applying to the record it ALREADY holds is not refused', async () => {
    const h = harness([DEVICE_A], 'office-uk', record({ exclusive: true }), { [DEVICE_A.id]: proxyKeyFor('office-uk') })
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_A.stableId })
    expect(outcome.ok).toBe(true)
    expect(h.networkSetCalls.length).toBe(1)
  })

  test('a record with no other holder is never refused, exclusive or not', async () => {
    const h = harness([DEVICE_A], 'office-uk', record({ exclusive: true }), { [DEVICE_A.id]: proxyKeyFor('office-uk') })
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_A.stableId })
    expect(outcome.ok).toBe(true)
  })
})

describe('capacity — refuses only once the limit would genuinely be exceeded', () => {
  test('capacity 1, one holder, a SECOND device is refused and the message names the count and the holder', async () => {
    const h = harness(
      [DEVICE_A, DEVICE_B],
      'office-uk',
      record({ capacity: 1 }),
      { [DEVICE_A.id]: proxyKeyFor('office-uk'), [DEVICE_B.id]: proxyKeyFor('office-uk') },
    )
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_B.stableId })
    expect(outcome).toMatchObject({ ok: false, code: 'E_PROXY_CAPACITY_FULL', kind: 'refusal' })
    if (!outcome.ok) {
      expect(outcome.message).toContain('1 device')
      expect(outcome.message).toContain('Phone A')
    }
  })

  test('THE RE-APPLY CASE — a device that already holds the record is never counted as a NEW occupant, and must NOT be refused', async () => {
    // Capacity exactly 1, exactly 1 holder — and that holder is the one
    // pressing Apply again. `alreadyHolds` is what makes this succeed rather
    // than a full record refusing to be re-applied to the very device on it.
    const h = harness([DEVICE_A], 'office-uk', record({ capacity: 1 }), { [DEVICE_A.id]: proxyKeyFor('office-uk') })
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_A.stableId })
    expect(outcome.ok).toBe(true)
    expect(h.networkSetCalls.length).toBe(1)
  })

  test('capacity with headroom is not refused', async () => {
    const h = harness(
      [DEVICE_A, DEVICE_B],
      'office-uk',
      record({ capacity: 2 }),
      { [DEVICE_A.id]: proxyKeyFor('office-uk'), [DEVICE_B.id]: proxyKeyFor('office-uk') },
    )
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_B.stableId })
    expect(outcome.ok).toBe(true)
  })

  test('capacity applies the SAME way in HTTP mode as in VPN mode — it counts the note, not traffic, and says so', async () => {
    const h = harness(
      [DEVICE_A, DEVICE_B],
      'office-uk',
      record({ capacity: 1 }),
      { [DEVICE_A.id]: proxyKeyFor('office-uk'), [DEVICE_B.id]: proxyKeyFor('office-uk') },
    )
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_B.stableId, mode: 'http' })
    expect(outcome).toMatchObject({ ok: false, code: 'E_PROXY_CAPACITY_FULL' })
    if (!outcome.ok) expect(outcome.message).toMatch(/applies the same way in HTTP mode/)
  })

  test('devices that hold a DIFFERENT proxy do not count against this one’s capacity', async () => {
    // Capacity 2. DEVICE_C already holds "office-uk" (one real holder).
    // DEVICE_A holds a DIFFERENT record entirely. If DEVICE_A were wrongly
    // counted as a second "office-uk" holder, applying it to DEVICE_B (a
    // genuinely new occupant) would read 2 existing + 1 new = 3, over the
    // limit, and be refused. It is not — proving the count is scoped to
    // devices noted against THIS proxy's own key, not the fleet at large.
    const h = harness(
      [DEVICE_A, DEVICE_B, DEVICE_C],
      'office-uk',
      record({ capacity: 2 }),
      { [DEVICE_A.id]: 'proxy:some-other-proxy', [DEVICE_B.id]: proxyKeyFor('office-uk'), [DEVICE_C.id]: proxyKeyFor('office-uk') },
    )
    const outcome = await applyAssignment(h.host, { stableId: DEVICE_B.stableId })
    expect(outcome.ok).toBe(true)
  })
})

describe('E_PROXY_CAPACITY_FULL is registered in the shared closed list this file is the producer for', () => {
  test('the code this file raises is the one shared.ts already reserves for it', () => {
    expect(PROXY_PROBLEM_CODES).toContain('E_PROXY_CAPACITY_FULL')
  })
})
