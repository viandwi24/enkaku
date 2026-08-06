import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `MonitorPane` drives everything (start/stop, one-shot runs, live lines)
 * through `ws.request`/`ws.on` — there is no `WebSocket` to connect to in
 * `happy-dom`, so the module is replaced. The mocked `ws.request` answers
 * `monitor.start` so the pane reaches its loaded state without a real
 * socket; `api()` (the `monitor/save` call, now `MonitorSaveResponseSchema`)
 * is exercised separately through `renderWithApi`'s fetch mock.
 */
mock.module('@/lib/ws', () => ({
  ws: {
    on: () => () => {},
    onReconnected: () => () => {},
    send: () => {},
    request: (msg: { type: string }) => {
      if (msg.type === 'monitor.start') {
        return Promise.resolve({ type: 'monitor.started', payload: { streamId: 'stream-1', backlog: ['line one', 'line two'] } })
      }
      return Promise.reject(new Error(`unexpected ws.request in test: ${msg.type}`))
    },
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { MonitorPane } = await import('./MonitorPane')

afterEach(cleanup)

describe('MonitorPane', () => {
  test('starts a logcat stream and renders the backlog', async () => {
    const { getByText } = renderWithApi(<MonitorPane deviceId="dev-1" />, {})
    await waitFor(() => expect(getByText('line one')).toBeTruthy())
    expect(getByText('line two')).toBeTruthy()
  })
})
