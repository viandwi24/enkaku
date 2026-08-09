import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `DeviceLog` talks straight to `@/lib/ws` (subscribe/unsubscribe, live
 * `device.event` and `device.inspector.status` pushes) — a real `WebSocket`
 * has nothing to connect to in `happy-dom`, so the module is replaced with a
 * stand-in, the same way `lib/test/nav.ts` replaces `next/navigation`. The
 * fetch path (`GET .../events`, `DeviceEventsResponseSchema`) is exercised
 * against the harness's fetch mock as before; `ws.on`'s handler is captured
 * here (the same pattern `ProvisioningBanner.test.tsx` uses) so the
 * inspector-status tests below can drive a live push directly.
 */
type Handler = (m: { type: string; payload?: unknown }) => void
let handlers: Handler[] = []

mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: Handler) => {
      handlers.push(cb)
      return () => {
        handlers = handlers.filter((h) => h !== cb)
      }
    },
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(false)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 's1',
    isConnected: () => false,
    send: () => {},
    request: () => Promise.reject(new Error('ws not available in test')),
  },
  coreBase: () => 'http://localhost:7700',
  // Unique per call — the synthesized `device.inspector.status` rows below
  // are keyed by this id, and a fixed value would collide across pushes.
  newId: (() => {
    let n = 0
    return () => `test-id-${n++}`
  })(),
}))

const { DeviceLog } = await import('./DeviceLog')

function emit(msg: { type: string; payload?: unknown }): void {
  act(() => {
    for (const h of handlers) h(msg)
  })
}

afterEach(() => {
  handlers = []
  cleanup()
})

// `screen` (the `@testing-library/react` singleton) binds `document.body`
// at MODULE EVALUATION time, before this file's own `happydom.ts` import
// (pulled in transitively by `renderWithApi`) is guaranteed to have run —
// empirically, in this workspace, that leaves `screen` permanently throwing
// "a global document has to be available" regardless of import order.
// `renderWithApi`'s own return value binds its queries at CALL time instead,
// so every test below destructures from it rather than importing `screen`.

describe('DeviceLog', () => {
  test('renders the main stream once both streams have loaded', async () => {
    const { getByText } = renderWithApi(<DeviceLog deviceId="dev-1" deviceOffline={false} />, {
      '/api/devices/dev-1/events*': ({ path }) => {
        const stream = new URL(`http://x${path}`).searchParams.get('stream')
        if (stream === 'main') {
          return {
            body: {
              items: [{ id: 'e1', deviceId: 'dev-1', stream: 'main', kind: 'device.online', actor: null, meta: null, at: 1000 }],
              nextCursor: null,
              total: 1,
            },
          }
        }
        return { body: { items: [], nextCursor: null, total: 0 } }
      },
    })
    await waitFor(() => expect(getByText('Connected')).toBeTruthy())
  })

  test('job.triggered (plan 81 §4.5) renders a legible line, not just its kind string', async () => {
    const { getByText } = renderWithApi(<DeviceLog deviceId="dev-4" deviceOffline={false} />, {
      '/api/devices/dev-4/events*': ({ path }) => {
        const stream = new URL(`http://x${path}`).searchParams.get('stream')
        if (stream === 'main') {
          return {
            body: {
              items: [
                {
                  id: 'e1',
                  deviceId: 'dev-4',
                  stream: 'main',
                  kind: 'job.triggered',
                  actor: 'job:fromjobid1',
                  meta: { fromJobId: 'fromjobid1', toJobId: 'tojobid123', rootJobId: 'fromjobid1', depth: 1 },
                  at: 1000,
                },
              ],
              nextCursor: null,
              total: 1,
            },
          }
        }
        return { body: { items: [], nextCursor: null, total: 0 } }
      },
    })
    await waitFor(() => expect(getByText('Job triggered')).toBeTruthy())
    expect(getByText('job fromjobi queued job tojobid1 (depth 1)')).toBeTruthy()
  })

  test('an empty log shows the empty state, not a crash', async () => {
    const { getByText } = renderWithApi(<DeviceLog deviceId="dev-2" deviceOffline={true} />, {
      '/api/devices/dev-2/events*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(getByText('No main events yet')).toBeTruthy())
  })

  test('a fetch that does not match the schema surfaces as an error, not a crash', async () => {
    // A bare array, the pre-plan-72 shape — must not parse as `{items,...}`.
    const { getByText } = renderWithApi(<DeviceLog deviceId="dev-3" deviceOffline={false} />, {
      '/api/devices/dev-3/events*': { body: [] },
    })
    await waitFor(() => expect(getByText(/did not understand/i)).toBeTruthy())
  })

  /**
   * `device.inspector.status` (plan 85 §3.5, fixes F17/F18) is a live-only
   * broadcast — `daemon.ts` never writes it to the persisted event table, so
   * it can ONLY reach this view through a live `ws.on` push, never through
   * the `/api/devices/:id/events` fetch these other tests exercise.
   */
  describe('device.inspector.status — surfaced live, since the core never persists it', () => {
    test('a restart cycle is rendered in the main stream, naming the attempt and reason', async () => {
      const { getByText } = renderWithApi(<DeviceLog deviceId="dev-5" deviceOffline={false} />, {
        '/api/devices/dev-5/events*': { body: { items: [], nextCursor: null, total: 0 } },
      })
      await waitFor(() => expect(getByText('No main events yet')).toBeTruthy())

      emit({
        type: 'device.inspector.status',
        payload: { deviceId: 'dev-5', state: 'restarting', reason: 'two consecutive ping failures', attempt: 2 },
      })

      await waitFor(() => expect(getByText('Inspector restarting')).toBeTruthy())
      expect(getByText('Restart attempt 2: two consecutive ping failures')).toBeTruthy()
    })

    test('the circuit breaker\'s `dead` state renders as a degraded inspector, naming the fallback', async () => {
      const { getByText } = renderWithApi(<DeviceLog deviceId="dev-6" deviceOffline={false} />, {
        '/api/devices/dev-6/events*': { body: { items: [], nextCursor: null, total: 0 } },
      })
      await waitFor(() => expect(getByText('No main events yet')).toBeTruthy())

      emit({
        type: 'device.inspector.status',
        payload: { deviceId: 'dev-6', state: 'dead', reason: 'ui-server spent 3 restart cycle(s) in the last 600s' },
      })

      await waitFor(() => expect(getByText('Inspector degraded')).toBeTruthy())
      expect(getByText(/Gave up — falling back to uiautomator-dump/)).toBeTruthy()
    })

    test('a `healthy` transition (recovery) is rendered too, not just failures', async () => {
      const { getByText } = renderWithApi(<DeviceLog deviceId="dev-8" deviceOffline={false} />, {
        '/api/devices/dev-8/events*': { body: { items: [], nextCursor: null, total: 0 } },
      })
      await waitFor(() => expect(getByText('No main events yet')).toBeTruthy())

      emit({ type: 'device.inspector.status', payload: { deviceId: 'dev-8', state: 'healthy' } })

      await waitFor(() => expect(getByText('Inspector healthy')).toBeTruthy())
    })

    test('a push for a DIFFERENT device is ignored', async () => {
      const { getByText, queryByText } = renderWithApi(<DeviceLog deviceId="dev-7" deviceOffline={false} />, {
        '/api/devices/dev-7/events*': { body: { items: [], nextCursor: null, total: 0 } },
      })
      await waitFor(() => expect(getByText('No main events yet')).toBeTruthy())

      emit({ type: 'device.inspector.status', payload: { deviceId: 'some-other-device', state: 'dead', reason: 'unrelated' } })

      // Give any (incorrect) update a chance to land, then confirm nothing did.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(queryByText('Inspector degraded')).toBeNull()
      expect(getByText('No main events yet')).toBeTruthy()
    })
  })
})
