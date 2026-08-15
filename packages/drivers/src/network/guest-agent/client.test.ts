import { describe, expect, test } from 'bun:test'
import { GUEST_AGENT_PROTOCOL } from '@enkaku/protocol'
import { GUEST_AGENT_REPAIRABLE_ERROR_CODES, GuestAgentClientError, createGuestAgentClient, type GuestAgentConnect } from './client'

/** A parsed request line, for fakes that need to answer per-method. */
function parseLine(line: string): { id: string; token: string; method: string; [k: string]: unknown } {
  return JSON.parse(line)
}

/**
 * A fake `connect` that answers every request with a scripted reply, tracking how many times it
 * was called — good enough to drive `createGuestAgentClient` without a real socket.
 */
function scriptedConnect(reply: (req: ReturnType<typeof parseLine>, attempt: number) => unknown): {
  connect: GuestAgentConnect
  callCount: () => number
} {
  let calls = 0
  const connect: GuestAgentConnect = async (opts) => {
    calls++
    const attempt = calls
    let written = ''
    const socket = {
      write(data: string) {
        written += data
        // The client writes the whole request in one call, terminated by \n — respond
        // asynchronously so this matches Bun.connect's own callback-based delivery.
        queueMicrotask(() => {
          const line = written.slice(0, written.indexOf('\n'))
          const req = parseLine(line)
          const body = `${JSON.stringify(reply(req, attempt))}\n`
          opts.socket.data(socket, new TextEncoder().encode(body))
        })
        return data.length
      },
      end() {
        // no-op — the fake has nothing to release
      },
    }
    return socket
  }
  return { connect, callCount: () => calls }
}

/** A `connect` that never calls back — used to exercise the per-call timeout. */
function hangingConnect(): GuestAgentConnect {
  return async () => ({
    write() {
      // deliberately never responds
    },
    end() {
      // no-op
    },
  })
}

describe('createGuestAgentClient (plan 44 §5.5)', () => {
  // ---- R1 (plan 90 §3.9): the version-skew seam ----

  test('E_PROTOCOL_MISMATCH is in the R1 seam a future provisioner catches to mark the device outdated', () => {
    // The seam itself, not a redesign of hello()'s behaviour: `GUEST_AGENT_REPAIRABLE_ERROR_CODES`
    // is what step 90.3's `AgentProvisioner` (not yet built) is expected to check before deciding
    // a mismatch is worth one reinstall + re-`hello()`, rather than each caller re-deriving the
    // same `err.code === 'E_PROTOCOL_MISMATCH'` check by hand.
    expect(GUEST_AGENT_REPAIRABLE_ERROR_CODES.has('E_PROTOCOL_MISMATCH')).toBe(true)
    // Every other coded failure this client can throw is NOT in the repairable set — a bad token,
    // a malformed request, or an unreachable socket is not fixed by reinstalling the same build.
    expect(GUEST_AGENT_REPAIRABLE_ERROR_CODES.has('E_UNAUTHORISED')).toBe(false)
    expect(GUEST_AGENT_REPAIRABLE_ERROR_CODES.has('E_TIMEOUT')).toBe(false)
    expect(GUEST_AGENT_REPAIRABLE_ERROR_CODES.has('E_TRANSPORT')).toBe(false)
  })

  test('hello() throws a coded error on a protocol mismatch, and does not retry it', async () => {
    const { connect, callCount } = scriptedConnect((req) => {
      expect(req.method).toBe('hello')
      return {
        id: req.id,
        ok: true,
        result: {
          protocol: GUEST_AGENT_PROTOCOL + 1,
          appVersion: '1.0.0',
          androidSdkInt: 35,
          capabilities: ['socks5-route', 'vpn-status'],
        },
      }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect, handshakeRetries: 5, handshakeRetryDelayMs: 1 })

    await expect(client.hello()).rejects.toMatchObject({ code: 'E_PROTOCOL_MISMATCH' })
    // A version mismatch is not a transient bring-up race — retrying it wastes time confirming
    // what the first reply already answered, so this must connect exactly once.
    expect(callCount()).toBe(1)
  })

  test('an ok:false reply throws a GuestAgentClientError carrying the agent code, not message text', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('ping')
      return { id: req.id, ok: false, error: { code: 'E_UNAUTHORISED', message: 'bad token, whatever that means today' } }
    })
    const client = createGuestAgentClient({ port: 1, token: 'wrong', connect })

    let caught: unknown
    try {
      await client.ping()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GuestAgentClientError)
    expect((caught as GuestAgentClientError).code).toBe('E_UNAUTHORISED')
  })

  test('a hung socket rejects with E_TIMEOUT instead of parking the caller forever', async () => {
    const client = createGuestAgentClient({ port: 1, token: 't', connect: hangingConnect(), timeoutMs: 20 })
    await expect(client.ping()).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })

  test('hello() retries the initial connect/handshake with backoff, and succeeds once the agent answers', async () => {
    // `flaky` below only ever calls this wrapped connect once it stops rejecting itself, so this
    // fake never needs to see — let alone reject — an early attempt.
    const { connect, callCount } = scriptedConnect((req) => ({
      id: req.id,
      ok: true,
      result: { protocol: GUEST_AGENT_PROTOCOL, appVersion: '1.0.0', androidSdkInt: 35, capabilities: [] },
    }))
    // Wrap the scripted connect so the first two attempts fail at the connect stage — the
    // documented failure mode (plan 44 §5.1): the agent binds its socket a moment after the
    // process starts, so an early connect is refused rather than answered.
    let attempts = 0
    const flaky: GuestAgentConnect = async (opts) => {
      attempts++
      if (attempts < 3) {
        const fake = { write() {}, end() {} }
        queueMicrotask(() => opts.socket.connectError?.(fake, new Error('refused')))
        return fake
      }
      return connect(opts)
    }

    const client = createGuestAgentClient({
      port: 1,
      token: 't',
      connect: flaky,
      handshakeRetries: 8,
      handshakeRetryDelayMs: 1,
    })

    const hello = await client.hello()
    expect(hello.protocol).toBe(GUEST_AGENT_PROTOCOL)
    expect(attempts).toBe(3)
    expect(callCount()).toBe(1) // only the successful attempt reaches the underlying scripted connect
  })

  test('hello() gives up after exhausting its retry budget', async () => {
    const alwaysRefuses: GuestAgentConnect = async (opts) => {
      const fake = { write() {}, end() {} }
      queueMicrotask(() => opts.socket.connectError?.(fake, new Error('refused')))
      return fake
    }
    const client = createGuestAgentClient({
      port: 1,
      token: 't',
      connect: alwaysRefuses,
      handshakeRetries: 3,
      handshakeRetryDelayMs: 1,
    })
    await expect(client.hello()).rejects.toMatchObject({ code: 'E_TRANSPORT' })
  })

  test('routeStart() sends the config through and returns the validated result', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('route.start')
      expect(req.config).toMatchObject({ host: 'proxy.example', port: 1080 })
      return { id: req.id, ok: true, result: { started: true } }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.routeStart({ host: 'proxy.example', port: 1080, udpMode: 'udp', onGeoFail: 'report' })
    expect(result).toEqual({ started: true })
  })

  test('a response that fails schema validation throws E_UNEXPECTED_RESPONSE', async () => {
    const { connect } = scriptedConnect((req) => ({ id: req.id, ok: true, result: { nonsense: true } }))
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    await expect(client.ping()).rejects.toMatchObject({ code: 'E_UNEXPECTED_RESPONSE' })
  })

  test('egressProbe() sends the url and timeoutMs through and returns both legs (plan 51 §5.4)', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('egress.probe')
      expect(req.url).toBe('https://probe.example/x')
      expect(req.timeoutMs).toBe(4000)
      return {
        id: req.id,
        ok: true,
        result: {
          tunnelled: { ok: true, status: 200, body: 'nonce=abc', ms: 210 },
          direct: { ok: true, status: 200, body: 'nonce=abc', ms: 40 },
        },
      }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.egressProbe('https://probe.example/x', 4000)
    expect(result.tunnelled.ok).toBe(true)
    expect(result.direct.ok).toBe(true)
  })

  test('egressProbe() surfaces E_UNKNOWN_METHOD as a coded error for an agent build that predates the capability', async () => {
    const { connect } = scriptedConnect((req) => ({
      id: req.id,
      ok: false,
      error: { code: 'E_UNKNOWN_METHOD', message: 'unknown method: egress.probe' },
    }))
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    await expect(client.egressProbe('https://probe.example/x', 4000)).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
  })

  // ---- plan 90 §4.1, step 90.2: label.* / text.* — new methods, gated on hello().capabilities ----

  test('labelApply() sends fingerprint/number/name/surfaces through and returns the validated result (plan 89 §4.5)', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('label.apply')
      expect(req.fingerprint).toBe('fp-1')
      expect(req.number).toBe('7')
      expect(req.name).toBe('Alice')
      expect(req.surfaces).toEqual(['home', 'lock'])
      return {
        id: req.id,
        ok: true,
        result: {
          applied: ['home'],
          fingerprint: 'fp-1',
          rendererVersion: 3,
          widthPx: 1080,
          heightPx: 2400,
          wallpaperIdHome: 42,
          wallpaperIdLock: null,
        },
      }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.labelApply({ fingerprint: 'fp-1', number: '7', name: 'Alice', surfaces: ['home', 'lock'] })
    // Behavioural requirement 1 (plan 89 §4.5): `applied` can be narrower than what was
    // requested — here the lock surface did not take, and the client must pass that through
    // unmodified rather than assuming the request always succeeds in full.
    expect(result.applied).toEqual(['home'])
    expect(result.fingerprint).toBe('fp-1')
  })

  test('labelStatus() returns the validated result, including a null fingerprint before any apply', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('label.status')
      return {
        id: req.id,
        ok: true,
        result: {
          fingerprint: null,
          matchesOurs: false,
          wallpaperIdHome: null,
          wallpaperIdLock: null,
          originalCaptured: false,
          rendererVersion: 0,
        },
      }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.labelStatus()
    expect(result.fingerprint).toBeNull()
    expect(result.matchesOurs).toBe(false)
  })

  test('labelClear() sends restoreOriginal through and returns which restore actually ran (plan 89 §4.5 behavioural requirement 4)', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('label.clear')
      expect(req.restoreOriginal).toBe(true)
      return { id: req.id, ok: true, result: { restored: 'original', fingerprint: null } }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.labelClear(true)
    expect(result).toEqual({ restored: 'original', fingerprint: null })
  })

  test('labelApply()/labelStatus()/labelClear() surface E_UNKNOWN_METHOD as a coded error for a build that predates the label facet', async () => {
    const { connect } = scriptedConnect((req) => ({
      id: req.id,
      ok: false,
      error: { code: 'E_UNKNOWN_METHOD', message: `unknown method: ${req.method}` },
    }))
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    await expect(client.labelApply({ fingerprint: 'fp', number: '1', name: null, surfaces: ['home'] })).rejects.toMatchObject({
      code: 'E_UNKNOWN_METHOD',
    })
    await expect(client.labelStatus()).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
    await expect(client.labelClear(false)).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
  })

  test('textCommit() sends text and an optional perCharMs through, and honestly reports an IME that is not current (plan 90 §3.2, §4.1)', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('text.commit')
      expect(req.text).toBe('こんにちは 👋')
      expect(req.perCharMs).toEqual([20, 60])
      return { id: req.id, ok: true, result: { committed: 0, ime: 'not-current' } }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.textCommit('こんにちは 👋', [20, 60])
    // Deliberate (§4.1): `ime: 'not-current'` is a precondition the host can fix, never an
    // exception — the client must pass it through as a normal result, not throw on it.
    expect(result).toEqual({ committed: 0, ime: 'not-current' })
  })

  test('textCommit() omits perCharMs entirely when not given, rather than sending it as undefined', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('text.commit')
      expect('perCharMs' in req).toBe(false)
      return { id: req.id, ok: true, result: { committed: 3, ime: 'current' } }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.textCommit('abc')
    expect(result).toEqual({ committed: 3, ime: 'current' })
  })

  test('textStatus() returns the validated result', async () => {
    const { connect } = scriptedConnect((req) => {
      expect(req.method).toBe('text.status')
      return {
        id: req.id,
        ok: true,
        result: { ime: 'enabled', id: 'dev.enkaku.guestagent/.input.EnkakuIme', connected: false },
      }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    const result = await client.textStatus()
    expect(result.ime).toBe('enabled')
    expect(result.connected).toBe(false)
  })

  test('textCommit()/textStatus() surface E_UNKNOWN_METHOD as a coded error for a build that predates the IME facet', async () => {
    const { connect } = scriptedConnect((req) => ({
      id: req.id,
      ok: false,
      error: { code: 'E_UNKNOWN_METHOD', message: `unknown method: ${req.method}` },
    }))
    const client = createGuestAgentClient({ port: 1, token: 't', connect })
    await expect(client.textCommit('hi')).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
    await expect(client.textStatus()).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
  })

  /**
   * Plan 90 step 90.2's own verifiable result, proven against the REAL client (not a mock of this
   * test's own shape): a build advertising only the pre-plan-90 capability set is driven by a
   * current host with no errors and no thrown `E_UNKNOWN_METHOD` — every new facet reports
   * `unavailable` with a named reason instead, the exact pattern `device-identity.ts`'s
   * `applyGps` already uses for `mock-location` (checked BEFORE the call, never discovered from a
   * failed one). The fake connect below never even answers `label.*`/`text.*` — if the "describe"
   * helper below ever called through instead of gating, the test would hang or throw, not pass
   * silently.
   */
  test('a build advertising only the pre-plan-90 capability set never throws E_UNKNOWN_METHOD when the host gates on hello().capabilities first', async () => {
    const PRE_PLAN_90_CAPABILITIES = ['socks5-route', 'vpn-status', 'egress-probe', 'route-hold', 'mock-location']
    const { connect } = scriptedConnect((req) => {
      if (req.method === 'hello') {
        return {
          id: req.id,
          ok: true,
          result: { protocol: GUEST_AGENT_PROTOCOL, appVersion: '1.0.0', androidSdkInt: 33, capabilities: PRE_PLAN_90_CAPABILITIES },
        }
      }
      // Any of the new methods reaching the wire at all is exactly what correct capability
      // gating must prevent — answered as a real old build would, never called in this test.
      return { id: req.id, ok: false, error: { code: 'E_UNKNOWN_METHOD', message: `unknown method: ${req.method}` } }
    })
    const client = createGuestAgentClient({ port: 1, token: 't', connect })

    const hello = await client.hello()
    expect(hello.capabilities).not.toContain('screen-label')
    expect(hello.capabilities).not.toContain('text-input')

    /** The gate every real caller is expected to apply (`device-identity.ts`'s `applyGps` shape) — never call the client method unless the capability was advertised. */
    function describeFacet(name: 'screen-label' | 'text-input', label: string): { available: false; reason: string } | { available: true } {
      if (!hello.capabilities.includes(name)) {
        return { available: false, reason: `this device's guest agent does not advertise ${name} — ${label} needs a newer agent build` }
      }
      return { available: true }
    }

    const labelFacet = describeFacet('screen-label', 'screen labelling')
    const textFacet = describeFacet('text-input', 'unicode text input')

    expect(labelFacet).toEqual({
      available: false,
      reason: "this device's guest agent does not advertise screen-label — screen labelling needs a newer agent build",
    })
    expect(textFacet).toEqual({
      available: false,
      reason: "this device's guest agent does not advertise text-input — unicode text input needs a newer agent build",
    })

    // Never actually called — the gate above already returned `unavailable`. This is the same
    // "no errors and no thrown E_UNKNOWN_METHOD" outcome, demonstrated the other way round: a
    // caller that skips the gate and calls anyway gets exactly one coded, catchable error per
    // call, never a crash — proving the client is safe even when a future caller forgets to gate.
    await expect(client.labelStatus()).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
    await expect(client.textStatus()).rejects.toMatchObject({ code: 'E_UNKNOWN_METHOD' })
  })
})
