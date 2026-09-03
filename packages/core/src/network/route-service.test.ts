import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { E_DEVICE_CONFLICT, type NetworkEngineId, type PersistedNetworkRoute } from '@enkaku/protocol'
import { devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { assertNoHttpProxyAuth, ERROR_STATUS } from './route-service'
import { listenOnLoopback, makeRouteHarness, withCapturedIntervals, withFakeClock, type RouteHarness } from './route-service.fixture'

/**
 * Plan 114 steps 114.3/114.5/114.9 — the route service, end to end through its
 * own door, against a fake phone whose four `Settings.Global` keys are a Map
 * and a real reverse registry over a fake adb server (see
 * `route-service.fixture.ts`). No device is touched by any test in this file.
 *
 * The engines themselves are the REAL ones from `@enkaku/drivers`: capture,
 * write, read-back and restore all genuinely happen here, because a stubbed
 * engine would make every one of §3.6's assertions vacuous.
 */

interface CheckLike {
  id: string
  state: string
  detail?: string
}
interface StatusBody {
  engine: string
  config: Record<string, unknown> | null
  enabled: boolean
  health: string
  checks: CheckLike[]
  captured: { at: number } | null
  setBy: { kind: string; id: string; at: number } | null
  lastError: { code: string; message: string } | null
}

const checkOf = (body: StatusBody, id: string): CheckLike | undefined => body.checks.find((c) => c.id === id)

/**
 * Takes control of a device the way an operator at the device page does.
 * No mutating network endpoint requires this any more (plan 205 §2.4, §4.4:
 * `network-apply` allows over a live `control` marker) — kept, and still
 * called throughout this file, purely so a route write's `setBy`/marker
 * actor matches the same `userId` these tests already assert on.
 */
function hold(h: RouteHarness, deviceId: string, clientId = 'client-a', userId: string | null = 'u1'): void {
  h.activities.touchControl(deviceId, clientId, userId ? { kind: 'user', id: userId, label: userId } : { kind: 'user', id: clientId, label: 'a signed-out client' })
}

async function put(h: RouteHarness, deviceId: string, body: unknown): Promise<Response> {
  return h.app.request(`/${deviceId}/network`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function get(h: RouteHarness, deviceId: string): Promise<StatusBody> {
  const res = await h.app.request(`/${deviceId}/network`)
  return (await res.json()) as StatusBody
}

const persisted = (h: RouteHarness, deviceId: string): PersistedNetworkRoute | null => h.route(deviceId) as PersistedNetworkRoute | null

const writes = (h: RouteHarness, deviceId: string): string[] => h.phone(deviceId).execs.filter((c) => c.startsWith('settings put') || c.startsWith('settings delete'))

const HTTP_PROXY = { engine: 'adb-proxy' as const, host: '127.0.0.1', port: 8080 }
const VPN = { engine: 'vpn-helper' as const, host: 'proxy.example', port: 1080, udpMode: 'udp' as const }

// ---------------------------------------------------------------------------
// §3.8 — a credential is refused, never stripped
// ---------------------------------------------------------------------------

describe('assertNoHttpProxyAuth (plan 114 §3.8)', () => {
  const advisory: NetworkEngineId[] = ['adb-proxy', 'adb-reverse-proxy']

  test('refuses a username, a password, a stored credential and a pasted userinfo URL, for BOTH advisory engines', () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['username', { host: 'h', port: 8080, username: 'sam' }],
      ['password', { host: 'h', port: 8080, password: 'hunter2' }],
      ['credentialRef', { host: 'h', port: 8080, credentialRef: 'soax-jp' }],
      ['url userinfo', { host: 'http://sam:hunter2@h:8080', port: 8080 }],
      ['bare userinfo', { host: 'sam:hunter2@h', port: 8080 }],
    ]
    for (const engine of advisory) {
      for (const [name, body] of bodies) {
        let thrown: unknown = null
        try {
          assertNoHttpProxyAuth(body, engine)
        } catch (err) {
          thrown = err
        }
        expect(thrown, `${engine}/${name}`).toBeInstanceOf(EnkakuError)
        expect((thrown as EnkakuError).code, `${engine}/${name}`).toBe('E_HTTP_PROXY_NO_AUTH')
        // The refusal names where credentials DO go, rather than only saying no.
        expect((thrown as EnkakuError).message, `${engine}/${name}`).toContain("run it on this farm's machine")
      }
    }
    expect(ERROR_STATUS.E_HTTP_PROXY_NO_AUTH).toBe(400)
  })

  test('lets every one of them through for vpn-helper, whose credential has somewhere to live', () => {
    for (const body of [{ username: 'sam' }, { password: 'hunter2' }, { credentialRef: 'soax-jp' }, { host: 'http://sam:hunter2@h:1080' }]) {
      expect(() => assertNoHttpProxyAuth(body, 'vpn-helper')).not.toThrow()
    }
  })

  test('an empty string is not a credential, and a bare @ (no userinfo) is not one either', () => {
    expect(() => assertNoHttpProxyAuth({ username: '', password: '', credentialRef: '' }, 'adb-proxy')).not.toThrow()
    expect(() => assertNoHttpProxyAuth({ host: 'fe80::1%eth0' }, 'adb-proxy')).not.toThrow()
  })

  test('PUT refuses against the RAW body — 400, not 200 with the username silently stripped', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    const res = await put(h, 'dev-1', { ...HTTP_PROXY, username: 'sam' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'E_HTTP_PROXY_NO_AUTH' } })
    // Nothing was persisted and nothing was written to the phone.
    expect(persisted(h, 'dev-1')).toBeNull()
    expect(writes(h, 'dev-1')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §4.4 — the network-route lock
// ---------------------------------------------------------------------------

describe('assertLockFree — one route per device, enforced rather than assumed (plan 114 §4.4)', () => {
  test('a LIVE vpn route is reverted first when the device is switched to adb-proxy: one reverted, then one applied', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    expect((await put(h, 'dev-1', VPN)).status).toBe(200)
    h.events.length = 0

    expect((await put(h, 'dev-1', HTTP_PROXY)).status).toBe(200)
    expect(h.events.map((e) => e.kind)).toEqual(['network.reverted', 'network.applied'])
    expect(h.events[1]?.meta?.engine).toBe('adb-proxy')
    expect(persisted(h, 'dev-1')?.config.engine).toBe('adb-proxy')
  })

  test('a COLD vpn route (one this process never applied) is reverted through a freshly built engine, and says so', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    hold(h, 'dev-1')

    expect((await put(h, 'dev-1', HTTP_PROXY)).status).toBe(200)
    const reverted = h.events.filter((e) => e.kind === 'network.reverted')
    expect(reverted).toHaveLength(1)
    expect(reverted[0]?.meta).toMatchObject({ engine: 'vpn-helper', reason: 'engine-switch' })
    expect(persisted(h, 'dev-1')?.config.engine).toBe('adb-proxy')
  })

  test('a revert that throws refuses the new apply with E_ROUTE_LOCK_HELD/409 — the new config is neither persisted nor applied', async () => {
    const h = makeRouteHarness({ sessionCloseError: 'the forwarded port could not be released' })
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    hold(h, 'dev-1')

    const res = await put(h, 'dev-1', HTTP_PROXY)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_ROUTE_LOCK_HELD')
    expect(body.error.message).toContain('vpn-helper')
    // Neither persisted…
    expect(persisted(h, 'dev-1')?.config.engine).toBe('vpn-helper')
    // …nor applied: the phone was never written to.
    expect(writes(h, 'dev-1')).toHaveLength(0)
    expect(h.events.filter((e) => e.kind === 'network.applied')).toHaveLength(0)
  })

  test('re-applying the SAME engine reverts nothing — the lock is about a switch, not about every save', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    h.events.length = 0
    expect((await put(h, 'dev-1', { ...HTTP_PROXY, port: 9090 })).status).toBe(200)
    expect(h.events.map((e) => e.kind)).toEqual(['network.applied'])
  })
})

// ---------------------------------------------------------------------------
// §3.6 — capture once, restore what was found
// ---------------------------------------------------------------------------

describe('the capture (plan 114 §3.6)', () => {
  test('captured ONCE: a second apply never records the farm’s own value as the original', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.phone('dev-1').settings.set('http_proxy', 'operators.own.proxy:3128')
    h.phone('dev-1').settings.set('global_http_proxy_host', 'operators.own.proxy')
    h.phone('dev-1').settings.set('global_http_proxy_port', '3128')
    hold(h, 'dev-1')

    await put(h, 'dev-1', HTTP_PROXY)
    const first = persisted(h, 'dev-1')?.captured
    expect(first).toMatchObject({ httpProxy: 'operators.own.proxy:3128', host: 'operators.own.proxy', port: '3128', exclusionList: '' })

    await put(h, 'dev-1', { ...HTTP_PROXY, port: 9090 })
    expect(persisted(h, 'dev-1')?.captured).toEqual(first!)
  })

  test('Android’s literal string "null" is normalised to "" — a pristine phone captures as unset, not as the word null', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    expect(persisted(h, 'dev-1')?.captured).toMatchObject({ httpProxy: '', host: '', port: '', exclusionList: '' })
  })

  /**
   * The defensive branch in `captureStoreFor.write`: a capture that arrives for
   * a device with no route row is DROPPED with a warning rather than creating
   * one, because inventing a row here would make `enabled: true` alongside
   * `config: null` reachable. Only a concurrent clear can produce it, so the
   * fake phone simulates exactly that — it wipes the row from under the apply
   * on the first `settings get`.
   */
  test('a capture arriving with no route row to hold it is dropped with a warning, never persisted', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    const phone = h.phone('dev-1')
    const realPush = phone.execs.push.bind(phone.execs)
    phone.execs.push = (...cmds: string[]) => {
      if (cmds[0] === 'settings get global http_proxy' && !phone.execs.includes('settings get global http_proxy')) {
        h.db.update(devices).set({ networkRoute: null }).where(eq(devices.id, 'dev-1')).run()
      }
      return realPush(...cmds)
    }

    await put(h, 'dev-1', HTTP_PROXY)
    expect(persisted(h, 'dev-1')).toBeNull()
    expect(h.warns.some((w) => w.includes('with no route row to hold it'))).toBe(true)
  })
})

describe('DELETE /:id/network — off means the value the farm found (plan 114 §3.6)', () => {
  test('the capture is restored BEFORE the row is cleared, so the phone comes back as it was', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    phone.settings.set('global_http_proxy_exclusion_list', 'localhost')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    expect(phone.settings.get('http_proxy')).toBe('127.0.0.1:8080')

    const res = await h.app.request('/dev-1/network', { method: 'DELETE' })
    expect(res.status).toBe(200)
    // Restored, not cleared — impossible unless the capture was read before the row went.
    expect(phone.settings.get('http_proxy')).toBe('operators.own.proxy:3128')
    expect(phone.settings.get('global_http_proxy_exclusion_list')).toBe('localhost')
    expect(persisted(h, 'dev-1')).toBeNull()
  })

  test('with no capture at all the four keys are cleared, and the response’s captured is null', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'farm.set.this:8080')
    phone.settings.set('global_http_proxy_host', 'farm.set.this')
    phone.settings.set('global_http_proxy_port', '8080')
    phone.settings.set('global_http_proxy_exclusion_list', 'example.com')
    // A route that predates plan 114: config and enabled, and no capture.
    h.db
      .update(devices)
      .set({ networkRoute: { config: HTTP_PROXY, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    hold(h, 'dev-1')

    const body = (await (await h.app.request('/dev-1/network', { method: 'DELETE' })).json()) as StatusBody
    expect(body.captured).toBeNull()
    expect([...phone.settings.keys()]).toEqual([])
    expect(persisted(h, 'dev-1')).toBeNull()
  })

  test('a route WITH a capture reports captured: { at } while it is live, so the UI can word restore and clear differently', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    const body = await get(h, 'dev-1')
    expect(body.captured?.at).toBeGreaterThan(0)
  })
})

describe('revertNetwork — the advisory rungs need a cold revert and vpn-helper deliberately does not get one', () => {
  test('an advisory route with no live entry still reverts through a freshly built engine', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'farm.set.this:8080')
    h.db
      .update(devices)
      .set({
        networkRoute: { config: HTTP_PROXY, enabled: true, captured: { httpProxy: 'operators.own.proxy:3128', host: '', port: '', exclusionList: '', at: 10 } },
      })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await h.service.revertNetwork('dev-1', 'u1')
    expect(phone.settings.get('http_proxy')).toBe('operators.own.proxy:3128')
    expect(h.events.map((e) => e.kind)).toEqual(['network.reverted'])
  })

  /**
   * This test used to assert the opposite — that a cold `vpn-helper` route was
   * a no-op — and it was wrong, in a way that cut a real phone off the network.
   *
   * What happened on the owner's hardware: the core restarted (so
   * `networkStateByDevice` was empty), the operator pressed "turn off" in
   * Studio, the row was cleared, and the screen read `engine: none, enabled:
   * false`. The phone was never told. Its `RouteVpnService` stayed up with no
   * working tunnel, and because the route was `failClosed: true` the device
   * blocked **all** of its own traffic — no ping, no DNS, nothing — until the
   * service was force-stopped by hand.
   *
   * Fail-closed was not misbehaving: it holds when a tunnel breaks
   * unexpectedly, which is what losing a route looks like from the phone's
   * side. It was never told to stand down, because the farm's "off" never left
   * the core process. An operator pressing a button is not an unexpected
   * event.
   *
   * The "probe, do not blindly tear down" rule this test was defending is real
   * — it belongs to `restoreDeviceRoute`, which runs on reconnect. Every caller
   * of `revertNetwork` is an explicit operator action.
   */
  test('a COLD vpn-helper route is torn down on the device, not silently dropped — an operator pressing off must reach the phone', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await h.service.revertNetwork('dev-1', 'u1')

    // The device event log has to say a route went, or nothing downstream can
    // tell this apart from the row never having existed.
    expect(h.events.map((e) => e.kind)).toEqual(['network.reverted'])
  })

  test('reverting twice is safe and re-issues the same values rather than falling into the cleared path', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    await h.service.revertNetwork('dev-1', 'u1')
    await h.service.revertNetwork('dev-1', 'u1')
    expect(phone.settings.get('http_proxy')).toBe('operators.own.proxy:3128')
  })
})

// ---------------------------------------------------------------------------
// A teardown the phone never heard, and the admission pass that settles it
// ---------------------------------------------------------------------------

/**
 * **The measured incident.** A phone in the owner's farm was found routing all
 * of its HTTP traffic through a metered residential proxy — `http_proxy
 * 127.0.0.1:28100`, an `adb reverse` to the farm's bridge, an exit address in
 * the provider's pool — hours after it had last been touched, while the farm's
 * own screens showed nothing.
 *
 * Two mechanisms had to be told apart, and only one of them is a defect:
 *
 * - A route the RECORD still says is enabled coming back on reconnect is the
 *   legitimate restore, and the tests above cover it. That is not this.
 * - A route the record has already dropped surviving on the phone IS the
 *   defect, and it survives because **every engine's `revert()` is
 *   contractually silent about a device it could not reach** — `restoreAll()`
 *   puts each of its four writes behind a `.catch()`, and `vpn-helper.revert()`
 *   says nothing at all over a session that was never woken. So "off" was
 *   recorded, the row was erased, and the phone kept the proxy with nothing
 *   left on disk that remembered writing it.
 *
 * The fix is in two halves, and both are asserted here: the intent to clear
 * outlives the failed attempt (`pendingClear`), and admission reconciles in the
 * direction nobody had built — taking back what the record does not want,
 * rather than only putting back what it does.
 */
describe('a teardown the phone never heard (the pendingClear debt)', () => {
  test('DELETE against an unreachable phone keeps the row, records the debt, and does NOT report the revert as done', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    expect(phone.settings.get('http_proxy')).toBe('127.0.0.1:8080')

    phone.offline = true
    const res = await h.app.request('/dev-1/network', { method: 'DELETE' })
    expect(res.status).toBe(200)

    const row = persisted(h, 'dev-1')
    // The row is NOT erased: it is holding the capture the revert still owes this phone.
    expect(row?.enabled).toBe(false)
    expect(row?.captured?.httpProxy).toBe('operators.own.proxy:3128')
    expect(row?.pendingClear).toMatchObject({ engine: 'adb-proxy', forget: true })
    expect(row?.pendingClear?.reason).toContain('could not be read back')

    // "reverted" recorded for a phone that was never told is the honest-state rule broken in the
    // direction nobody notices, which is exactly how this incident lasted a day.
    const reverted = h.events.find((e) => e.kind === 'network.reverted')
    expect(reverted?.meta?.ok).toBe(false)
    expect(reverted?.meta?.pendingClear).toBe(true)

    // And it is on the wire, because a farm that knows and does not say is the same failure.
    const body = (await res.json()) as StatusBody & { pendingClear: { engine: string; reason: string } | null }
    expect(body.pendingClear?.engine).toBe('adb-proxy')
  })

  test('the next admission takes it back: the phone is restored, the row is erased, and it is a device event with a reason', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    phone.offline = true
    await h.app.request('/dev-1/network', { method: 'DELETE' })
    expect(persisted(h, 'dev-1')?.pendingClear).toBeTruthy()

    phone.offline = false
    await h.service.restoreDeviceRoute('dev-1')

    expect(phone.settings.get('http_proxy')).toBe('operators.own.proxy:3128')
    // `forget` travelled with the debt, so the DELETE the operator asked for finally completes.
    expect(persisted(h, 'dev-1')).toBeNull()
    const cleared = h.events.find((e) => e.kind === 'network.orphan.cleared')
    expect(cleared?.meta).toMatchObject({ engine: 'adb-proxy', restored: 'captured', forgot: true })
    expect(String(cleared?.meta?.reason)).toContain('could not be read back')
  })

  test('a disabled route the phone is still carrying is taken back even with no debt on record — and the row is kept, not erased', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    // A `/disable` from a core that died before it could tell the phone: the row says off, the
    // device still carries the farm's own value. No `pendingClear` exists to lead the way.
    h.db
      .update(devices)
      .set({ networkRoute: { ...persisted(h, 'dev-1')!, enabled: false } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    expect(phone.settings.get('http_proxy')).toBe('127.0.0.1:8080')

    await h.service.restoreDeviceRoute('dev-1')

    expect(phone.settings.get('http_proxy')).toBeUndefined()
    // A disable keeps the config so it can be switched back on — only the leftovers went.
    expect(persisted(h, 'dev-1')?.enabled).toBe(false)
    expect(persisted(h, 'dev-1')?.config).toMatchObject({ engine: 'adb-proxy' })
    expect(h.events.some((e) => e.kind === 'network.orphan.cleared')).toBe(true)
  })

  test('a proxy this farm did not write is left exactly where it is — evidence, never suspicion', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    h.db
      .update(devices)
      .set({ networkRoute: { ...persisted(h, 'dev-1')!, enabled: false } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    // Somebody set the phone's own proxy by hand after the farm's route went off.
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    phone.execs.length = 0

    await h.service.restoreDeviceRoute('dev-1')

    expect(phone.settings.get('http_proxy')).toBe('operators.own.proxy:3128')
    expect(writes(h, 'dev-1')).toHaveLength(0)
    expect(h.events.some((e) => e.kind === 'network.orphan.cleared')).toBe(false)
  })

  test('an ENABLED route still comes back on reconnect, and nothing is taken back — the bug is orphans, not restoration', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })
    const phone = h.phone('dev-1')
    // The phone came back blank — a factory-ish wipe, or a setting the user cleared by hand.
    phone.settings.clear()

    await h.service.restoreDeviceRoute('dev-1')

    expect(phone.settings.get('http_proxy')).toBe('127.0.0.1:28100')
    expect(h.reverse?.get('dev-1')?.devicePort).toBe(28100)
    expect(h.events.some((e) => e.kind === 'network.orphan.cleared')).toBe(false)
  })

  test('an adb reverse with no route on record behind it is torn down on admission, never re-established', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })
    // The row goes without the registry being told — a core that died between the two writes, or
    // any future path that forgets the release. The two stores now disagree, and the phone's is
    // the one carrying traffic.
    h.db.update(devices).set({ networkRoute: null }).where(eq(devices.id, 'dev-1')).run()
    h.adbCalls.length = 0

    await h.service.restoreDeviceRoute('dev-1')

    expect(h.reverse?.get('dev-1')).toBeNull()
    expect(h.adbCalls.some((c) => c.includes('--remove') && c.includes('tcp:28100'))).toBe(true)
    const cleared = h.events.find((e) => e.kind === 'network.orphan.cleared')
    expect(cleared?.meta).toMatchObject({ devicePort: 28100, restored: 'none' })
  })

  test('a route the record still wants is never released by the registry’s own admission pass', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })
    h.adbCalls.length = 0
    await h.reverse!.handleDeviceOnline('dev-1')
    expect(h.reverse?.get('dev-1')?.devicePort).toBe(28100)
    expect(h.adbCalls.some((c) => c.includes('--remove'))).toBe(false)
  })
})

/**
 * The cold `vpn-helper` teardown, which had the same shape of hole one layer
 * down: `vpn-helper.revert()` only talks to the device when `session.active`,
 * and a session built by the cold path has never been used. So "cold revert for
 * every engine" closed an unused session, wrote `network.reverted`, and left an
 * armed fail-closed `RouteVpnService` blocking every packet the phone tried to
 * send — the exact incident the cold revert was introduced to end.
 */
describe('the cold vpn-helper revert has to actually reach the agent', () => {
  function vpnRecorder(): { calls: string[]; client: Record<string, unknown> } {
    const calls: string[] = []
    return {
      calls,
      client: {
        routeStop: async () => {
          calls.push('stop')
          return { stopped: true }
        },
        routeStatus: async () => {
          calls.push('status')
          return { prepared: true, up: true, upstream: 'proxy.example:1080' }
        },
      },
    }
  }

  test('the agent is told to stop — a session nobody woke says nothing at all', async () => {
    const rec = vpnRecorder()
    const h = makeRouteHarness({ vpnClient: rec.client })
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await h.service.revertNetwork('dev-1', 'u1')

    expect(rec.calls).toContain('stop')
    expect(h.events.find((e) => e.kind === 'network.reverted')?.meta?.ok).toBe(true)
  })

  test('an unreachable phone records the debt instead of reporting the VPN off, and admission settles it', async () => {
    const rec = vpnRecorder()
    const h = makeRouteHarness({ vpnClient: rec.client })
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: false } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    h.phone('dev-1').offline = true

    await h.service.revertNetwork('dev-1', 'u1')
    expect(rec.calls).not.toContain('stop')
    expect(persisted(h, 'dev-1')?.pendingClear).toMatchObject({ engine: 'vpn-helper', forget: false })
    expect(h.events.find((e) => e.kind === 'network.reverted')?.meta?.ok).toBe(false)

    h.phone('dev-1').offline = false
    await h.service.restoreDeviceRoute('dev-1')
    expect(rec.calls).toContain('stop')
    expect(persisted(h, 'dev-1')?.pendingClear).toBeUndefined()
    expect(persisted(h, 'dev-1')?.enabled).toBe(false)
  })
})

/**
 * **Turning a route OFF while the device is offline — the case where turning it
 * off matters most.**
 *
 * The measured problem: two phones at another location, both `offline`, both
 * carrying an ENABLED route that would be re-applied the moment they
 * reconnected — one an `adb-reverse-proxy` pointed at a metered upstream, one a
 * `failClosed` `vpn-helper`. `DELETE /network` and `/network/disable` both
 * answered `409 device_unavailable`, so the operator's only route to "off" was
 * to wait for the phone, let the route re-arm, and turn it off afterwards.
 *
 * The gate (`requireNetworkAdmission`) predates the `pendingClear` debt and was
 * refusing the request before the machinery built for exactly this case could
 * run. `requireNetworkDisarmAdmission` lets the disarm direction through — and only
 * that direction, and only for a status no control marker can be taken on.
 */
describe('disarming a route the device is not there to hear (requireNetworkDisarmAdmission)', () => {
  /** The device the farm can no longer reach: offline on the record AND unreachable over adb. */
  function goOffline(h: RouteHarness, deviceId: string): void {
    h.db.update(devices).set({ status: 'offline' }).where(eq(devices.id, deviceId)).run()
    h.phone(deviceId).offline = true
  }

  test('DELETE on an offline device is accepted, records the debt with the reverse’s device port, and releases the reverse', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    hold(h, 'dev-1')
    await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9905 })
    expect(h.reverse?.get('dev-1')?.devicePort).toBe(28100)
    goOffline(h, 'dev-1')

    const res = await h.app.request('/dev-1/network', { method: 'DELETE' })
    expect(res.status).toBe(200)

    const row = persisted(h, 'dev-1')
    // The row survives: it is the only thing left holding the capture the revert still owes this
    // phone and the device port its reverse still has to be removed from.
    expect(row?.enabled).toBe(false)
    expect(row?.captured?.httpProxy).toBe('operators.own.proxy:3128')
    expect(row?.pendingClear).toMatchObject({ engine: 'adb-reverse-proxy', devicePort: 28100, forget: true })
    expect(row?.pendingClear?.reason).toContain('the device was offline')
    // Host-side bookkeeping goes immediately — it costs nothing to reach and it is the half that
    // would otherwise turn a leftover setting back into a live tunnel on reconnect.
    expect(h.reverse?.get('dev-1')).toBeNull()

    // The answer never claims a clean off.
    const body = (await res.json()) as StatusBody & { pendingClear: { engine: string; forget: boolean; reason: string } | null }
    expect(body.enabled).toBe(false)
    expect(body.pendingClear?.forget).toBe(true)
    expect(body.pendingClear?.reason).toContain('the device was offline')
    expect(h.events.find((e) => e.kind === 'network.reverted')?.meta?.ok).toBe(false)
  })

  test('the debt this door writes is settled by the SAME admission path as one from a failed live revert', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const phone = h.phone('dev-1')
    phone.settings.set('http_proxy', 'operators.own.proxy:3128')
    hold(h, 'dev-1')
    await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9905 })
    goOffline(h, 'dev-1')
    await h.app.request('/dev-1/network', { method: 'DELETE' })

    // The phone comes back.
    h.db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'dev-1')).run()
    phone.offline = false
    await h.service.restoreDeviceRoute('dev-1')

    // The pre-farm value, restored — not guessed, not cleared.
    expect(phone.settings.get('http_proxy')).toBe('operators.own.proxy:3128')
    // `forget` travelled with the debt, so the DELETE the operator asked for finally completes.
    expect(persisted(h, 'dev-1')).toBeNull()
    const cleared = h.events.find((e) => e.kind === 'network.orphan.cleared')
    expect(cleared?.meta).toMatchObject({ engine: 'adb-reverse-proxy', devicePort: 28100, restored: 'captured', forgot: true })
  })

  test('a failClosed VPN: the disarm reaches the RouteVpnService on admission, not just the bookkeeping', async () => {
    const calls: string[] = []
    const h = makeRouteHarness({
      vpnClient: {
        routeStop: async () => {
          calls.push('stop')
          return { stopped: true }
        },
        routeStatus: async () => {
          calls.push('status')
          return { prepared: true, up: true, upstream: 'proxy.example:1080' }
        },
      },
    })
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: VPN, enabled: true, failClosed: true }, status: 'offline' })
      .where(eq(devices.id, 'dev-1'))
      .run()
    h.phone('dev-1').offline = true

    const res = await h.app.request('/dev-1/network/disable', { method: 'POST' })
    expect(res.status).toBe(200)
    // Nothing was said to a phone that is not there — and the record says so rather than claiming
    // the kill switch was stood down.
    expect(calls).toEqual([])
    expect(persisted(h, 'dev-1')?.pendingClear).toMatchObject({ engine: 'vpn-helper', forget: false })
    expect(persisted(h, 'dev-1')?.pendingClear?.reason).toContain('never told to stop')
    expect(persisted(h, 'dev-1')?.enabled).toBe(false)
    const body = (await res.json()) as StatusBody & { pendingClear: { forget: boolean } | null }
    expect(body.pendingClear?.forget).toBe(false)

    // Admission: the session is WOKEN (`status`) so the `stop` that follows is a real one — the
    // difference between telling the agent to stand down and only writing it down here.
    h.db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'dev-1')).run()
    h.phone('dev-1').offline = false
    await h.service.restoreDeviceRoute('dev-1')

    expect(calls).toContain('status')
    expect(calls).toContain('stop')
    expect(persisted(h, 'dev-1')?.pendingClear).toBeUndefined()
    // A `/disable` keeps the config so it can be switched back on; only the debt went.
    expect(persisted(h, 'dev-1')?.enabled).toBe(false)
    expect(persisted(h, 'dev-1')?.config).toMatchObject({ engine: 'vpn-helper' })
  })

  test('the ENABLE direction stays refused — a route applied to a phone you cannot reach is a promise you cannot keep', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    await h.app.request('/dev-1/network/disable', { method: 'POST' })
    goOffline(h, 'dev-1')

    for (const [method, path] of [
      ['POST', '/dev-1/network/enable'],
      ['POST', '/dev-1/network/retry'],
    ] as const) {
      const res = await h.app.request(path, { method })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('device_unavailable')
    }
    const put409 = await put(h, 'dev-1', HTTP_PROXY)
    expect(put409.status).toBe(409)
    expect(((await put409.json()) as { error: { code: string } }).error.code).toBe('device_unavailable')
  })

  test('the gate is not widened generally: a job driving the phone is still refused, though a bare ONLINE device no longer needs a control marker at all', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)

    // Plan 205 §2.4, §4.4: turning a route off no longer requires holding
    // control at all — an online device with nothing else running just
    // succeeds, unlike the pre-205 lease-based gate this test used to assert.
    const noJob = await h.app.request('/dev-1/network', { method: 'DELETE' })
    expect(noJob.status).toBe(200)

    // Put it back so there is something to turn off again.
    await put(h, 'dev-1', HTTP_PROXY)

    // A job is driving that phone right now. Pulling its route out from under it is not a disarm,
    // it is a collision — and unlike offline/quarantined, this is a state the write CAN happen in
    // once the job ends, so the refusal is an instruction rather than a dead end.
    h.activities.start('dev-1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    const busy = await h.app.request('/dev-1/network/disable', { method: 'POST' })
    expect(busy.status).toBe(409)
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe(E_DEVICE_CONFLICT)
  })
})

// ---------------------------------------------------------------------------
// §4.5 — /retry, and the untagged body Studio still sends
// ---------------------------------------------------------------------------

describe('POST /:id/network/retry (plan 114 §4.5)', () => {
  test('refused on an advisory rung with E_NOT_SUPPORTED/409, saying what to do instead', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    const res = await h.app.request('/dev-1/network/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_NOT_SUPPORTED')
    expect(body.error.message).toContain('Save the route again')
  })

  test('unchanged for vpn-helper — it still clears the bound and applies once', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', VPN)
    h.events.length = 0
    const res = await h.app.request('/dev-1/network/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(h.events.map((e) => e.kind)).toEqual(['network.applied'])
  })
})

test('an untagged SOCKS5 body — what Studio sends today — still applies as vpn-helper', async () => {
  const h = makeRouteHarness()
  h.seed('dev-1')
  hold(h, 'dev-1')
  const res = await put(h, 'dev-1', { host: 'proxy.example', port: 1080, udpMode: 'udp' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as StatusBody
  expect(body.engine).toBe('vpn-helper')
  expect(persisted(h, 'dev-1')?.config.engine).toBe('vpn-helper')
})

// ---------------------------------------------------------------------------
// §3.3 — setBy, and the one door
// ---------------------------------------------------------------------------

describe('setBy — attribution, never a lock (plan 114 §3.3)', () => {
  test('a plain id is a user; a plugin: principal is a plugin with the prefix stripped', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    expect(persisted(h, 'dev-1')?.setBy).toMatchObject({ kind: 'user', id: 'u1' })

    h.events.length = 0
    await h.service.device.set('dev-1', { ...HTTP_PROXY, port: 9090 }, 'plugin:proxy-manager')
    expect(persisted(h, 'dev-1')?.setBy).toMatchObject({ kind: 'plugin', id: 'proxy-manager' })
    // The event's actor is the PREFIXED principal — that is what the audit log is keyed by —
    // while `setBy.id` is the plugin's own name, which is what the panel renders.
    expect(h.events.at(-1)?.actor).toBe('plugin:proxy-manager')
    expect(persisted(h, 'dev-1')?.setBy?.id).toBe('proxy-manager')
  })

  test('a core re-apply (actor: null) writes no setBy and does not clear the one already there', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    await put(h, 'dev-1', HTTP_PROXY)
    const before = persisted(h, 'dev-1')?.setBy
    expect(before).toMatchObject({ kind: 'user', id: 'u1' })

    // Something outside the farm changed the setting; the reconnect pass re-applies it.
    h.phone('dev-1').settings.set('http_proxy', 'someone.else:1')
    h.events.length = 0
    await h.service.restoreDeviceRoute('dev-1')
    const applied = h.events.filter((e) => e.kind === 'network.applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]?.actor).toBeNull()
    expect(persisted(h, 'dev-1')?.setBy).toEqual(before!)
  })

  test('a route written before plan 114 reports setBy: null rather than inventing an actor', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: HTTP_PROXY, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    expect((await get(h, 'dev-1')).setBy).toBeNull()
  })
})

describe('the one door — RouteService.device.set is PUT’s own body, not a second path', () => {
  test('device.set and PUT write byte-identical rows for the same body', async () => {
    await withFakeClock(1_700_000_000_000, async () => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      h.seed('dev-2')
      hold(h, 'dev-1', 'client-a', 'u1')
      hold(h, 'dev-2', 'client-b', 'u1')

      await put(h, 'dev-1', HTTP_PROXY)
      await h.service.device.set('dev-2', HTTP_PROXY, 'u1')

      expect(JSON.stringify(persisted(h, 'dev-2'))).toBe(JSON.stringify(persisted(h, 'dev-1')))
    })
  })

  test('device.set refuses while a job is driving the device — the same activity policy the endpoint takes', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.activities.start('dev-1', { id: 'job:j1', kind: 'job', label: 'Running x', actor: { kind: 'system', id: 'core', label: 'Scheduler' } })
    await expect(h.service.device.set('dev-1', HTTP_PROXY, 'u1')).rejects.toMatchObject({ code: E_DEVICE_CONFLICT })
    expect(persisted(h, 'dev-1')).toBeNull()
    expect(h.phone('dev-1').execs).toHaveLength(0)
  })

  test('device.clear reverts and forgets, exactly as DELETE does', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.phone('dev-1').settings.set('http_proxy', 'operators.own.proxy:3128')
    hold(h, 'dev-1')
    await h.service.device.set('dev-1', HTTP_PROXY, 'u1')
    await h.service.device.clear('dev-1', 'u1')
    expect(persisted(h, 'dev-1')).toBeNull()
    expect(h.phone('dev-1').settings.get('http_proxy')).toBe('operators.own.proxy:3128')
  })
})

// ---------------------------------------------------------------------------
// rung 2 — the reverse
// ---------------------------------------------------------------------------

describe('adb-reverse-proxy (plan 114 §4.3, step 114.5)', () => {
  test('a core with no reverse registry refuses by name and writes nothing to the device', async () => {
    const h = makeRouteHarness({ withoutReverse: true })
    h.seed('dev-1')
    hold(h, 'dev-1')
    const res = await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'E_NOT_SUPPORTED' } })
    expect(writes(h, 'dev-1')).toHaveLength(0)
  })

  test('PUT establishes the reverse, persists the allocation, and the GET config carries the device port', async () => {
    const listener = listenOnLoopback()
    try {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      const res = await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: listener.port })
      expect(res.status).toBe(200)

      const row = persisted(h, 'dev-1')
      expect(row?.reverse).toMatchObject({ devicePort: 28100, hostPort: listener.port })
      expect(row?.reverse?.at).toBeGreaterThan(0)
      expect(h.phone('dev-1').settings.get('http_proxy')).toBe('127.0.0.1:28100')

      const body = await get(h, 'dev-1')
      expect(body.config).toMatchObject({ engine: 'adb-reverse-proxy', hostPort: listener.port, devicePort: 28100 })
      expect(checkOf(body, 'reverse')?.state).toBe('pass')
      expect(checkOf(body, 'upstream')?.state).toBe('pass')
      expect(checkOf(body, 'setting')?.state).toBe('pass')
      // Everything that CAN pass has, and health is still only `unverified` (criterion 3).
      expect(body.health).toBe('unverified')
    } finally {
      listener.stop()
    }
  })

  test('reverse: fail the moment establishedAt is null — reported without an `adb reverse --list` call at all (criterion 10)', async () => {
    await withFakeClock(1_700_000_000_000, async (advance) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })

      // The phone went away and came back: the registry knows the tunnel is not live.
      h.reverse!.handleDeviceOffline('dev-1')
      h.adbCalls.length = 0
      advance(11_000)

      const body = await get(h, 'dev-1')
      const reverse = checkOf(body, 'reverse')
      expect(reverse?.state).toBe('fail')
      expect(reverse?.detail).toContain('not live')
      expect(h.adbCalls.filter((c) => c.includes('--list'))).toHaveLength(0)
    })
  })

  test('reverse: fail with no entry at all, naming that the tunnel was never established', async () => {
    await withFakeClock(1_700_000_000_000, async (advance) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })
      await h.reverse!.release('dev-1')
      advance(11_000)

      const reverse = checkOf(await get(h, 'dev-1'), 'reverse')
      expect(reverse?.state).toBe('fail')
      expect(reverse?.detail).toContain('has not been established')
    })
  })

  test('a failed adb reverse fails the apply with E_REVERSE_FAILED and leaves the phone unwritten', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    hold(h, 'dev-1')
    h.failReverse(() => true)
    const res = await put(h, 'dev-1', { engine: 'adb-reverse-proxy', hostPort: 9902 })
    expect(res.status).toBe(502)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'E_REVERSE_FAILED' } })
    expect(writes(h, 'dev-1')).toHaveLength(0)
    // The intent survives the failure, which is what lets the restore pass allocate one later.
    expect(persisted(h, 'dev-1')?.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §3.7 — restore, and what the farm promises
// ---------------------------------------------------------------------------

describe('restoreDeviceRoute on an advisory route (plan 114 §3.7)', () => {
  test('a matching read-back writes nothing — probe first, never blindly re-apply', async () => {
    await withFakeClock(1_700_000_000_000, async (advance) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', HTTP_PROXY)
      advance(11_000)
      h.phone('dev-1').execs.length = 0

      await h.service.restoreDeviceRoute('dev-1')
      expect(writes(h, 'dev-1')).toHaveLength(0)
      expect(h.phone('dev-1').execs.length).toBeGreaterThan(0)
    })
  })

  test('a mismatching read-back re-applies exactly once', async () => {
    await withFakeClock(1_700_000_000_000, async (advance) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', HTTP_PROXY)
      advance(11_000)
      h.phone('dev-1').settings.set('http_proxy', 'someone.else:1')
      h.phone('dev-1').execs.length = 0

      await h.service.restoreDeviceRoute('dev-1')
      expect(h.phone('dev-1').execs.filter((c) => c === "settings put global http_proxy '127.0.0.1:8080'")).toHaveLength(1)
      expect(h.phone('dev-1').settings.get('http_proxy')).toBe('127.0.0.1:8080')
    })
  })

  test('an unreachable phone writes nothing, keeps the route enabled, and never reports setting: pass', async () => {
    await withFakeClock(1_700_000_000_000, async (advance) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', HTTP_PROXY)
      advance(11_000)
      h.phone('dev-1').offline = true
      h.phone('dev-1').execs.length = 0

      await h.service.restoreDeviceRoute('dev-1')
      expect(writes(h, 'dev-1')).toHaveLength(0)
      expect(persisted(h, 'dev-1')?.enabled).toBe(true)

      const setting = checkOf(await get(h, 'dev-1'), 'setting')
      expect(setting?.state).not.toBe('pass')
      expect(['fail', 'unknown']).toContain(setting!.state)
    })
  })

  /**
   * The one advisory case that re-applies without comparing: an enabled rung-2
   * route with no device port has nothing to compare against, and applying is
   * what allocates one. Left alone it would compare an unset setting against an
   * empty declaration and look settled forever.
   */
  test('an enabled rung-2 route with no allocation re-applies rather than reporting itself settled', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: { engine: 'adb-reverse-proxy', hostPort: 9902 }, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    await h.service.restoreDeviceRoute('dev-1')
    expect(persisted(h, 'dev-1')?.reverse?.devicePort).toBe(28100)
    expect(h.phone('dev-1').settings.get('http_proxy')).toBe('127.0.0.1:28100')
    expect(h.adbCalls.some((c) => c.includes('tcp:28100'))).toBe(true)
  })

  test('a disabled route is left alone entirely', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.db
      .update(devices)
      .set({ networkRoute: { config: HTTP_PROXY, enabled: false } })
      .where(eq(devices.id, 'dev-1'))
      .run()
    await h.service.restoreDeviceRoute('dev-1')
    expect(h.phone('dev-1').execs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §4.4 — the heartbeat stays VPN-only, and the GET does the reading instead
// ---------------------------------------------------------------------------

describe('the heartbeat (plan 114 §4.4)', () => {
  test('does not start at all for a farm whose only enabled routes are advisory', async () => {
    await withCapturedIntervals(async (started) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', HTTP_PROXY)
      await h.service.reconcileNetworkRoutes()
      expect(started).toHaveLength(0)
    })
  })

  test('never touches an advisory route: several ticks make zero exec calls on that phone', async () => {
    await withCapturedIntervals(async (started) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      h.seed('dev-2')
      hold(h, 'dev-1', 'client-a', 'u1')
      hold(h, 'dev-2', 'client-b', 'u1')
      await put(h, 'dev-1', HTTP_PROXY)
      await put(h, 'dev-2', VPN)
      // One timer for the whole daemon, started by the VPN route and nothing else.
      expect(started).toHaveLength(1)

      h.phone('dev-1').execs.length = 0
      for (let i = 0; i < 3; i++) started[0]!.handler()
      await new Promise((r) => setTimeout(r, 10))
      expect(h.phone('dev-1').execs).toHaveLength(0)
    })
  })
})

describe('GET /:id/network for an advisory route', () => {
  test('the read-back is throttled to one set of four `settings get` calls inside 10s', async () => {
    await withFakeClock(1_700_000_000_000, async (advance) => {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', HTTP_PROXY)

      h.phone('dev-1').execs.length = 0
      await get(h, 'dev-1')
      await get(h, 'dev-1')
      // Both reads are inside the window the apply's own observation opened.
      expect(h.phone('dev-1').execs).toHaveLength(0)

      advance(11_000)
      await get(h, 'dev-1')
      expect(h.phone('dev-1').execs.filter((c) => c.startsWith('settings get'))).toHaveLength(4)
      await get(h, 'dev-1')
      expect(h.phone('dev-1').execs.filter((c) => c.startsWith('settings get'))).toHaveLength(4)
    })
  })

  test('an offline device is never dialled at all', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1', { status: 'offline' })
    h.db
      .update(devices)
      .set({ networkRoute: { config: HTTP_PROXY, enabled: true } })
      .where(eq(devices.id, 'dev-1'))
      .run()

    const body = await get(h, 'dev-1')
    expect(h.phone('dev-1').execs).toHaveLength(0)
    expect(body.engine).toBe('adb-proxy')
    expect(body.health).not.toBe('ok')
  })

  test('a device with no route at all reports engine none and health unknown', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    const body = await get(h, 'dev-1')
    expect(body).toMatchObject({ engine: 'none', config: null, enabled: false, health: 'unknown', captured: null, setBy: null })
  })

  test('health is unverified — never ok — for a fully working adb-proxy route, and every check detail avoids the forbidden words', async () => {
    const listener = listenOnLoopback()
    try {
      const h = makeRouteHarness()
      h.seed('dev-1')
      hold(h, 'dev-1')
      await put(h, 'dev-1', { engine: 'adb-proxy', host: '127.0.0.1', port: listener.port })
      const body = await get(h, 'dev-1')
      expect(checkOf(body, 'setting')?.state).toBe('pass')
      expect(checkOf(body, 'upstream')?.state).toBe('pass')
      expect(body.health).toBe('unverified')
      for (const check of body.checks) {
        if (check.detail) expect(check.detail, check.detail).not.toMatch(/\b(routed|ok|success|successful|successfully|enabled)\b/i)
      }
    } finally {
      listener.stop()
    }
  })
})

describe('a write the device declines (plan 114 §3.9)', () => {
  test('is E_SETTING_NOT_ACCEPTED — a failed apply, never applied-but-unverified', async () => {
    const h = makeRouteHarness()
    h.seed('dev-1')
    h.phone('dev-1').ignoreWrites = true
    hold(h, 'dev-1')
    const res = await put(h, 'dev-1', HTTP_PROXY)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('E_SETTING_NOT_ACCEPTED')
    expect(body.error.message).toContain('(unset)')
    expect(h.events.filter((e) => e.kind === 'network.applied' && e.meta?.ok === false)).toHaveLength(1)
  })
})
