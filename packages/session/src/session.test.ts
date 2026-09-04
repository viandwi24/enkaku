import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import type { GuestAgentClient, GuestAgentClientRunner } from '@enkaku/drivers'
import type { Inspector, UiNode } from '@enkaku/protocol'
import type { ScrcpySession } from '@enkaku/scrcpy'
import { createSession, type CreateSessionDeps } from './session'
import { ENKAKU_IME_COMPONENT_ID } from './text-input'
import type { Logger } from './logger'

/** Mirrors farm-tag.ts's private constant; a test that pins the shipped value. */
const FARM_TAG_PROPERTY = 'debug.enkaku.instrumented'

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

  test('a wired agent advertising text-input: ime enable+set run once the setup is awaited, and session.textInput reflects the outcome', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent(['text-input'])
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    // Plan 125 §3.8, step 125.8 — this used to be true the moment
    // `createSession` resolved. It is now deliberately NOT: the whole point of
    // the step is that nothing about the keyboard sits between the operator's
    // click and the first frame.
    expect(calls.some((c) => c.startsWith('ime '))).toBe(false)
    await session.whenTextInputReady?.()
    expect(calls).toContain(`ime enable ${ENKAKU_IME_COMPONENT_ID}`)
    expect(calls).toContain(`ime set ${ENKAKU_IME_COMPONENT_ID}`)
    expect(session.textInput.agentCapabilities).toEqual(['text-input'])
    expect(session.textInput.imeCurrent).toBe(false) // the fake device reports no default_input_method to read back
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
    await session.whenTextInputReady?.() // plan 125 step 125.8 — deferred; there is nothing to restore until it has run
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

describe('DeviceSession.onClipboardChanged (plan 209 §3.2 D10, §4.9, §5 step 209.5)', () => {
  function fakeScrcpySessionWithClipboard(): { session: ScrcpySession; emitClipboard: (text: string) => void } {
    const handlers = new Set<(m: { type: 'clipboard'; text: string }) => void>()
    const session = {
      meta: { deviceName: 'test phone', codec: 'h264', width: 1080, height: 2400 },
      onPacket: () => {},
      onMetaChange: () => {},
      onClose: () => {},
      onDeviceMessage: (cb: (m: { type: 'clipboard'; text: string }) => void) => {
        handlers.add(cb)
        return () => handlers.delete(cb)
      },
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
        injectScroll: () => {},
      },
      close: async () => {},
    } as unknown as ScrcpySession
    return { session, emitClipboard: (text) => { for (const cb of handlers) cb({ type: 'clipboard', text }) } }
  }

  test('onClipboardChanged forwards clipboard device messages and the unsubscribe stops them', async () => {
    const { session: scrcpy, emitClipboard } = fakeScrcpySessionWithClipboard()
    const client = fakeClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), makeScrcpy: async () => scrcpy },
    )
    const received: string[] = []
    const unsubscribe = session.onClipboardChanged((text) => received.push(text))
    emitClipboard('hello')
    expect(received).toEqual(['hello'])
    unsubscribe()
    emitClipboard('world')
    expect(received).toEqual(['hello'])
    await session.close()
  })
})

/**
 * **Plan 125 §3.7, §4.5, §5 step 125.7 — acceptance criterion 11**: *"`wakeDevice`
 * runs at most once per session start, and zero times for a device already awake
 * or hot — asserted by a test that counts the calls."*
 *
 * What was wrong (plan 125 §0.7): a cold `stream.start` ran the wake block
 * TWICE, serially — `ws-handlers.ts`'s `readiness.hold(deviceId, 'viewer')` →
 * `ensureAwake` → `wakeDevice`, then `sessions.acquire` → `createSession` →
 * `wakeDevice` again. `svc power stayon` alone was measured at 1422 ms (plan 96
 * §22), so ≈3.2 s burned before `starting-video` was even entered.
 *
 * `wakeDevice` is counted by the commands it — and only it — issues in this
 * file's paths: `input keyevent KEYCODE_WAKEUP` fires on every non-`off` call
 * and nothing else in a session build sends it, and `readPowerState`'s
 * `settings get` pair is its first act. Counting the commands rather than
 * spying on the function keeps the assertion about what reaches the PHONE,
 * which is what the sealed-box constraint (§0.2) actually cares about.
 */
describe('createSession — one wake per session start (plan 125 §3.7, §5 step 125.7, acceptance #11)', () => {
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

  /** How many times `wakeDevice` ran, read off the wire rather than a spy. */
  const wakeCount = (calls: string[]): number => calls.filter((c) => c === 'input keyevent KEYCODE_WAKEUP').length

  test('the baseline: a device nothing is holding awake gets EXACTLY ONE wake, never zero', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'always' },
      { client, log: silentLog() },
    )
    expect(wakeCount(calls)).toBe(1)
    expect(calls).toContain('svc power stayon true')
    await session.close()
  })

  test('skipWake: the readiness manager already holds this device awake — ZERO wakes reach the phone', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'always', skipWake: true },
      { client, log: silentLog() },
    )
    expect(wakeCount(calls)).toBe(0)
    // Every part of the wake sequence, not just the nudge: the `settings get`
    // readback pair and the 1422 ms `svc` call are the expensive halves.
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
    expect(calls.some((c) => c.startsWith('settings get global stay_on_while_plugged_in'))).toBe(false)
    expect(calls.some((c) => c.startsWith('settings get system screen_off_timeout'))).toBe(false)
    await session.close()
  })

  /**
   * The safety half, and the reason this is a REMOVAL of adb writes rather than
   * a reordering of them (§0.2): a session that never claimed `stayon` must
   * never release it. Releasing a hold this session did not take would hand a
   * boxed phone's screen back to its own timeout out from under the readiness
   * manager that IS holding it — and nobody can reach that phone to wake it.
   */
  test('skipWake: close() does NOT release a stayon hold this session never took', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'always', skipWake: true },
      { client, log: silentLog() },
    )
    await session.close()
    expect(calls).not.toContain('svc power stayon false')
  })

  test('without skipWake, close() still releases its own hold exactly as before this plan', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'always' },
      { client, log: silentLog() },
    )
    await session.close()
    expect(calls).toContain('svc power stayon false')
  })

  /**
   * Plan 100 §4.2's fast path is unchanged by 125.7 and must stay that way:
   * `skipDevicePrep` has always implied "do not wake, do not release", and the
   * new flag folds into it rather than competing with it.
   */
  test('skipDevicePrep still implies skipWake, both at open and at close (plan 100 §4.2 regression)', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'always', skipDevicePrep: true },
      { client, log: silentLog() },
    )
    expect(wakeCount(calls)).toBe(0)
    await session.close()
    expect(calls).not.toContain('svc power stayon false')
  })

  test('keepAwake: "off" is still opted out entirely, with or without skipWake', async () => {
    const { client, calls } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'off' },
      { client, log: silentLog() },
    )
    expect(wakeCount(calls)).toBe(0)
    await session.close()
    expect(calls.some((c) => c.startsWith('svc power stayon'))).toBe(false)
  })
})

/**
 * **Plan 125 §3.8, §4.5, §5 step 125.8 — acceptance criterion 12**:
 * *"`applyTextInput` no longer blocks the first frame; a device with no guest
 * agent still reaches `ready` and still streams."*
 *
 * The cost being removed (§0.7's table): `applyTextInput` ran on EVERY ordinary
 * session build (`prep.textInput` defaults to `'auto'`) and triggers a full
 * guest-agent app bootstrap — 3 `appops` calls, an `am start` with a ~500 ms
 * measured handover, an 8 × 500 ms `hello()` ladder, up to three full pairing
 * rounds, then 4 more `ime`/`settings` calls — all of it between the operator's
 * click and the first frame, for a keyboard nobody had asked to use yet.
 */
describe('createSession — the guest-agent bootstrap is off the critical line (plan 125 §3.8, §5 step 125.8, acceptance #12)', () => {
  function recordingClient(): { client: AdbClient; calls: string[] } {
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
    return { client, calls }
  }

  /** A `GuestAgentClientRunner` whose `hello()` can be made slow, so "in flight" is a state a test can stand in. */
  function fakeGuestAgent(opts: { helloDelayMs?: number } = {}): { runner: GuestAgentClientRunner } {
    const client = {
      hello: async () => {
        if (opts.helloDelayMs) await Bun.sleep(opts.helloDelayMs)
        return { protocol: 1, appVersion: '1.0', androidSdkInt: 34, capabilities: ['text-input'] }
      },
      textCommit: async (text: string) => ({ committed: [...text].length, ime: 'current' as const }),
    } as unknown as GuestAgentClient
    return { runner: (fn) => fn(client) }
  }

  /** A minimal fake `ScrcpySession` whose packets a test can emit by hand — the same shape the fallback-retry block above uses. */
  function fakeScrcpySession(): { session: ScrcpySession; emitFrame: () => void } {
    let packetCb: ((p: { kind: string; data: Uint8Array }) => void) | null = null
    const session = {
      meta: { deviceName: 'test phone', codec: 'h264', width: 704, height: 1600 },
      onPacket: (cb: (p: { kind: string; data: Uint8Array }) => void) => {
        packetCb = cb
      },
      onMetaChange: () => {},
      onClose: () => {},
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
    return { session, emitFrame: () => packetCb?.({ kind: 'keyframe', data: new Uint8Array([1, 2, 3]) }) }
  }

  test('nothing about the keyboard is issued before the session is returned — the whole point of the step', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    expect(calls.some((c) => c.startsWith('ime '))).toBe(false)
    expect(calls).not.toContain('settings get secure default_input_method')
    await session.close()
  })

  test('the first frame is what starts it: `ready` is reported, and the bootstrap follows behind the picture', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent()
    const { session: scrcpy, emitFrame } = fakeScrcpySession()
    const phases: string[] = []
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner, makeScrcpy: async () => scrcpy, onPhase: (p) => phases.push(p) },
    )
    await session.display.start()
    expect(calls.some((c) => c.startsWith('ime '))).toBe(false)

    emitFrame()
    expect(phases).toContain('ready') // the picture is up FIRST — synchronously with the frame
    await session.whenTextInputReady?.() // then, and only then, the keyboard
    expect(calls).toContain(`ime set ${ENKAKU_IME_COMPONENT_ID}`)
    await session.close()
  })

  /**
   * Acceptance criterion 12's second half, and the reason
   * `whenTextInputReady()` starts the work rather than merely awaiting it: a
   * session whose display never produces a frame must not leave a script
   * blocked forever on a bootstrap nothing ever kicked off.
   */
  test('a session that never sees a frame still sets the keyboard up on demand', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    await session.whenTextInputReady?.()
    expect(calls).toContain(`ime set ${ENKAKU_IME_COMPONENT_ID}`)
    expect(session.textInput.agentCapabilities).toEqual(['text-input'])
    await session.close()
  })

  test('the setup is start-once: a second whenTextInputReady() does not re-run the bootstrap', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    await session.whenTextInputReady?.()
    await session.whenTextInputReady?.()
    expect(calls.filter((c) => c === `ime set ${ENKAKU_IME_COMPONENT_ID}`).length).toBe(1)
    await session.close()
  })

  /**
   * The window 125.8 opened, and the reason `revertTextInput` awaits an
   * in-flight setup before reverting: `close()` can now land mid-bootstrap, and
   * a revert of the not-yet-applied no-op would leave the agent's IME pinned as
   * the device's default input method PERMANENTLY — a device-scoped setting
   * outliving the session that made it, on a phone in a sealed box (§0.2).
   */
  test('close() racing an in-flight bootstrap still restores the device’s own IME', async () => {
    const { client, calls } = recordingClient()
    const { runner } = fakeGuestAgent({ helloDelayMs: 20 })
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), withGuestAgentClient: runner },
    )
    void session.whenTextInputReady?.() // deliberately NOT awaited — the setup is still running
    await session.close()
    expect(calls).toContain('ime set com.google.android.inputmethod.latin/.LatinIME')
  })

  test('a device with no guest agent still streams and still reaches ready, and never blocks on a bootstrap it has no agent for', async () => {
    const { client, calls } = recordingClient()
    const { session: scrcpy, emitFrame } = fakeScrcpySession()
    const frames: number[] = []
    const phases: string[] = []
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client, log: silentLog(), makeScrcpy: async () => scrcpy, onFrame: (chunk) => frames.push(chunk.byteLength), onPhase: (p) => phases.push(p) },
    )
    await session.display.start()
    emitFrame()
    expect(phases).toContain('ready')
    expect(frames).toEqual([3])
    await session.whenTextInputReady?.()
    expect(calls.some((c) => c.startsWith('ime '))).toBe(false)
    expect(session.textInput.agentCapabilities).toBeNull()
    await session.close()
  })
})

/**
 * Plan 206 §3.9, §4.4 — `prewarmInspector` and `requireScrcpy` on every
 * build, not only the fast path.
 */
describe('DeviceSession.prewarmInspector (plan 206 §3.9)', () => {
  test('resolves and starts nothing — plan 208 implements the body', async () => {
    let makeInspectorCalls = 0
    const makeInspector: NonNullable<CreateSessionDeps['makeInspector']> = async () => {
      makeInspectorCalls++
      return { inspector: fakeInspector(), engineId: 'ui-server', pollIntervalMs: 80, release: async () => {} }
    }
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1' },
      { client: fakeClient(), log: silentLog(), makeInspector },
    )
    await expect(session.prewarmInspector()).resolves.toBeUndefined()
    expect(makeInspectorCalls).toBe(0)
    expect(session.inspector).toBeNull()
    await session.close()
  })
})

describe('createSession — requireScrcpy applies to every build, not only the fast path (plan 206 §3.6, §4.4)', () => {
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

  test('requireScrcpy without skipDevicePrep throws E_SCRCPY_UNAVAILABLE and reverts stayon/rotation/tag', async () => {
    const { client, calls } = recordingClient()
    await expect(
      createSession(
        { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', keepAwake: 'always', requireScrcpy: true },
        { client, log: silentLog(), makeScrcpy: async () => null },
      ),
    ).rejects.toMatchObject({ name: 'SessionError', code: 'E_SCRCPY_UNAVAILABLE' })
    // Nothing this (failed) build claimed is left applied on the device.
    expect(calls).toContain('svc power stayon false')
    expect(calls).toContain(`setprop ${FARM_TAG_PROPERTY} ''`)
  })

  test('display: "screencap-loop" (the operator\'s own configuration) with requireScrcpy still opens the screencap loop — never a false E_SCRCPY_UNAVAILABLE', async () => {
    const { client } = recordingClient()
    const session = await createSession(
      { deviceId: 'dev-1', serial: 'SER1', stableId: 'STABLE1', display: 'screencap-loop', requireScrcpy: true },
      { client, log: silentLog(), makeScrcpy: async () => null },
    )
    expect(session.displayEngineId).toBe('screencap-loop')
    await session.close()
  })
})
