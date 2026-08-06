import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// Same reasoning as `DeviceLog.test.tsx`: `CrashesPanel` talks straight to
// `@/lib/ws`, which needs a real `WebSocket` this test environment does not
// have, so the module is replaced. `screen` is avoided for the same
// module-load-order reason documented there — every assertion below reads
// off `renderWithApi`'s own return value instead.
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

const { CrashesPanel } = await import('./CrashesPanel')

afterEach(cleanup)

describe('CrashesPanel', () => {
  test('renders a crash event once loaded', async () => {
    const { getByText } = renderWithApi(<CrashesPanel deviceId="dev-1" />, {
      '/api/devices/dev-1/events*': {
        body: {
          items: [
            {
              id: 'e1',
              deviceId: 'dev-1',
              stream: 'main',
              kind: 'app.crashed',
              actor: null,
              meta: { kind: 'crash', package: 'com.example.app', process: 'com.example.app', exception: 'NullPointerException', message: '', system: false, truncated: false },
              at: 1000,
            },
          ],
          nextCursor: null,
          total: 1,
        },
      },
    })
    await waitFor(() => expect(getByText('com.example.app')).toBeTruthy())
  })

  test('no crashes yet renders the empty state, not a crash', async () => {
    const { getByText } = renderWithApi(<CrashesPanel deviceId="dev-2" />, {
      '/api/devices/dev-2/events*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(getByText('No crashes recorded')).toBeTruthy())
  })
})
