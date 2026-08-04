import { describe, expect, test } from 'bun:test'
import type {
  EgressProbeResult,
  HelloResult,
  PingResult,
  RouteStartResult,
  RouteStatusResult,
  RouteStopResult,
  Socks5RouteConfig,
} from '@enkaku/protocol'
import type { GuestAgentClient } from './client'
import { GuestAgentClientError } from './client'
import type { GuestAgentLauncher } from './launcher'
import { createGuestAgentSession, createVpnHelperRoute, type GuestAgentClientFactory, type GuestAgentSession } from './vpn-helper'

const CONFIG: Socks5RouteConfig = { host: 'proxy.example', port: 1080, udpMode: 'udp' }

/** A launcher fake that records every call and never touches adb for real. */
function fakeLauncher(overrides: Partial<GuestAgentLauncher> = {}): { launcher: GuestAgentLauncher; calls: string[] } {
  const calls: string[] = []
  const launcher: GuestAgentLauncher = {
    isInstalled: async () => true,
    ensureInstalled: async () => {
      calls.push('ensureInstalled')
    },
    ensurePreGranted: async () => {
      calls.push('ensurePreGranted')
    },
    bootstrap: async (token) => {
      calls.push(`bootstrap:${token}`)
    },
    forward: async (port) => {
      calls.push(`forward:${port}`)
    },
    removeForward: async (port) => {
      calls.push(`removeForward:${port}`)
    },
    stop: async () => {
      calls.push('stop')
    },
    ...overrides,
  }
  return { launcher, calls }
}

/** A minimal GuestAgentClient fake, plus a factory that hands out the same instance every time — good enough when a test only ever expects ONE bootstrap. */
function fakeClient(overrides: Partial<GuestAgentClient> = {}): { client: GuestAgentClient; factory: GuestAgentClientFactory } {
  const client: GuestAgentClient = {
    hello: async (): Promise<HelloResult> => ({
      protocol: 1,
      appVersion: '1.0.0',
      androidSdkInt: 35,
      capabilities: ['socks5-route', 'vpn-status'],
    }),
    ping: async (): Promise<PingResult> => ({ pong: true }),
    routeStart: async (): Promise<RouteStartResult> => ({ started: true }),
    routeStop: async (): Promise<RouteStopResult> => ({ stopped: true }),
    routeStatus: async (): Promise<RouteStatusResult> => ({ prepared: true, up: true }),
    egressProbe: async (): Promise<EgressProbeResult> => ({
      tunnelled: { ok: true, status: 200, body: '', ms: 1 },
      direct: { ok: true, status: 200, body: '', ms: 1 },
    }),
    ...overrides,
  }
  return { client, factory: () => client }
}

/** Claims sequential ports starting at 27400, and tracks whether one is currently held — mirrors `PortAllocator.claim/release`'s shape closely enough for a session test. */
function fakePorts() {
  let next = 27400
  let held: number | null = null
  return {
    claim: async () => {
      held = next++
      return held
    },
    release: (port: number) => {
      if (held === port) held = null
    },
    get held() {
      return held
    },
  }
}

/** Builds a session backed by `launcher`/`factory`, claiming ports from a fresh `fakePorts()` unless one is supplied (so a test can inspect port state after the fact). */
function fakeSession(
  launcher: GuestAgentLauncher,
  factory: GuestAgentClientFactory,
  ports: ReturnType<typeof fakePorts> = fakePorts(),
): { session: GuestAgentSession; ports: ReturnType<typeof fakePorts> } {
  const session = createGuestAgentSession({
    launcher,
    client: factory,
    claimPort: ports.claim,
    releasePort: ports.release,
    deviceId: 'dev-1',
  })
  return { session, ports }
}

describe('createVpnHelperRoute (plan 44 §4.4, §5.6; probe: plan 51 §4.2, §5.4)', () => {
  test('advertises id and capabilities with probe: true, and probe() is defined', () => {
    const { launcher } = fakeLauncher()
    const { factory } = fakeClient()
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })

    expect(route.id).toBe('vpn-helper')
    expect(route.capabilities).toEqual({ auth: true, enforcing: true, udp: true, probe: true })
    expect(route.probe).toBeInstanceOf(Function)
  })

  test('probe() sends the url/timeout through the shared session and returns both legs', async () => {
    const { launcher } = fakeLauncher()
    const { client, factory } = fakeClient()
    const seen: unknown[] = []
    client.egressProbe = async (url, timeoutMs) => {
      seen.push({ url, timeoutMs })
      return {
        tunnelled: { ok: true, status: 200, body: 'nonce=abc', ms: 200 },
        direct: { ok: true, status: 200, body: 'nonce=abc', ms: 30 },
      }
    }
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })

    const result = await route.probe?.('https://probe.example/x', 4000)
    expect(seen).toEqual([{ url: 'https://probe.example/x', timeoutMs: 4000 }])
    expect(result?.tunnelled.ok).toBe(true)
    expect(result?.direct.ok).toBe(true)
  })

  test('probe() lazily bootstraps a session with no prior apply() (mirrors observe()\'s plan 44 §8b "Bug 2" fix)', async () => {
    const { launcher, calls } = fakeLauncher()
    const { client, factory } = fakeClient()
    client.egressProbe = async () => ({
      tunnelled: { ok: false, ms: 10, error: 'no route is currently up', stage: 'connect' },
      direct: { ok: true, status: 200, ms: 12 },
    })
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })

    const result = await route.probe?.('https://probe.example/x', 4000)
    expect(result?.tunnelled.ok).toBe(false)
    expect(calls.some((c) => c.startsWith('bootstrap:'))).toBe(true)
  })

  test('apply() walks install → grant → bootstrap → forward → handshake → route.start, in order', async () => {
    const { launcher, calls } = fakeLauncher()
    const { client, factory } = fakeClient()
    const { session } = fakeSession(launcher, factory)
    const started: unknown[] = []
    client.routeStart = async (config) => {
      started.push(config)
      return { started: true }
    }

    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })
    await route.apply(CONFIG)

    expect(calls[0]).toBe('ensureInstalled')
    expect(calls[1]).toBe('ensurePreGranted')
    expect(calls[2]).toMatch(/^bootstrap:/)
    expect(calls[3]).toBe('forward:27400')
    expect(started).toEqual([CONFIG])
  })

  test('apply() called twice reuses the SAME session/token — no rotation (plan 44 §8b, "Bug 1")', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient()
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })

    await route.apply(CONFIG)
    await route.apply(CONFIG)

    const tokens = calls.filter((c) => c.startsWith('bootstrap:'))
    // Only ONE bootstrap ever happened — the second apply() reused the already-live client
    // instead of minting a fresh token (the exact defect plan 44 §8b's "Bug 1" describes).
    expect(tokens).toHaveLength(1)
  })

  test('observe() succeeds with no prior apply() in this process (plan 44 §8b, "Bug 2") — it lazily obtains a session', async () => {
    const { launcher } = fakeLauncher()
    const { client, factory } = fakeClient()
    client.routeStatus = async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080', stats: [1, 2, 3, 4] })
    const { session } = fakeSession(launcher, factory)

    // Note: apply() is never called on this route — only observe().
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })

    await expect(route.observe()).resolves.toEqual({
      prepared: true,
      up: true,
      upstream: 'proxy.example:1080',
      stats: [1, 2, 3, 4],
    })
  })

  test('observe() maps route.status verbatim onto a NetworkObservation', async () => {
    const { launcher } = fakeLauncher()
    const { client, factory } = fakeClient()
    client.routeStatus = async () => ({ prepared: true, up: true, upstream: 'proxy.example:1080', stats: [1, 2, 3, 4] })
    const { session } = fakeSession(launcher, factory)

    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })
    await route.apply(CONFIG)

    await expect(route.observe()).resolves.toEqual({
      prepared: true,
      up: true,
      upstream: 'proxy.example:1080',
      stats: [1, 2, 3, 4],
    })
  })

  test('a genuinely unreachable agent fails observe() with a coded error, not the old "before apply()" message', async () => {
    const { launcher } = fakeLauncher()
    const { factory } = fakeClient({
      hello: async () => {
        throw new GuestAgentClientError('E_TIMEOUT', 'guest agent did not respond within 15000ms')
      },
    })
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })

    const err = await route.observe().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GuestAgentClientError)
    expect((err as GuestAgentClientError).code).toBe('E_TIMEOUT')
  })

  test('revert() polls route.status until up === false — never trusts the stop acknowledgement', async () => {
    const { launcher, calls } = fakeLauncher()
    let statusCalls = 0
    const { client, factory } = fakeClient({
      routeStatus: async () => {
        statusCalls++
        // Mirrors the recorded defect (plan 44 §8b #1): the first couple of reads still say
        // up: true even though route.stop already replied { stopped: true }.
        return { prepared: true, up: statusCalls < 3 }
      },
    })
    const { session } = fakeSession(launcher, factory)

    const route = createVpnHelperRoute({
      launcher,
      session,
      apkPath: async () => '/apk',
      deviceId: 'dev-1',
      revertPollIntervalMs: 1,
      applySettleTimeoutMs: 0,
    revertPollTimeoutMs: 2000,
    })
    await route.apply(CONFIG)
    await route.revert()

    expect(statusCalls).toBeGreaterThanOrEqual(3)
    expect(calls).toContain('removeForward:27400')
  })

  test('revert() gives up after the poll budget elapses, and still removes the forward', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient({
      routeStatus: async () => ({ prepared: true, up: true }), // never goes down
    })
    const { session } = fakeSession(launcher, factory)

    const route = createVpnHelperRoute({
      launcher,
      session,
      apkPath: async () => '/apk',
      deviceId: 'dev-1',
      revertPollIntervalMs: 1,
      applySettleTimeoutMs: 0,
    revertPollTimeoutMs: 20,
    })
    await route.apply(CONFIG)
    await route.revert()

    expect(calls).toContain('removeForward:27400')
  })

  test('revert() called twice does not throw, and tolerates an unreachable agent', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient({
      routeStop: async () => {
        throw new Error('ECONNREFUSED — the device is gone')
      },
      routeStatus: async () => {
        throw new Error('ECONNREFUSED — the device is gone')
      },
    })
    const { session } = fakeSession(launcher, factory)

    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })
    await route.apply(CONFIG)

    await expect(route.revert()).resolves.toBeUndefined()
    await expect(route.revert()).resolves.toBeUndefined()
    // The SECOND revert() must not reconnect at all (the session was already closed by the
    // first) — so `removeForward` only fires once, not twice.
    expect(calls.filter((c) => c === 'removeForward:27400')).toHaveLength(1)
  })

  test('revert() before any apply()/observe() never throws, and never touches the device', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient()
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({ launcher, session, apkPath: async () => '/apk', deviceId: 'dev-1' })
    await expect(route.revert()).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  test('revert() tolerates removeForward itself throwing', async () => {
    const { launcher } = fakeLauncher({
      removeForward: async () => {
        throw new Error('adb: device offline')
      },
    })
    const { factory } = fakeClient({ routeStatus: async () => ({ prepared: true, up: false }) })
    const { session } = fakeSession(launcher, factory)
    const route = createVpnHelperRoute({
      launcher,
      session,
      apkPath: async () => '/apk',
      deviceId: 'dev-1',
      revertPollIntervalMs: 1,
      applySettleTimeoutMs: 0,
    revertPollTimeoutMs: 20,
    })
    await route.apply(CONFIG)
    await expect(route.revert()).resolves.toBeUndefined()
  })
})

describe('createGuestAgentSession (plan 44 §8b, "Bug 1" — one token per device, minted once and shared)', () => {
  test('two interleaved operations sharing the session do NOT invalidate each other’s token', async () => {
    const { launcher, calls } = fakeLauncher()
    const { client, factory } = fakeClient()
    const { session } = fakeSession(launcher, factory)

    // Simulates the reported bug: an applied route's client (via `withClient`) and a concurrent
    // "status probe" (a second, unrelated `withClient` call for the SAME device) interleave.
    const [a, b] = await Promise.all([session.withClient((c) => c.hello()), session.withClient((c) => c.ping())])

    expect(a.appVersion).toBe('1.0.0')
    expect(b.pong).toBe(true)
    // Exactly ONE bootstrap for the whole device — the second caller reused the client the first
    // one established, instead of minting a competing token.
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(1)
  })

  test('a handshake that fails with E_UNAUTHORISED triggers exactly one re-bootstrap, then succeeds', async () => {
    const { launcher, calls } = fakeLauncher()
    let routeStatusCalls = 0
    const { factory } = fakeClient({
      routeStatus: async () => {
        routeStatusCalls++
        if (routeStatusCalls === 1) {
          // The first call, on the original token, finds the agent has forgotten it (a genuine
          // on-device restart) — plan 44 §8b's "Bug 1" fix: this is the ONLY reason to rotate.
          throw new GuestAgentClientError('E_UNAUTHORISED', 'bad or missing token')
        }
        return { prepared: true, up: true }
      },
    })
    const { session } = fakeSession(launcher, factory)

    const status = await session.withClient((c) => c.routeStatus())
    expect(status.up).toBe(true)
    expect(routeStatusCalls).toBe(2)
    // Two bootstraps total: the original, plus exactly one re-auth — never more.
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(2)
  })

  test('E_NOT_PAIRED also triggers exactly one re-bootstrap', async () => {
    const { launcher, calls } = fakeLauncher()
    let pingCalls = 0
    const { factory } = fakeClient({
      ping: async () => {
        pingCalls++
        if (pingCalls === 1) throw new GuestAgentClientError('E_NOT_PAIRED', 'not paired')
        return { pong: true }
      },
    })
    const { session } = fakeSession(launcher, factory)

    const result = await session.withClient((c) => c.ping())
    expect(result.pong).toBe(true)
    expect(pingCalls).toBe(2)
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(2)
  })

  test('a second E_UNAUTHORISED after the re-bootstrap is NOT retried again — it propagates', async () => {
    const { launcher } = fakeLauncher()
    const { factory } = fakeClient({
      routeStatus: async () => {
        throw new GuestAgentClientError('E_UNAUTHORISED', 'bad or missing token')
      },
    })
    const { session } = fakeSession(launcher, factory)

    const err = await session.withClient((c) => c.routeStatus()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GuestAgentClientError)
    expect((err as GuestAgentClientError).code).toBe('E_UNAUTHORISED')
  })

  test('a non-auth error (E_TIMEOUT) is never treated as a reason to rotate the token', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient({
      routeStatus: async () => {
        throw new GuestAgentClientError('E_TIMEOUT', 'guest agent did not respond within 15000ms')
      },
    })
    const { session } = fakeSession(launcher, factory)

    const err = await session.withClient((c) => c.routeStatus()).catch((e: unknown) => e)
    expect((err as GuestAgentClientError).code).toBe('E_TIMEOUT')
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(1)
  })

  test('close() is idempotent, releases the port, and a later withClient() bootstraps again from scratch', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient()
    const { session, ports } = fakeSession(launcher, factory)

    await session.withClient((c) => c.hello())
    expect(session.active).toBe(true)
    expect(ports.held).toBe(27400)

    await session.close()
    await session.close() // idempotent — no throw, no double-release
    expect(session.active).toBe(false)
    expect(ports.held).toBeNull()
    expect(calls.filter((c) => c === 'removeForward:27400')).toHaveLength(1)

    await session.withClient((c) => c.hello())
    expect(calls.filter((c) => c.startsWith('bootstrap:'))).toHaveLength(2)
  })

  test('close() before any use never throws and never touches the launcher', async () => {
    const { launcher, calls } = fakeLauncher()
    const { factory } = fakeClient()
    const { session } = fakeSession(launcher, factory)
    await expect(session.close()).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })
})
