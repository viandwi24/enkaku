import { describe, expect, test } from 'bun:test'
import type { AdbClient } from '@enkaku/adb'
import type { Inspector, UiNode } from '@enkaku/protocol'
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
