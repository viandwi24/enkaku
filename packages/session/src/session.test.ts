import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import type { Inspector, UiNode } from '@enkaku/protocol'
import { FARM_TAG_PROPERTY } from './farm-tag'
import { createSession, type CreateSessionDeps } from './session'
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
