import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  classifyDeviceNetworkApply,
  DeviceNetworkApplyResponseSchema,
  E_DEVICE_CONFLICT,
  type DeviceNetworkApplyOutcome,
  type DeviceNetworkApplyResult,
} from '@enkaku/protocol'
import { devices } from '../db/schema'
import { listenOnLoopback, makeRouteHarness, preparation, type RouteHarness } from '../network/route-service.fixture'

/**
 * `POST /api/devices/network/apply` — plan 114 §3.9, step 114.8.
 *
 * The endpoint is served by `network/route-service.ts` and mounted under
 * `/api/devices`; this file lives beside `devices.test.ts` because that is the
 * API surface it belongs to. It uses the same harness as
 * `network/route-service.test.ts` — one door, one construction (see
 * `route-service.fixture.ts`).
 *
 * Every assertion here is about the REPORT rather than about the write: a
 * partial failure across forty phones is the case this endpoint exists for, and
 * "a number that cannot be expanded into a device list is not a real report —
 * it is a rumour" (docs/design.md).
 */

interface ApplyBody {
  total: number
  results: DeviceNetworkApplyResult[]
}

const HTTP_PROXY = { engine: 'adb-proxy' as const, host: '127.0.0.1', port: 8080 }
const VPN = { engine: 'vpn-helper' as const, host: 'proxy.example', port: 1080, udpMode: 'udp' as const }

async function apply(h: RouteHarness, deviceIds: string[], route: unknown): Promise<{ status: number; body: ApplyBody }> {
  const res = await h.app.request('/network/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceIds, route }),
  })
  return { status: res.status, body: (await res.json()) as ApplyBody }
}

const outcomeOf = (body: ApplyBody, deviceId: string): DeviceNetworkApplyOutcome => classifyDeviceNetworkApply(body.results.find((r) => r.deviceId === deviceId)!)
const rowOf = (h: RouteHarness, deviceId: string): unknown => h.db.select().from(devices).all().find((r) => r.id === deviceId)?.networkRoute ?? null

/** `SkippedGroups`' own grouping key: the exact code AND the exact message (plan 114 §3.9). */
function groupByReason(results: DeviceNetworkApplyResult[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const r of results) {
    const reason = r.skip ? `${r.skip.code}: ${r.skip.message}` : r.error ? `${r.error.code}: ${r.error.message}` : 'applied'
    groups.set(reason, [...(groups.get(reason) ?? []), r.deviceId])
  }
  return groups
}

describe('the envelope (plan 114 §3.9, F18/F19)', () => {
  test('forty devices with three distinct failure reasons: every count expands to the named devices behind it', async () => {
    const h = makeRouteHarness()
    const applied: string[] = []
    const offline: string[] = []
    const busy: string[] = []
    const declined: string[] = []
    for (let i = 0; i < 40; i++) {
      const id = `dev-${i}`
      if (i < 10) {
        h.seed(id)
        applied.push(id)
      } else if (i < 25) {
        h.seed(id, { status: 'offline' })
        h.phone(id).offline = true
        offline.push(id)
      } else if (i < 35) {
        h.seed(id)
        // Plan 205 §2.4, §4.4: a live `control` marker no longer forbids
        // `network-apply` at all — a live job does, so THAT is what a bulk
        // apply can still be skipped by.
        h.activities.start(id, { id: `job:j-${i}`, kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
        busy.push(id)
      } else {
        h.seed(id)
        h.phone(id).ignoreWrites = true
        declined.push(id)
      }
    }

    const { status, body } = await apply(h, [...applied, ...offline, ...busy, ...declined], HTTP_PROXY)
    expect(status).toBe(200)
    expect(body.total).toBe(40)
    expect(body.results).toHaveLength(40)
    // The envelope is exactly the shape both sides parse.
    expect(DeviceNetworkApplyResponseSchema.safeParse(body).success).toBe(true)

    const groups = groupByReason(body.results)
    // Three distinct failure reasons plus the applied group — no more, so nothing
    // collapsed two different problems into one row.
    expect(groups.size).toBe(4)
    const named = (prefix: string): string[] => [...groups.entries()].filter(([k]) => k.startsWith(prefix)).flatMap(([, v]) => v)
    expect(named('E_DEVICE_OFFLINE').sort()).toEqual([...offline].sort())
    expect(named(E_DEVICE_CONFLICT).sort()).toEqual([...busy].sort())
    expect(named('E_SETTING_NOT_ACCEPTED').sort()).toEqual([...declined].sort())
    expect(groups.get('applied')?.sort()).toEqual([...applied].sort())

    // And the outcome classes agree with the codes.
    for (const id of applied) expect(outcomeOf(body, id)).toBe('applied')
    for (const id of [...offline, ...busy]) expect(outcomeOf(body, id)).toBe('skipped')
    for (const id of declined) expect(outcomeOf(body, id)).toBe('failed')
  })

  test('a device id that does not resolve is a FAILURE, not a skip — nothing about a phone is wrong', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const { body } = await apply(h, ['dev-1', 'ghost'], HTTP_PROXY)
    const ghost = body.results.find((r) => r.deviceId === 'ghost')!
    expect(classifyDeviceNetworkApply(ghost)).toBe('failed')
    expect(ghost.error?.code).toBe('device_not_found')
  })
})

describe('the four classes in one call (plan 114 acceptance criterion 9)', () => {
  test('applied / offline / held-by-another / VPN-on-an-agent-less phone, each with its own code', async () => {
    const h = makeRouteHarness()
    h.seed('ok-1', { preparation: preparation('ready') })
    h.seed('off-1', { status: 'offline', preparation: preparation('ready') })
    h.phone('off-1').offline = true
    h.seed('busy-1', { preparation: preparation('ready') })
    h.activities.start('busy-1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    h.seed('agentless-1', { preparation: preparation('absent') })

    const { body } = await apply(h, ['ok-1', 'off-1', 'busy-1', 'agentless-1'], VPN)
    expect(outcomeOf(body, 'ok-1')).toBe('applied')
    expect(body.results.find((r) => r.deviceId === 'off-1')?.skip?.code).toBe('E_DEVICE_OFFLINE')
    expect(body.results.find((r) => r.deviceId === 'busy-1')?.skip?.code).toBe(E_DEVICE_CONFLICT)
    expect(body.results.find((r) => r.deviceId === 'agentless-1')?.skip?.code).toBe('E_AGENT_NOT_READY')
    // Four devices, four distinct outcomes.
    expect(new Set(body.results.map((r) => `${classifyDeviceNetworkApply(r)}:${r.skip?.code ?? ''}`)).size).toBe(4)
  })

  test('E_AGENT_NOT_READY carries the per-device reason verbatim, and unsupported is E_UNSUPPORTED instead', async () => {
    const h = makeRouteHarness()
    h.seed('absent-1', { preparation: preparation('absent') })
    h.seed('provisioning-1', { preparation: preparation('provisioning') })
    h.seed('outdated-1', { preparation: preparation('outdated') })
    h.seed('failed-1', { preparation: preparation('failed', 'INSTALL_FAILED_INSUFFICIENT_STORAGE') })
    h.seed('failed-2', { preparation: preparation('failed', 'the device rejected the signature') })
    h.seed('unsupported-1', { preparation: preparation('unsupported', 'Android 8 is below the agent’s floor') })

    const { body } = await apply(h, ['absent-1', 'provisioning-1', 'outdated-1', 'failed-1', 'failed-2', 'unsupported-1'], VPN)
    const skip = (id: string) => body.results.find((r) => r.deviceId === id)!.skip!
    expect(skip('absent-1')).toMatchObject({ code: 'E_AGENT_NOT_READY' })
    expect(skip('absent-1').message).toContain('not installed')
    expect(skip('provisioning-1')).toMatchObject({ code: 'E_AGENT_NOT_READY' })
    expect(skip('provisioning-1').message).toContain('still installing')
    expect(skip('outdated-1')).toMatchObject({ code: 'E_AGENT_NOT_READY' })
    expect(skip('outdated-1').message).toContain('older than')
    // Verbatim, so twenty phones that failed the same way group into one row and a
    // twenty-first that failed differently stays visible.
    expect(skip('failed-1').message).toContain('INSTALL_FAILED_INSUFFICIENT_STORAGE')
    expect(skip('failed-2').message).toContain('the device rejected the signature')
    expect(skip('failed-1').message).not.toBe(skip('failed-2').message)
    // An old phone is not a broken one (plan 106) — a different code, and no invitation to retry.
    expect(skip('unsupported-1').code).toBe('E_UNSUPPORTED')
    expect(skip('unsupported-1').message).toContain('Android 8')
  })

  test('nothing is written to any skipped device, and no route row appears for one', async () => {
    const h = makeRouteHarness()
    h.seed('agentless-1', { preparation: preparation('absent') })
    h.seed('busy-1', { preparation: preparation('ready') })
    h.activities.start('busy-1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    await apply(h, ['agentless-1', 'busy-1'], VPN)
    expect(rowOf(h, 'agentless-1')).toBeNull()
    expect(rowOf(h, 'busy-1')).toBeNull()
    expect(h.phone('agentless-1').execs).toHaveLength(0)
  })
})

describe('never a silent downgrade (plan 114 §3.4, §3.9)', () => {
  test('a VPN bulk over a mixed set writes NO adb-proxy config to any skipped device', async () => {
    const h = makeRouteHarness()
    h.seed('ready-1', { preparation: preparation('ready') })
    h.seed('absent-1', { preparation: preparation('absent') })
    h.seed('unsupported-1', { preparation: preparation('unsupported', 'API 26') })

    const { body } = await apply(h, ['ready-1', 'absent-1', 'unsupported-1'], VPN)
    expect(outcomeOf(body, 'ready-1')).toBe('applied')

    // Read off the DATABASE, not off the report: the claim is about what is on disk.
    expect((rowOf(h, 'ready-1') as { config: { engine: string } }).config.engine).toBe('vpn-helper')
    expect(rowOf(h, 'absent-1')).toBeNull()
    expect(rowOf(h, 'unsupported-1')).toBeNull()
    for (const id of ['absent-1', 'unsupported-1']) {
      expect(JSON.stringify(rowOf(h, id) ?? '')).not.toContain('adb-proxy')
      expect(h.phone(id).settings.size).toBe(0)
    }
  })
})

describe('an offline phone (plan 114 §3.9)', () => {
  test('the route IS persisted enabled, the skip says so, and restoreDeviceRoute lands it when the phone returns', async () => {
    const h = makeRouteHarness()
    h.seed('off-1', { status: 'offline' })
    h.phone('off-1').offline = true

    const { body } = await apply(h, ['off-1'], HTTP_PROXY)
    const result = body.results[0]!
    expect(result.skip?.code).toBe('E_DEVICE_OFFLINE')
    expect(result.skip?.message).toContain('the route was saved')
    expect(rowOf(h, 'off-1')).toMatchObject({ enabled: true, config: { engine: 'adb-proxy' } })

    // The phone comes back.
    h.db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'off-1')).run()
    h.phone('off-1').offline = false
    await h.service.restoreDeviceRoute('off-1')
    expect(h.phone('off-1').settings.get('http_proxy')).toBe('127.0.0.1:8080')
  })

  test('an offline phone holding a DIFFERENT engine whose revert fails is a FAILURE — nothing persisted, and no "saved" message', async () => {
    const h = makeRouteHarness({ sessionCloseError: 'the forwarded port could not be released' })
    h.seed('off-1', { status: 'offline' })
    h.phone('off-1').offline = true
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: true } })
      .where(eq(devices.id, 'off-1'))
      .run()

    const { body } = await apply(h, ['off-1'], HTTP_PROXY)
    const result = body.results[0]!
    expect(classifyDeviceNetworkApply(result)).toBe('failed')
    expect(result.error?.code).toBe('E_ROUTE_LOCK_HELD')
    expect(result.skip).toBeNull()
    expect(JSON.stringify(result)).not.toContain('the route was saved')
    // The incumbent is still the one on disk — the new engine was never written.
    expect((rowOf(h, 'off-1') as { config: { engine: string } }).config.engine).toBe('vpn-helper')
  })
})

/**
 * Plan 205 §2.4, §4.4, §4.9 replaces the transient manual lease the bulk
 * path used to acquire/release around an online device's write (plan 114
 * §3.9, §9 Q2) with a `network-apply:<uuid>` activity marker, started and
 * ended around the SAME call — and, because `network-apply` allows over a
 * live `control` marker now, there is no more "somebody else is driving it,
 * skip" branch: a device under a live JOB is the only thing left that can
 * still skip a bulk apply (asserted above, in "the four classes" and the
 * 40-device envelope test).
 */
describe('the network-apply marker (plan 205 §4.9)', () => {
  test('started on the device and ended in a finally — even when the apply throws', async () => {
    const h = makeRouteHarness()
    h.seed('ok-1')
    h.seed('bad-1')
    h.phone('bad-1').ignoreWrites = true

    const { body } = await apply(h, ['ok-1', 'bad-1'], HTTP_PROXY)
    expect(outcomeOf(body, 'bad-1')).toBe('failed')
    for (const id of ['ok-1', 'bad-1']) {
      const calls = h.activityCalls.filter((c) => c.deviceId === id)
      expect(calls.map((c) => c.op), id).toEqual(['start', 'end'])
      expect(calls[0]?.id, id).toStartWith('network-apply:')
      // Nothing is left running on the device afterwards.
      expect(h.activities.list(id), id).toEqual([])
    }
  })

  test('a device the caller is already controlling still gets its own marker and applies normally', async () => {
    const h = makeRouteHarness()
    h.seed('mine-1')
    h.activities.touchControl('mine-1', 'client-a', { kind: 'user', id: 'u1', label: 'u1' })
    h.activityCalls.length = 0

    const { body } = await apply(h, ['mine-1'], HTTP_PROXY)
    expect(outcomeOf(body, 'mine-1')).toBe('applied')
    expect(h.activityCalls.map((c) => c.op)).toEqual(['start', 'end'])
    // And the operator's own control marker is untouched afterwards — the network-apply
    // marker is scoped to its own id and never ends somebody else's activity.
    expect(h.activities.controlOf('mine-1', 'client-a')).not.toBeNull()
  })

  test('a device under ANOTHER user’s control is no longer skipped, and is applied like any other online device', async () => {
    const h = makeRouteHarness()
    h.seed('theirs-1')
    h.activities.touchControl('theirs-1', 'other-client', { kind: 'user', id: 'u2', label: 'u2' })

    const { body } = await apply(h, ['theirs-1'], HTTP_PROXY)
    expect(outcomeOf(body, 'theirs-1')).toBe('applied')
    expect(rowOf(h, 'theirs-1')).not.toBeNull()
  })
})

describe('the request itself is validated once, for the whole call', () => {
  test('a credential in the route is ONE 400 and zero devices touched — not forty per-device failures', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.seed('dev-2')
    const res = await h.app.request('/network/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIds: ['dev-1', 'dev-2'], route: { ...HTTP_PROXY, username: 'sam' } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'E_HTTP_PROXY_NO_AUTH' } })
    for (const id of ['dev-1', 'dev-2']) {
      expect(rowOf(h, id)).toBeNull()
      expect(h.phone(id).execs).toHaveLength(0)
    }
  })

  test('a malformed route is one 400, not N per-device failures', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.seed('dev-2')
    const res = await h.app.request('/network/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIds: ['dev-1', 'dev-2'], route: { engine: 'adb-proxy', host: '', port: 70000 } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_BAD_REQUEST')
    expect(body.error.message).toContain('route.')
    expect(rowOf(h, 'dev-1')).toBeNull()
  })

  test('duplicate device ids are deduped — a selection naming one phone twice is a mistake, not an instruction', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const { body } = await apply(h, ['dev-1', 'dev-1', 'dev-1'], HTTP_PROXY)
    expect(body.total).toBe(1)
    expect(body.results).toHaveLength(1)
  })

  test('a body with no deviceIds at all is refused rather than reported as an empty success', async () => {
    const h = makeRouteHarness()
    const res = await h.app.request('/network/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIds: [], route: HTTP_PROXY }),
    })
    expect(res.status).toBe(400)
  })
})

describe('what counts as a failure, and what does not (plan 114 §3.9)', () => {
  test('E_SETTING_NOT_ACCEPTED lands as failed, carrying what was written and what the phone answered', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.phone('dev-1').ignoreWrites = true
    const { body } = await apply(h, ['dev-1'], HTTP_PROXY)
    const result = body.results[0]!
    expect(classifyDeviceNetworkApply(result)).toBe('failed')
    expect(result.error?.code).toBe('E_SETTING_NOT_ACCEPTED')
    expect(result.error?.message).toContain('127.0.0.1:8080')
    expect(result.status).toBeNull()
  })

  test('a successful apply whose health is unverified is APPLIED — the normal terminal state, never a failure', async () => {
    const listener = listenOnLoopback()
    try {
      const h = makeRouteHarness()
      h.seed('dev-1')
      const { body } = await apply(h, ['dev-1'], { engine: 'adb-proxy', host: '127.0.0.1', port: listener.port })
      const result = body.results[0]!
      expect(classifyDeviceNetworkApply(result)).toBe('applied')
      expect(result.error).toBeNull()
      expect(result.skip).toBeNull()
      expect((result.status as unknown as { health: string }).health).toBe('unverified')
      expect(body.results.filter((r) => classifyDeviceNetworkApply(r) === 'failed')).toHaveLength(0)
    } finally {
      listener.stop()
    }
  })

  test('rung 2 with an adb reverse that will not establish is failed with E_REVERSE_FAILED, not skipped', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.failReverse(() => true)
    const { body } = await apply(h, ['dev-1'], { engine: 'adb-reverse-proxy', hostPort: 9902 })
    const result = body.results[0]!
    expect(classifyDeviceNetworkApply(result)).toBe('failed')
    expect(result.error?.code).toBe('E_REVERSE_FAILED')
  })
})
