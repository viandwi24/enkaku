import { describe, expect, test } from 'bun:test'
import { UiServerInspector } from './index'
import { UiServerClientError } from './client'

/**
 * `dump()` retries a device-side failure exactly once.
 *
 * uiautomator's own `dumpWindowHierarchy` throws — in practice a
 * NullPointerException — when the window it is asked about is mid-transition:
 * straight after a wake, during an animation, on the keyguard. Observed on a
 * moto g06 power (Android 15): the first dump after waking failed with
 * `java.lang.NullPointerException`, and the very next one returned 103 nodes
 * in 584 ms. Before this, that raw Java exception was what the operator saw.
 *
 * Once, and only once: a device that cannot dump twice in a row has a real
 * problem, and looping would hide it behind a spinner.
 */

const XML = '<hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][720,1640]" /></hierarchy>'

/** An inspector whose client is replaced by a scripted `dumpWindowHierarchy`. */
function inspectorWith(dump: () => Promise<string>): { inspector: UiServerInspector; calls: () => number } {
  // The UNREACHABLE case wakes the watchdog, which restarts the server in the
  // background — stubbed so that housekeeping cannot throw and drown the
  // assertion this test is actually making.
  const launcher = { stop: async () => {}, start: async () => {} } as never
  const inspector = new UiServerInspector({ serial: 'test-serial', localPort: 0, launcher })
  let calls = 0
  // The client is constructed internally; swap in a stub so no socket is opened.
  ;(inspector as unknown as { client: { dumpWindowHierarchy: () => Promise<string> } }).client = {
    dumpWindowHierarchy: () => {
      calls += 1
      return dump()
    },
  }
  return { inspector, calls: () => calls }
}

describe('UiServerInspector.dump — one retry, not a loop', () => {
  test('a transient device-side throw is retried and succeeds', async () => {
    let first = true
    const { inspector, calls } = inspectorWith(async () => {
      if (first) {
        first = false
        throw new Error('dumpWindowHierarchy: java.lang.NullPointerException')
      }
      return XML
    })

    const node = await inspector.dump()

    expect(node).toBeTruthy()
    expect(calls()).toBe(2)
  })

  test('a failure that repeats is reported, not retried forever', async () => {
    const { inspector, calls } = inspectorWith(async () => {
      throw new Error('dumpWindowHierarchy: java.lang.NullPointerException')
    })

    await expect(inspector.dump()).rejects.toThrow(/NullPointerException/)
    expect(calls()).toBe(2)
  })

  test('an unreachable server is NOT retried — the watchdog is already restarting it', async () => {
    const { inspector, calls } = inspectorWith(async () => {
      throw new UiServerClientError('UI_SERVER_UNREACHABLE', 'connection refused')
    })

    await expect(inspector.dump()).rejects.toThrow(/connection refused/)
    // A second attempt 300ms later would land in the same hole.
    expect(calls()).toBe(1)
  })

  test('dump() records lastDump on success (plan 208 §4.6)', async () => {
    const { inspector } = inspectorWith(async () => XML)
    expect(inspector.lastDump()).toBeNull()
    const before = Date.now()
    const root = await inspector.dump()
    const last = inspector.lastDump()
    expect(last).not.toBeNull()
    expect(last!.root).toEqual(root)
    expect(last!.at).toBeGreaterThanOrEqual(before)
  })
})
