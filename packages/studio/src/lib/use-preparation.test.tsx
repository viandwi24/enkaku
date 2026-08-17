import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { installApiMock } from './test/render'

/**
 * `usePreparation` (plan 106 §5 step 106.7) — the shared source behind both
 * the device popup's screen-panel overlay and `PreparationPanel`'s live
 * provisioning row. Covered indirectly through both of those already; this
 * file proves the hook itself, in isolation: the initial fetch, and that a
 * `device.preparation`/`device.agent` completion event triggers an
 * immediate refetch rather than waiting for the next poll tick — the "event
 * for finishing, poll for starting" split the hook's own doc comment
 * describes. The poll interval's own 3s tick is not separately exercised
 * here (no fake-timer harness in this suite) — `setInterval(load, POLL_MS)`
 * is the entire mechanism, already covered by inspection and by the
 * constant it reads.
 */
let wsListeners = new Set<(m: { type: string; payload: unknown }) => void>()
mock.module('./ws', () => ({
  ws: {
    on: (cb: (m: { type: string; payload: unknown }) => void) => {
      wsListeners.add(cb)
      return () => wsListeners.delete(cb)
    },
    send: () => {},
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { usePreparation } = await import('./use-preparation')

function Probe({ deviceId }: { deviceId: string }) {
  const { preparation, loadError } = usePreparation(deviceId)
  return <div data-testid="probe">{loadError ? `error:${loadError}` : JSON.stringify(preparation)}</div>
}

afterEach(() => {
  cleanup()
  wsListeners = new Set()
})

describe('usePreparation', () => {
  test('fetches GET /:id/preparation on mount', async () => {
    const mockApi = installApiMock({
      '/api/devices/dev-1/preparation': {
        body: { 'ui-server': { state: 'ready', version: '1', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null } },
      },
    })
    const { getByTestId } = render(<Probe deviceId="dev-1" />)
    await waitFor(() => expect(getByTestId('probe').textContent).toContain('"state":"ready"'))
    mockApi.restore()
  })

  test('a device.preparation event for the SAME device triggers an immediate refetch', async () => {
    let call = 0
    const mockApi = installApiMock({
      '/api/devices/dev-1/preparation': () => {
        call += 1
        return {
          body: {
            'ui-server':
              call === 1
                ? { state: 'provisioning', version: null, reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null }
                : { state: 'ready', version: '2', reason: null, checkedAt: 2, attempts: 0, nextAttemptAt: null },
          },
        }
      },
    })
    const { getByTestId } = render(<Probe deviceId="dev-1" />)
    await waitFor(() => expect(getByTestId('probe').textContent).toContain('"state":"provisioning"'))
    expect(call).toBe(1)

    for (const cb of wsListeners) cb({ type: 'device.event', payload: { deviceId: 'dev-1', stream: 'main', kind: 'device.preparation', meta: {} } })

    await waitFor(() => expect(getByTestId('probe').textContent).toContain('"state":"ready"'))
    expect(call).toBe(2)
    mockApi.restore()
  })

  test('an event for a DIFFERENT device is ignored', async () => {
    let call = 0
    const mockApi = installApiMock({
      '/api/devices/dev-1/preparation': () => {
        call += 1
        return { body: {} }
      },
    })
    render(<Probe deviceId="dev-1" />)
    await waitFor(() => expect(call).toBe(1))

    for (const cb of wsListeners) cb({ type: 'device.event', payload: { deviceId: 'dev-2', stream: 'main', kind: 'device.preparation', meta: {} } })
    // No new fetch — give the event loop a turn, then assert the count held.
    await new Promise((r) => setTimeout(r, 10))
    expect(call).toBe(1)
    mockApi.restore()
  })

  test('a load failure surfaces on loadError rather than throwing', async () => {
    const mockApi = installApiMock({ '/api/devices/dev-1/preparation': { status: 500 } })
    const { getByTestId } = render(<Probe deviceId="dev-1" />)
    await waitFor(() => expect(getByTestId('probe').textContent).toContain('error:'))
    mockApi.restore()
  })
})
