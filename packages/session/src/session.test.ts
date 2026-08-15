import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import type { GuestAgentClient, GuestAgentClientRunner } from '@enkaku/drivers'
import type { Inspector, UiNode } from '@enkaku/protocol'
import type { ScrcpySession } from '@enkaku/scrcpy'
import { FARM_TAG_PROPERTY } from './farm-tag'
import { createSession, type CreateSessionDeps } from './session'
import { ENKAKU_IME_COMPONENT_ID } from './text-input'
import type { Logger } from './logger'

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

/** Every shell command succeeds instantly; nothing touches a real device. */
const fakeClient = () => ({ exec: async () => '', execOut: async () => new Uint8Array() }) as unknown as AdbClient

function fakeInspector(): Inspector {
  return {
    id: 'ui-server',
    dump: async () => ({}) as UiNode,
    find: async () => null,
    screenshot: async () => new Uint8Array(),
  }
}

/**
 * Plan 56 §5.3: `releaseInspector()` gives the engine back, and a LATER
 * `whenInspectorReady()` must build a fresh one rather than resolving
 * against the now-dead handle. Counts both `makeInspector` calls and
 * `release()` calls so the test fails if either the re-build or the
 * original release stops happening.
 */
describe('DeviceSession.releaseInspector (plan 56 §4.3, §5.3)', () => {
  test('a second whenInspectorReady() after release() builds a NEW engine', async () => {
    let built = 0
    let released = 0
    const makeInspector: NonNullable<CreateSessionDeps['makeInspector']> = async () => {
      built++
      return {
        inspector: fakeInspector(),
        engineId: 'ui-server',
        pollIntervalMs: 80,
        release: async () => {
          released++
        },
      }
    }

    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client: fakeClient(), log: silentLog(), makeInspector },
    )

    await session.whenInspectorReady()
    expect(built).toBe(1)
    expect(session.inspector).not.toBeNull()
    expect(session.inspectorEngineId).toBe('ui-server')

    // A second call before any release must NOT build a second engine —
    // the in-flight/completed promise is reused (baseline behaviour).
    await session.whenInspectorReady()
    expect(built).toBe(1)

    await session.releaseInspector()
    expect(released).toBe(1)
    expect(session.inspector).toBeNull()

    await session.whenInspectorReady()
    expect(built).toBe(2) // a genuinely fresh engine, not the dead handle
    expect(released).toBe(1) // the fresh one was not released again by this call
    expect(session.inspector).not.toBeNull()

    await session.close()
  })

  test('releaseInspector() before the inspector was ever started is a harmless no-op', async () => {
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client: fakeClient(), log: silentLog() },
    )
    await expect(session.releaseInspector()).resolves.toBeUndefined()
    await session.close()
  })
})

/**
 * `DeviceSession.videoProfile` (plan 92 §3.8 rule 1, §4.3, §5 step 92.2) —
 * what `SessionManager.reprofile()` compares against a freshly resolved
 * profile to decide whether a session needs restarting. `video-profile.test.ts`
 * covers `resolveVideoProfile` itself in isolation; this proves the SESSION
 * actually carries whatever was resolved (or the schema-default fallback),
 * rather than only using it to build scrcpy's arguments and forgetting it.
 */
describe('DeviceSession.videoProfile (plan 92 §3.8 rule 1, §4.3, §5 step 92.2)', () => {
  test('records the caller-supplied videoProfile verbatim', async () => {
    const profile = {
      quality: 'wall' as const,
      maxSize: 320,
      maxFps: 3,
      bitRate: 400_000,
      source: { maxSize: 'preset' as const, maxFps: 'farm' as const, bitRate: 'preset' as const },
    }
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', quality: 'wall', videoProfile: profile },
      { client: fakeClient(), log: silentLog() },
    )
    expect(session.videoProfile).toBe(profile)
    await session.close()
  })

  test('with no videoProfile supplied, falls back to the schema-default resolution for the requested quality — byte-identical to the pre-plan-92 constants', async () => {
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', quality: 'control' },
      { client: fakeClient(), log: silentLog() },
    )
    expect(session.videoProfile).toMatchObject({ maxSize: 1600, maxFps: 30, bitRate: 4_000_000 })
    await session.close()
  })
})

/**
 * Farm-traffic marker wiring end to end (spec §9.4/§17, plan 87 §4.12, §5
 * step 87.13) — `farm-tag.test.ts` covers `applyFarmTag` itself in
 * isolation; this proves `createSession` actually calls it with the right
 * default, the same way `applyRotation`'s call site is trusted rather than
 * separately re-tested here.
 */
describe('createSession — farm-traffic marker (spec §9.4/§17, plan 87 §4.12, §5 step 87.13)', () => {
  /** Records every shell command reaching `AdbClient.exec`, keyed off the raw command string. */
  function recordingClient(): { client: AdbClient; calls: string[] } {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      execOut: async () => new Uint8Array(),
    } as unknown as AdbClient
    return { client, calls }
  }

  test('tagTraffic omitted defaults to on ("on by default" — spec §17): the marker is set at session start and cleared at close', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession({ deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' }, { client, log: silentLog() })
    expect(calls).toContain(`setprop ${FARM_TAG_PROPERTY} 1`)
    await session.close()
    expect(calls).toContain(`setprop ${FARM_TAG_PROPERTY} ''`)
  })

  test('tagTraffic: false never writes the marker, at start or close', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', tagTraffic: false },
      { client, log: silentLog() },
    )
    expect(calls.some((c) => c.includes(FARM_TAG_PROPERTY))).toBe(false)
    await session.close()
    expect(calls.some((c) => c.includes(FARM_TAG_PROPERTY))).toBe(false)
  })

  test('close() is safe to call twice — the revert it issues is idempotent, same contract as rotation', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession({ deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' }, { client, log: silentLog() })
    await session.close()
    const clearsAfterFirstClose = calls.filter((c) => c === `setprop ${FARM_TAG_PROPERTY} ''`).length
    await session.close()
    const clearsAfterSecondClose = calls.filter((c) => c === `setprop ${FARM_TAG_PROPERTY} ''`).length
    expect(clearsAfterFirstClose).toBe(1)
    expect(clearsAfterSecondClose).toBe(2)
  })
})

/**
 * Text-input keyboard wiring end to end (plan 90 §3.2, §4.5, §5 step 90.5) — `text-input.test.ts`
 * covers `applyTextInput`/`resolveTextRoute` themselves in isolation; this proves `createSession`
 * actually calls `applyTextInput` with the right defaults and exposes the result on
 * `DeviceSession.textInput`, the same way the farm-traffic block above trusts its own call site.
 */
describe('createSession — text-input keyboard (plan 90 §3.2, §4.5, §5 step 90.5)', () => {
  function recordingClient(): { client: AdbClient; calls: string[] } {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      execOut: async () => new Uint8Array(),
    } as unknown as AdbClient
    return { client, calls }
  }

  /** A `GuestAgentClientRunner` whose `hello()` reports `capabilities`; every other call records its args. */
  function fakeGuestAgent(capabilities: string[]): { runner: GuestAgentClientRunner; textCommitCalls: Array<{ text: string; perCharMs?: [number, number] }> } {
    const textCommitCalls: Array<{ text: string; perCharMs?: [number, number] }> = []
    const client = {
      hello: async () => ({ protocol: 1, appVersion: '1.0', androidSdkInt: 34, capabilities }),
      textCommit: async (text: string, perCharMs?: [number, number]) => {
        textCommitCalls.push({ text, ...(perCharMs ? { perCharMs } : {}) })
        return { committed: [...text].length, ime: 'current' as const }
      },
    } as unknown as GuestAgentClient
    const runner: GuestAgentClientRunner = (fn) => fn(client)
    return { runner, textCommitCalls }
  }

  test('with no guest-agent client wired, textInput reports no agent and issues no ime commands — the default, unconfigured build', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession({ deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' }, { client, log: silentLog() })
    expect(session.textInput.mode).toBe('auto')
    expect(session.textInput.agentCapabilities).toBeNull()
    expect(session.textInput.imeCurrent).toBe(false)
    expect(calls.some((c) => c.includes('ime '))).toBe(false)
    await session.close()
  })

  test('prep.textInput: "device" never touches the IME even when a capable agent client is wired', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent(['text-input'])
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', textInput: 'device' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    expect(session.textInput.mode).toBe('device')
    expect(session.textInput.agentCapabilities).toBeNull()
    expect(calls.some((c) => c.includes('ime '))).toBe(false)
    await session.close()
  })

  test('a wired agent advertising text-input: ime enable+set run at session start, and session.textInput reflects the outcome', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent(['text-input'])
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    expect(calls).toContain(`ime enable ${ENKAKU_IME_COMPONENT_ID}`)
    expect(calls).toContain(`ime set ${ENKAKU_IME_COMPONENT_ID}`)
    expect(session.textInput.agentCapabilities).toEqual(['text-input'])
    await session.close()
  })

  test('close() restores the prior default IME, and is idempotent on a second close — same contract as rotation', async () => {
    const calls: string[] = []
    const client = {
      exec: async (_serial: string, cmd: string) => {
        calls.push(cmd)
        if (cmd === 'settings get secure default_input_method') {
          return { stdout: 'com.google.android.inputmethod.latin/.LatinIME', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      execOut: async () => new Uint8Array(),
    } as unknown as AdbClient
    const { runner } = fakeGuestAgent(['text-input'])
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    calls.length = 0
    await session.close()
    const restoresAfterFirstClose = calls.filter((c) => c === 'ime set com.google.android.inputmethod.latin/.LatinIME').length
    await session.close()
    const restoresAfterSecondClose = calls.filter((c) => c === 'ime set com.google.android.inputmethod.latin/.LatinIME').length
    expect(restoresAfterFirstClose).toBe(1)
    expect(restoresAfterSecondClose).toBe(2)
  })

  test('DeviceSession.textInput.commitViaAgent throws E_TEXT_AGENT_UNAVAILABLE when no guest-agent client is wired', async () => {
    const { client } = recordingClient()
    const session = await createSession({ deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' }, { client, log: silentLog() })
    await expect(session.textInput.commitViaAgent('hello')).rejects.toMatchObject({ code: 'E_TEXT_AGENT_UNAVAILABLE' })
    await session.close()
  })

  test('DeviceSession.textInput.commitViaAgent calls the wired client\'s text.commit and reports what it committed', async () => {
    const { client } = recordingClient()
    const { runner, textCommitCalls } = fakeGuestAgent(['text-input'])
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    const result = await session.textInput.commitViaAgent('こんにちは 👋', [10, 30])
    expect(textCommitCalls).toEqual([{ text: 'こんにちは 👋', perCharMs: [10, 30] }])
    expect(result).toEqual({ committed: [...'こんにちは 👋'].length, imeCurrent: true })
    await session.close()
  })
})

/**
 * The H6 reproduction, the half provable without the owner's phone (plan 88
 * §5 step 88.1): F12 was confirmed by reading `DeviceSession.close()` — it
 * called `transport.disconnect()`, which for `adb-tcp` issued
 * `host:disconnect` and dropped the device from adb entirely, not just the
 * session. This proves the fix with a fake `adb-tcp` transport end to end
 * through the real `createSession`/`close()` path: closing a session must
 * never disconnect the device from adb.
 */
describe('DeviceSession.close() on an adb-tcp device (plan 88 §3.7, fixes F12/H6)', () => {
  /** `listDevices` answers from `snapshot`; every disconnectDevice/connectDevice call is recorded. */
  function fakeTcpClient(snapshot: TrackedDevice[]) {
    const disconnectCalls: string[] = []
    const connectCalls: string[] = []
    const client = {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      execOut: async () => new Uint8Array(),
      listDevices: async () => snapshot,
      connectDevice: async (hostPort: string) => {
        connectCalls.push(hostPort)
        return 'connected'
      },
      disconnectDevice: async (hostPort: string) => {
        disconnectCalls.push(hostPort)
        return 'disconnected'
      },
    } as unknown as AdbClient
    return { client, disconnectCalls, connectCalls }
  }

  test('closing the session leaves the device connected in adb devices — no host:disconnect is ever issued', async () => {
    const { client, disconnectCalls, connectCalls } = fakeTcpClient([{ serial: '10.20.0.37:5555', state: 'device' }])
    const session = await createSession(
      { deviceId: 'dev-1', serial: '10.20.0.37:5555', stableId: 'STABLE1', transport: 'adb-tcp' },
      { client, log: silentLog() },
    )

    await session.close()

    expect(disconnectCalls).toEqual([]) // the fix: no host:disconnect on close
    expect(connectCalls).toEqual([]) // already `device` at session start, so connect() was a no-op too
  })

  test('closing twice still never disconnects — the no-op is as idempotent as the rest of close()', async () => {
    const { client, disconnectCalls } = fakeTcpClient([{ serial: '10.20.0.37:5555', state: 'device' }])
    const session = await createSession(
      { deviceId: 'dev-1', serial: '10.20.0.37:5555', stableId: 'STABLE1', transport: 'adb-tcp' },
      { client, log: silentLog() },
    )
    await session.close()
    await session.close()
    expect(disconnectCalls).toEqual([])
  })
})

/**
 * Plan 100 §4.3, step 100.6 (closes G10/G11, docs/plans/96-m61-hotfixes.md
 * §96.22): a transient `makeScrcpy` failure at open used to pin a session to
 * the screencap-loop fallback (87% device CPU) for its whole life, with the
 * REST snapshot still claiming `display: "scrcpy"`. `scheduleFallbackRetry`/
 * `cancelFallbackRetry` are test seams (`CreateSessionDeps`) that capture
 * every scheduled retry instead of waiting out real 10s/30s/60s/300s
 * wall-clock delays — a test fires one by calling the captured `fn` directly.
 */
describe('screencap-loop fallback retry (plan 100 §4.3, step 100.6)', () => {
  /** A minimal fake `ScrcpySession` — enough for `ScrcpyDisplay` to wrap it and forward packets on demand. */
  function fakeScrcpySession(): { session: ScrcpySession; emitFrame: (data: Uint8Array) => void } {
    let packetCb: ((p: { kind: string; data: Uint8Array }) => void) | null = null
    const session = {
      meta: null,
      onPacket: (cb: (p: { kind: string; data: Uint8Array }) => void) => {
        packetCb = cb
      },
      onMetaChange: () => {},
      onClose: () => {},
      onDeviceMessage: () => {},
      control: {
        injectTouch: () => {},
        injectKeycode: () => {},
        injectText: () => {},
        uhidCreate: () => {},
        uhidInput: () => {},
        uhidDestroy: () => {},
        setDisplayPower: () => {},
        resetVideo: () => {},
        getClipboard: async () => '',
        setClipboard: async () => {},
      },
      close: async () => {},
    } as unknown as ScrcpySession
    return { session, emitFrame: (data) => packetCb?.({ kind: 'frame', data }) }
  }

  /** Captures every `scheduleFallbackRetry(fn, ms)` call so a test can fire one by hand, and every `cancelFallbackRetry` handle. */
  function fakeScheduler() {
    const calls: Array<{ fn: () => void | Promise<void>; ms: number }> = []
    const cancelled: unknown[] = []
    return {
      calls,
      cancelled,
      scheduleFallbackRetry: (fn: () => void | Promise<void>, ms: number) => {
        calls.push({ fn, ms })
        return calls.length - 1
      },
      cancelFallbackRetry: (h: unknown) => {
        cancelled.push(h)
      },
    }
  }

  test('a transient makeScrcpy failure at open arms one retry at the 10s step, and a later successful retry swaps the live display while the SAME onFrame subscriber keeps receiving frames', async () => {
    const frames: Array<{ chunk: Uint8Array; codec: string }> = []
    let makeScrcpyCalls = 0
    const { session: fakeScrcpy, emitFrame } = fakeScrcpySession()
    const makeScrcpy: NonNullable<CreateSessionDeps['makeScrcpy']> = async () => {
      makeScrcpyCalls++
      if (makeScrcpyCalls === 1) throw new Error('transient failure')
      return fakeScrcpy
    }
    const { calls: retryCalls, scheduleFallbackRetry, cancelFallbackRetry } = fakeScheduler()

    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      {
        client: fakeClient(),
        log: silentLog(),
        makeScrcpy,
        onFrame: (chunk, meta) => frames.push({ chunk, codec: meta.codec }),
        scheduleFallbackRetry,
        cancelFallbackRetry,
      },
    )

    // Opened on the fallback — the transient failure, not a deliberate config.
    expect(session.displayEngineId).toBe('screencap-loop')
    expect(retryCalls.length).toBe(1)
    expect(retryCalls[0]!.ms).toBe(10_000) // the schedule's first step

    await retryCalls[0]!.fn()

    // Recovered — the SAME session object, no rebuild.
    expect(makeScrcpyCalls).toBe(2)
    expect(session.displayEngineId).toBe('scrcpy')

    // A frame from the NEW scrcpy session reaches the subscriber this
    // session was built with — no re-subscribe, no dropped viewer.
    emitFrame(new Uint8Array([1, 2, 3]))
    expect(frames.length).toBe(1)
    expect(frames[0]!.codec).toBe('h264')

    await session.close()
  })

  test('opts.display === "screencap-loop" (a deliberate configuration) never attempts scrcpy and never arms a retry', async () => {
    let makeScrcpyCalls = 0
    const { calls: retryCalls, scheduleFallbackRetry, cancelFallbackRetry } = fakeScheduler()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', display: 'screencap-loop' },
      {
        client: fakeClient(),
        log: silentLog(),
        makeScrcpy: async () => {
          makeScrcpyCalls++
          return null
        },
        scheduleFallbackRetry,
        cancelFallbackRetry,
      },
    )
    expect(session.displayEngineId).toBe('screencap-loop')
    expect(makeScrcpyCalls).toBe(0)
    expect(retryCalls.length).toBe(0)
    await session.close()
  })

  test('gives up after fallbackRetryCount attempts and stops scheduling further retries', async () => {
    const { calls: retryCalls, scheduleFallbackRetry, cancelFallbackRetry } = fakeScheduler()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      {
        client: fakeClient(),
        log: silentLog(),
        makeScrcpy: async () => {
          throw new Error('always fails')
        },
        fallbackRetryCount: () => 2,
        scheduleFallbackRetry,
        cancelFallbackRetry,
      },
    )
    expect(retryCalls.length).toBe(1)
    await retryCalls[0]!.fn()
    expect(retryCalls.length).toBe(2)
    await retryCalls[1]!.fn()
    // Budget (2) spent — no third retry, ever.
    expect(retryCalls.length).toBe(2)
    expect(session.displayEngineId).toBe('screencap-loop')
    await session.close()
  })

  test('close() cancels a pending retry timer, and a retry that still fires after close() is a safe no-op — never resurrects a display on a dead session', async () => {
    const { calls: retryCalls, cancelled, scheduleFallbackRetry, cancelFallbackRetry } = fakeScheduler()
    let makeScrcpyCalls = 0
    const { session: fakeScrcpy } = fakeScrcpySession()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      {
        client: fakeClient(),
        log: silentLog(),
        makeScrcpy: async () => {
          makeScrcpyCalls++
          if (makeScrcpyCalls === 1) throw new Error('transient failure')
          return fakeScrcpy
        },
        scheduleFallbackRetry,
        cancelFallbackRetry,
      },
    )
    expect(retryCalls.length).toBe(1)

    await session.close()
    expect(cancelled.length).toBe(1)

    // Simulate the real timer firing anyway (already in flight when close()
    // ran) — must not throw, and must not touch makeScrcpy or the display.
    await retryCalls[0]!.fn()
    expect(makeScrcpyCalls).toBe(1) // the retry itself never ran
    expect(session.displayEngineId).toBe('screencap-loop')
  })
})
