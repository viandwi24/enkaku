import { afterEach, describe, expect, mock, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// Same seam `NetworkPanel.test.tsx` already uses: `api()`/`fetchGuestAgentStatus`
// both read `coreBase()` from `@/lib/ws`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { AgentPanel } = await import('./AgentPanel')

afterEach(cleanup)

/**
 * Plan 90 §5 step 90.6 — the one thing this step MUST do, the render half:
 * a response carrying `outdated` and one carrying `failed` both PARSE
 * (`packages/protocol/src/api/devices.test.ts`) and RENDER (here) — proving
 * that widening `GuestAgentStatusResponseSchema.state` did not leave
 * `AgentPanel` throwing client-side the first time a real device reports
 * either one.
 */
describe('AgentPanel', () => {
  test('not-installed offers Install and no Remove (nothing is on the device to remove)', async () => {
    const { getByText, queryByText } = renderWithApi(
      <AgentPanel deviceId="dev-1" deviceLabel="moto g06" canUse={true} />,
      { '/api/devices/dev-1/guest-agent': { body: { state: 'not-installed' } } },
    )
    await waitFor(() => expect(getByText('Install')).toBeTruthy())
    expect(queryByText('Remove')).toBeNull()
  })

  test('outdated parses and renders: the badge, the reason, and an "Update agent" action', async () => {
    const { getByText } = renderWithApi(<AgentPanel deviceId="dev-2" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-2/guest-agent': {
        body: { state: 'outdated', appVersion: '1.0.0', androidSdkInt: 33, reason: 'installed build predates the pinned manifest artefact' },
      },
    })
    await waitFor(() => expect(getByText('update available')).toBeTruthy())
    expect(getByText('installed build predates the pinned manifest artefact')).toBeTruthy()
    expect(getByText('Update agent')).toBeTruthy()
    // Present, since a build IS on the device.
    expect(getByText('Remove')).toBeTruthy()
  })

  test('failed parses and renders: the badge, the reason, and a "Retry" action', async () => {
    const { getByText } = renderWithApi(<AgentPanel deviceId="dev-3" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-3/guest-agent': {
        body: { state: 'failed', reason: 'E_CHECKSUM_MISSING: no sha256 pinned for this build' },
      },
    })
    await waitFor(() => expect(getByText('failed')).toBeTruthy())
    expect(getByText('E_CHECKSUM_MISSING: no sha256 pinned for this build')).toBeTruthy()
    expect(getByText('Retry')).toBeTruthy()
  })

  test('ready renders the capability list as named facets, deduped and in a fixed order — never raw capability strings', async () => {
    const { getByText, queryByText } = renderWithApi(<AgentPanel deviceId="dev-4" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-4/guest-agent': {
        body: {
          state: 'ready',
          appVersion: '1.2.0',
          androidSdkInt: 34,
          capabilities: ['socks5-route', 'vpn-status', 'egress-probe', 'route-hold', 'screen-label', 'text-input', 'mock-location'],
        },
      },
    })
    await waitFor(() => expect(getByText('ready')).toBeTruthy())
    // The four grouped facet names, plan 90 §5 step 90.6's own list.
    expect(getByText('Network route')).toBeTruthy()
    expect(getByText('Screen label')).toBeTruthy()
    expect(getByText('Keyboard')).toBeTruthy()
    expect(getByText('Location')).toBeTruthy()
    // Never the raw wire strings.
    expect(queryByText('socks5-route')).toBeNull()
    expect(queryByText('text-input')).toBeNull()
    // `ready` has no primary action.
    expect(queryByText('Install')).toBeNull()
    expect(queryByText('Update agent')).toBeNull()
  })

  test('unsupported renders the reason and offers neither an action nor Remove — terminal, not a failure to retry', async () => {
    const { getByText, queryByText } = renderWithApi(<AgentPanel deviceId="dev-5" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-5/guest-agent': {
        body: { state: 'unsupported', reason: 'Android API 24 is below 29 (Android 10)' },
      },
    })
    await waitFor(() => expect(getByText('unsupported')).toBeTruthy())
    expect(getByText('Android API 24 is below 29 (Android 10)')).toBeTruthy()
    expect(queryByText('Retry')).toBeNull()
    expect(queryByText('Remove')).toBeNull()
  })

  test('a load failure surfaces as a named error, not a crash', async () => {
    const { getByText } = renderWithApi(<AgentPanel deviceId="dev-6" deviceLabel="moto g06" canUse={true} />, {
      '/api/devices/dev-6/guest-agent': { status: 500 },
    })
    await waitFor(() => expect(getByText(/did not understand|Request failed/)).toBeTruthy())
  })
})
