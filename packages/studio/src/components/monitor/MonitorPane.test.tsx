import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `MonitorPane` drives everything (start/stop, one-shot runs, live lines)
 * through `ws.request`/`ws.on` — there is no `WebSocket` to connect to in
 * `happy-dom`, so the module is replaced. The mocked `ws.request` answers
 * `monitor.start` so the pane reaches its loaded state without a real
 * socket; `api()` (the `monitor/save` call, now `MonitorSaveResponseSchema`)
 * is exercised separately through `renderWithApi`'s fetch mock.
 */
const oneshotRequests: Array<{ deviceId: string; kind: string; options?: unknown }> = []
mock.module('@/lib/ws', () => ({
  ws: {
    on: () => () => {},
    onReconnected: () => () => {},
    send: () => {},
    request: (msg: { type: string; payload?: { deviceId: string; kind: string; options?: unknown } }) => {
      if (msg.type === 'monitor.start') {
        return Promise.resolve({ type: 'monitor.started', payload: { streamId: 'stream-1', backlog: ['line one', 'line two'] } })
      }
      if (msg.type === 'monitor.oneshot' && msg.payload) {
        oneshotRequests.push(msg.payload)
        return Promise.resolve({ type: 'monitor.result', payload: { deviceId: msg.payload.deviceId, kind: msg.payload.kind, text: 'ok', truncated: false } })
      }
      return Promise.reject(new Error(`unexpected ws.request in test: ${msg.type}`))
    },
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { MonitorPane } = await import('./MonitorPane')

// happy-dom does not implement the Pointer Capture APIs Radix's Select uses
// to open on click — polyfilled locally (not in the global happydom preload,
// since no other component test in this package needs it).
Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})

afterEach(() => {
  cleanup()
  oneshotRequests.length = 0
})

describe('MonitorPane', () => {
  test('starts a logcat stream and renders the backlog', async () => {
    const { getByText } = renderWithApi(<MonitorPane deviceId="dev-1" />, {})
    await waitFor(() => expect(getByText('line one')).toBeTruthy())
    expect(getByText('line two')).toBeTruthy()
  })

  /** Plan 90 §3.5, step 90.7 — the picker listed six of the seven `MonitorKind`s
   * and omitted `crash`, the always-on crash watcher's own feed. */
  test('crash is selectable in the kind picker (plan 90 §3.5)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<MonitorPane deviceId="dev-1" />, {})
    const kindTrigger = screen.getAllByRole('combobox')[0]
    await user.click(kindTrigger!)
    await waitFor(() => expect(screen.getByText('Crash')).toBeTruthy())
  })

  /** Plan 90 §3.5, step 90.7 — `meminfo` gains an optional `package` field,
   * and it must actually reach the `monitor.oneshot` WS request, not just
   * exist in a schema nothing calls. */
  test('meminfo: entering a package sends it as the monitor.oneshot options (plan 90 §3.5)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<MonitorPane deviceId="dev-1" />, {})
    const kindTrigger = screen.getAllByRole('combobox')[0]
    await user.click(kindTrigger!)
    await user.click(await screen.findByText('Memory'))
    await waitFor(() => expect(oneshotRequests.some((r) => r.kind === 'meminfo')).toBe(true))

    const packageInput = await screen.findByPlaceholderText(/Package \(optional/)
    await user.type(packageInput, 'com.example.app')
    await user.tab() // blur — applies the draft, same pattern as the logcat filter/tag fields

    await waitFor(() => expect(oneshotRequests.some((r) => r.kind === 'meminfo' && (r.options as { package?: string })?.package === 'com.example.app')).toBe(true))
  })
})
