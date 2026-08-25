import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The success toast is the ONLY place this dialog names a device, so plan 124
 * §4.4's rule is only testable through it. Stubbing the whole `sonner` module
 * — `Toaster` included — rather than `toast` alone: `@enkaku/ui` re-exports
 * `Toaster`, and a `toast`-only stub makes the module graph fail to link.
 */
const toastSuccess = mock((_message: string, _opts?: { description?: string }) => {})
const toastError = mock((_message: string, _opts?: { description?: string }) => {})
mock.module('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
  Toaster: () => null,
}))

// See `AdbEndpointCard.test.tsx` for why `@/lib/ws` needs mocking even
// though this component never subscribes to it directly: `api()` reads
// `coreBase()` from there, and `happy-dom`'s default `location.origin` is
// the literal string `"null"`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://core.test',
  newId: () => 'test-id',
}))

const { AdbRestartDialog } = await import('./AdbRestartDialog')

afterEach(cleanup)

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
})

const IDLE_PREVIEW = {
  devicesTotal: 20,
  sessionsActive: 2,
  leasesHeld: 0,
  jobsRunning: 0,
  networkDevicesWithEndpoint: 12,
  restartCooldownSec: 60,
}

describe('AdbRestartDialog', () => {
  test('opening the dialog fetches the live preview and states the cost before the click', async () => {
    const { getByText, getByRole } = renderWithApi(<AdbRestartDialog trigger={<button>Restart adb server</button>} />, {
      '/api/tools/adb/restart-preview': { body: IDLE_PREVIEW },
    })
    fireEvent.click(getByText('Restart adb server'))
    await waitFor(() => expect(getByText(/all 20 devices disconnect and reconnect/)).toBeTruthy())
    expect(getByText(/2 live screens stop and resume/)).toBeTruthy()
    expect(getByText(/Network devices/)).toBeTruthy()
    expect(getByText(/12 here/)).toBeTruthy()
    // The confirm button is the destructive action, findable by its own label.
    expect(getByRole('button', { name: /^Restart adb server$/ })).toBeTruthy()
  })

  test('an idle farm: the confirm button is enabled with no force checkbox', async () => {
    const { getByText, queryByRole } = renderWithApi(<AdbRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/adb/restart-preview': { body: IDLE_PREVIEW },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/all 20 devices/)).toBeTruthy())
    expect(queryByRole('checkbox')).toBeNull()
    const confirm = getByText('Restart adb server').closest('button')
    expect(confirm?.disabled).toBe(false)
  })

  test('a busy farm shows the force checkbox and disables confirm until it is checked', async () => {
    const busyPreview = { ...IDLE_PREVIEW, leasesHeld: 2, jobsRunning: 1 }
    const { getByText, getByRole } = renderWithApi(<AdbRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/adb/restart-preview': { body: busyPreview },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/Restart anyway/)).toBeTruthy())
    expect(getByText(/1 running job fails/)).toBeTruthy()
    expect(getByText(/Control is released on 2 devices/)).toBeTruthy()

    const confirm = getByText('Restart adb server').closest('button')
    expect(confirm?.disabled).toBe(true)

    fireEvent.click(getByRole('checkbox'))
    await waitFor(() => expect(getByText('Restart adb server').closest('button')?.disabled).toBe(false))
  })

  // These two assert on the recorded network call rather than waiting for
  // the dialog to visually unmount: Radix `Dialog`'s exit-animation
  // bookkeeping (`Presence`) does not settle deterministically under
  // happy-dom (no real animation-frame timing), which made a
  // wait-for-unmount assertion here flaky in a way unrelated to this
  // component's own behaviour. `apiMock.calls` is populated synchronously
  // by the mocked `fetch`, before any close animation would even start.
  test('confirming posts { force: false } for an idle farm and reports the result', async () => {
    const { getByText, apiMock } = renderWithApi(<AdbRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/adb/restart-preview': { body: IDLE_PREVIEW },
      '/api/tools/adb/restart': {
        body: {
          reason: 'restart',
          durationMs: 8000,
          sessionsClosed: 2,
          leasesReleased: 0,
          jobsFailed: [],
          devicesBefore: 20,
          devicesAfter: 20,
          reattachAttempted: 12,
          reattachSucceeded: 12,
          reattachFailed: [],
          serverVersion: '0041',
        },
      },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/all 20 devices/)).toBeTruthy())
    fireEvent.click(getByText('Restart adb server'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/tools/adb/restart')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/tools/adb/restart')
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ force: false })
  })

  test('confirming with the force box checked posts { force: true }', async () => {
    const busyPreview = { ...IDLE_PREVIEW, leasesHeld: 1, jobsRunning: 0 }
    const { getByText, getByRole, apiMock } = renderWithApi(<AdbRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/adb/restart-preview': { body: busyPreview },
      '/api/tools/adb/restart': {
        body: {
          reason: 'restart',
          durationMs: 1,
          sessionsClosed: 0,
          leasesReleased: 1,
          jobsFailed: [],
          devicesBefore: 20,
          devicesAfter: 20,
          reattachAttempted: 0,
          reattachSucceeded: 0,
          reattachFailed: [],
          serverVersion: null,
        },
      },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/Restart anyway/)).toBeTruthy())
    fireEvent.click(getByRole('checkbox'))
    await waitFor(() => expect(getByText('Restart adb server').closest('button')?.disabled).toBe(false))
    fireEvent.click(getByText('Restart adb server'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/tools/adb/restart')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/tools/adb/restart')
    expect(call?.body).toEqual({ force: true })
  })
  /**
   * Plan 124 §4.4 Group D, criterion 6. `reattachFailed` carries `number` as
   * its own field and this dialog composes it exactly once — a farm of
   * identical models otherwise reports `SM-F721U1, SM-F721U1`, which names
   * nothing and is the exact complaint plan 124 was opened from. The second
   * row has `number: null` and must come back BARE: no `#`, no `#null`
   * (criterion 7).
   */
  test('names every device that did not reconnect by number, and a numberless one bare', async () => {
    const { getByText, apiMock } = renderWithApi(<AdbRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/adb/restart-preview': { body: IDLE_PREVIEW },
      '/api/tools/adb/restart': {
        body: {
          reason: 'restart',
          durationMs: 8000,
          sessionsClosed: 0,
          leasesReleased: 0,
          jobsFailed: [],
          devicesBefore: 20,
          devicesAfter: 18,
          reattachAttempted: 12,
          reattachSucceeded: 10,
          reattachFailed: [
            { stableId: 'stable-a', label: 'SM-F721U1', number: 7 },
            { stableId: 'stable-b', label: 'SM-F721U1', number: null },
          ],
          serverVersion: '0041',
        },
      },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/all 20 devices/)).toBeTruthy())
    fireEvent.click(getByText('Restart adb server'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/tools/adb/restart')).toBe(true))
    await waitFor(() => expect(toastSuccess.mock.calls.length).toBe(1))
    const description = toastSuccess.mock.calls[0]?.[1]?.description ?? ''
    expect(description).toContain('#7 SM-F721U1')
    // The numberless device is named bare — asserted on the joined string so a
    // stray `#null` or a doubled `#7 #7` fails here rather than shipping.
    expect(description).toContain('#7 SM-F721U1, SM-F721U1')
    expect(description).not.toContain('#null')
  })
})
