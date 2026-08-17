import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// Same seam every other device-popup/Settings-section test uses: `api()`
// reads `coreBase()` from `@/lib/ws`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { PreparationPanel } = await import('./PreparationPanel')

afterEach(cleanup)

/**
 * Plan 106 §5 step 106.3 — the popup surface for `devices.preparation`.
 * Before this step the only way to see it was `curl`; these tests cover
 * the two things the owner's own report asked for: which component failed
 * and why, and that Retry actually clears it — plus the defect class named
 * in this pass's own brief, that the guest agent (bridged, not registered
 * in `preparation/registry.ts`) must never be silently missing from this
 * surface.
 */
describe('PreparationPanel', () => {
  test('renders a row per component, with its state, reason, and version', async () => {
    const { getByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/preparation': {
        body: {
          'guest-agent': { state: 'ready', version: '1.2.0', reason: null, checkedAt: 1700000000, attempts: 0, nextAttemptAt: null },
          'ui-server': {
            state: 'failed',
            version: null,
            reason: 'E_CHECKSUM_MISSING: no sha256 pinned for this build',
            checkedAt: 1700000000,
            attempts: 3,
            nextAttemptAt: null,
          },
        },
      },
    })
    await waitFor(() => expect(getByText('Guest agent')).toBeTruthy())
    expect(getByText('UI server (openatx)')).toBeTruthy()
    expect(getByText('ready')).toBeTruthy()
    expect(getByText('failed')).toBeTruthy()
    expect(getByText('E_CHECKSUM_MISSING: no sha256 pinned for this build')).toBeTruthy()
    expect(getByText('1.2.0')).toBeTruthy()
  })

  test('the guest agent still gets a row when the response has no entry for it yet — never silently omitted', async () => {
    const { getByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/preparation': {
        body: {
          'ui-server': { state: 'ready', version: '2003003', reason: null, checkedAt: 1700000000, attempts: 0, nextAttemptAt: null },
        },
      },
    })
    await waitFor(() => expect(getByText('UI server (openatx)')).toBeTruthy())
    // Not in the response at all — still rendered, defaulted to `absent`.
    expect(getByText('Guest agent')).toBeTruthy()
    expect(getByText('not installed')).toBeTruthy()
  })

  test('unsupported reads differently from failed, and offers no retry action', async () => {
    const { getByText, queryByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/preparation': {
        body: {
          'ui-server': {
            state: 'unsupported',
            version: null,
            reason: 'Android API 21 is below the minimum this component supports',
            checkedAt: 1700000000,
            attempts: 0,
            nextAttemptAt: null,
          },
        },
      },
    })
    await waitFor(() => expect(getByText('unsupported')).toBeTruthy())
    expect(getByText('Android API 21 is below the minimum this component supports')).toBeTruthy()
    expect(queryByText('failed')).toBeNull()
    expect(queryByText('Retry')).toBeNull()
  })

  test('Retry clears exactly one component and re-renders its new state, leaving the other row untouched', async () => {
    const { getByText, getAllByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/preparation': {
        body: {
          'guest-agent': { state: 'ready', version: '1.2.0', reason: null, checkedAt: 1700000000, attempts: 0, nextAttemptAt: null },
          'ui-server': { state: 'failed', version: null, reason: 'install failed', checkedAt: 1700000000, attempts: 3, nextAttemptAt: null },
        },
      },
      '/api/devices/dev-1/preparation/ui-server/retry': {
        body: { state: 'ready', version: '2003003', reason: null, checkedAt: 1700000100, attempts: 0, nextAttemptAt: null },
      },
    })
    await waitFor(() => expect(getByText('Retry')).toBeTruthy())
    fireEvent.click(getByText('Retry'))
    await waitFor(() => expect(getAllByText('ready')).toHaveLength(2))
    expect(getByText('2003003')).toBeTruthy()
  })

  test('an unrecognised component id still renders, humanized, rather than being hidden', async () => {
    const { getByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/preparation': {
        body: {
          'future-widget': { state: 'ready', version: '1.0', reason: null, checkedAt: 1700000000, attempts: 0, nextAttemptAt: null },
        },
      },
    })
    await waitFor(() => expect(getByText('Future Widget')).toBeTruthy())
  })

  test('canUse=false disables retry and check-now, with an explanation', async () => {
    const { getByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={false} />, {
      '/api/devices/dev-1/preparation': {
        body: {
          'ui-server': { state: 'failed', version: null, reason: 'install failed', checkedAt: 1700000000, attempts: 3, nextAttemptAt: null },
        },
      },
    })
    await waitFor(() => expect(getByText('Retry')).toBeTruthy())
    expect((getByText('Retry').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect((getByText('Recheck all').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(getByText('Take control of this device to retry a component.')).toBeTruthy()
  })

  test('a load failure surfaces as a named error, not a crash', async () => {
    const { getByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-1/preparation': { status: 500 },
    })
    await waitFor(() => expect(getByText(/did not understand|Request failed/)).toBeTruthy())
  })

  describe('a provisioning row (plan 106 §5 step 106.7)', () => {
    test('shows a live "installing…" badge, elapsed time, and no retry action — never a percentage', async () => {
      const { getByText, queryByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
        '/api/devices/dev-1/preparation': {
          body: {
            'ui-server': {
              state: 'provisioning',
              version: null,
              reason: null,
              checkedAt: Math.floor(Date.now() / 1000) - 12,
              attempts: 0,
              nextAttemptAt: null,
            },
          },
        },
      })
      await waitFor(() => expect(getByText('installing…')).toBeTruthy())
      expect(getByText(/Running for/)).toBeTruthy()
      expect(getByText('12s')).toBeTruthy()
      expect(document.body.textContent).not.toMatch(/%/)
      // No Retry/Update action for a state a retry cannot change — the
      // guest agent's own FORCED row (absent, no entry in this response)
      // legitimately has its own "Check now", so that label is not asserted
      // absent here; only "Retry", which no row in this fixture should show.
      expect(queryByText('Retry')).toBeNull()
    })

    test('the "started" row reads from the same checkedAt the elapsed-time readout uses', async () => {
      const { getByText } = renderWithApi(<PreparationPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />, {
        '/api/devices/dev-1/preparation': {
          body: {
            'ui-server': { state: 'provisioning', version: null, reason: null, checkedAt: Math.floor(Date.now() / 1000), attempts: 0, nextAttemptAt: null },
          },
        },
      })
      await waitFor(() => expect(getByText('started')).toBeTruthy())
    })
  })
})
