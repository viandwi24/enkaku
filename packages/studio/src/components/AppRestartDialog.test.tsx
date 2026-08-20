import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// See `AdbEndpointCard.test.tsx` for why `@/lib/ws` needs mocking even
// though this component never subscribes to it directly: `api()` reads
// `coreBase()` from there, and `happy-dom`'s default `location.origin` is
// the literal string `"null"`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://core.test',
  newId: () => 'test-id',
}))

const { AppRestartDialog } = await import('./AppRestartDialog')

afterEach(cleanup)

const IDLE_BARE_PREVIEW = { mode: 'bare', devicesTotal: 20, sessionsActive: 2, leasesHeld: 0, jobsRunning: 0 }

describe('AppRestartDialog', () => {
  test('opening the dialog fetches the live preview and states the cost — and never adb-restart wording', async () => {
    const { getByText, getByRole, queryByText } = renderWithApi(<AppRestartDialog trigger={<button>Restart Enkaku</button>} />, {
      '/api/tools/app/restart-preview': { body: IDLE_BARE_PREVIEW },
    })
    fireEvent.click(getByText('Restart Enkaku'))
    await waitFor(() => expect(getByText(/all 20 devices go dark/)).toBeTruthy())
    expect(getByText(/2 live screens stop and must be reopened/)).toBeTruthy()
    expect(getByText(/whole application/)).toBeTruthy()
    // Distinctness from the adb-only dialog — never talks about "the adb server" restarting.
    expect(queryByText(/adb server/)).toBeNull()
    expect(getByRole('button', { name: /^Restart Enkaku$/ })).toBeTruthy()
  })

  test('bare mode: the copy names the health-verified handoff, never a bare promise', async () => {
    const { getByText } = renderWithApi(<AppRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/app/restart-preview': { body: IDLE_BARE_PREVIEW },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/no supervisor watching it/)).toBeTruthy())
    expect(getByText(/only switches over once that copy proves itself healthy/)).toBeTruthy()
  })

  test('docker mode: the copy promises the container restart policy, not a self-respawn', async () => {
    const { getByText, queryByText } = renderWithApi(<AppRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/app/restart-preview': { body: { ...IDLE_BARE_PREVIEW, mode: 'docker' } },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/running in Docker/)).toBeTruthy())
    expect(getByText(/restart: unless-stopped/)).toBeTruthy()
    expect(queryByText(/no supervisor watching it/)).toBeNull()
  })

  test('systemd mode: the copy names the service unit, not a self-respawn', async () => {
    const { getByText, queryByText } = renderWithApi(<AppRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/app/restart-preview': { body: { ...IDLE_BARE_PREVIEW, mode: 'systemd' } },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/running under systemd/)).toBeTruthy())
    expect(queryByText(/no supervisor watching it/)).toBeNull()
  })

  test('a busy farm shows the force checkbox and disables confirm until it is checked', async () => {
    const busyPreview = { ...IDLE_BARE_PREVIEW, leasesHeld: 2, jobsRunning: 1 }
    const { getByText, getByRole } = renderWithApi(<AppRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/app/restart-preview': { body: busyPreview },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/Restart anyway/)).toBeTruthy())
    expect(getByText(/1 running job fails/)).toBeTruthy()
    expect(getByText(/Control is released on 2 devices/)).toBeTruthy()

    const confirm = getByText('Restart Enkaku').closest('button')
    expect(confirm?.disabled).toBe(true)

    fireEvent.click(getByRole('checkbox'))
    await waitFor(() => expect(getByText('Restart Enkaku').closest('button')?.disabled).toBe(false))
  })

  // Asserting on the recorded network call rather than waiting for the
  // dialog to visually unmount, matching `AdbRestartDialog.test.tsx`'s own
  // precedent — Radix `Dialog`'s exit-animation bookkeeping does not settle
  // deterministically under happy-dom.
  test('confirming posts { force: false } for an idle farm', async () => {
    const { getByText, apiMock } = renderWithApi(<AppRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/app/restart-preview': { body: IDLE_BARE_PREVIEW },
      '/api/tools/app/restart': {
        body: { mode: 'bare', outcome: 'verified', durationMs: 8000, sessionsClosed: 2, leasesReleased: 0, jobsFailed: [] },
      },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/all 20 devices/)).toBeTruthy())
    fireEvent.click(getByText('Restart Enkaku'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/tools/app/restart')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/tools/app/restart')
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ force: false })
  })

  test('confirming with the force box checked posts { force: true }', async () => {
    const busyPreview = { ...IDLE_BARE_PREVIEW, leasesHeld: 1, jobsRunning: 0 }
    const { getByText, getByRole, apiMock } = renderWithApi(<AppRestartDialog trigger={<button>open</button>} />, {
      '/api/tools/app/restart-preview': { body: busyPreview },
      '/api/tools/app/restart': {
        body: { mode: 'bare', outcome: 'verified', durationMs: 1, sessionsClosed: 0, leasesReleased: 1, jobsFailed: [] },
      },
    })
    fireEvent.click(getByText('open'))
    await waitFor(() => expect(getByText(/Restart anyway/)).toBeTruthy())
    fireEvent.click(getByRole('checkbox'))
    await waitFor(() => expect(getByText('Restart Enkaku').closest('button')?.disabled).toBe(false))
    fireEvent.click(getByText('Restart Enkaku'))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/tools/app/restart')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/tools/app/restart')
    expect(call?.body).toEqual({ force: true })
  })
})
