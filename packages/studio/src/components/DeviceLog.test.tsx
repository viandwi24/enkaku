import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `DeviceLog` talks straight to `@/lib/ws` (subscribe/unsubscribe, live
 * `device.event` pushes) — a real `WebSocket` has nothing to connect to in
 * `happy-dom`, so the module is replaced with a no-op stand-in, the same way
 * `lib/test/nav.ts` replaces `next/navigation`. Only the fetch path (`GET
 * .../events`, now `DeviceEventsResponseSchema`) is exercised here; the WS
 * subscription is not this test's concern.
 */
mock.module('@/lib/ws', () => ({
  ws: {
    on: () => () => {},
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
  newId: () => 'test-id',
}))

const { DeviceLog } = await import('./DeviceLog')

afterEach(cleanup)

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
})
