import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// Same seam every other device-scoped panel test uses: `api()` reads
// `coreBase()` from `@/lib/ws`, and `usePreparation` subscribes to `ws`.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

// Toasts are a side channel here — the panel's own contract is that the
// outcome is ON SCREEN. Stubbed so a missing `<Toaster>` cannot fail a test
// for the wrong reason.
mock.module('sonner', () => ({
  toast: Object.assign(() => {}, { success: () => {}, error: () => {}, warning: () => {}, info: () => {} }),
  // `@enkaku/ui`'s own `sonner.tsx` re-exports this — a mock without it makes
  // the whole component library fail to import.
  Toaster: () => null,
}))

const { AgentAlertDetail } = await import('./AgentAlertDetail')

afterEach(cleanup)

const PREP = '/api/devices/dev-1/preparation'
const RETRY = '/api/devices/dev-1/preparation/guest-agent/retry'

/** The real reason off the owner's Xiaomi — a one-line adb command, then a Java stack trace. */
const STACK_REASON = [
  'adb -s 19625O001132 install -r -g apps/guest-agent/app/build/outputs/apk/release/app-release.apk exited 1 after 0.1s',
  '  stderr: adb: failed to install …',
  'java.lang.SecurityException: You need the android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS permission',
  '\tat com.android.server.pm.PackageInstallerService.createSessionInternal(PackageInstallerService.java:973)',
].join('\n')

function prep(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      'guest-agent': {
        state: 'failed',
        version: null,
        reason: STACK_REASON,
        checkedAt: 1700000000,
        attempts: 3,
        nextAttemptAt: null,
        ...overrides,
      },
    },
  }
}

/**
 * The "Agent failed" badge used to carry one fixed `title` — true of every
 * cause, and therefore useless. These cover what replaced it: the verbatim
 * reason (never parsed, never prettified), how many attempts failed and
 * when, a retry scoped to this ONE device, and the states that must not be
 * offered a retry at all.
 */
describe('AgentAlertDetail', () => {
  test('leads with the first line of the reason and keeps the trace behind a toggle', async () => {
    const { getByText, queryByText } = renderWithApi(
      <AgentAlertDetail deviceId="dev-1" deviceLabel="25128PC17G" fallbackState="failed" />,
      { [PREP]: prep() },
    )
    await waitFor(() =>
      expect(getByText(/adb -s 19625O001132 install -r -g .* exited 1 after 0\.1s/)).toBeTruthy(),
    )
    // The trace is not on screen until asked for.
    expect(queryByText(/PackageInstallerService\.createSessionInternal/)).toBeNull()
    fireEvent.click(getByText(/Show the rest \(3 more lines\)/))
    expect(getByText(/PackageInstallerService\.createSessionInternal/)).toBeTruthy()
  })

  test('a one-line reason gets no toggle at all', async () => {
    const { getByText, queryByText } = renderWithApi(
      <AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />,
      { [PREP]: prep({ reason: 'bad or missing token' }) },
    )
    await waitFor(() => expect(getByText('bad or missing token')).toBeTruthy())
    expect(queryByText(/Show the rest/)).toBeNull()
  })

  test('shows the attempt count and when it was last checked', async () => {
    const { getByText } = renderWithApi(<AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />, {
      [PREP]: prep({ reason: 'bad or missing token' }),
    })
    await waitFor(() => expect(getByText('3')).toBeTruthy())
    expect(getByText(/failed attempts/)).toBeTruthy()
    expect(getByText(/last checked/)).toBeTruthy()
  })

  test('says the automatic retries are used up when the bound is exhausted', async () => {
    const { getByText } = renderWithApi(<AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />, {
      [PREP]: prep({ reason: 'bad or missing token', attempts: 3, nextAttemptAt: null }),
    })
    await waitFor(() => expect(getByText(/Automatic retries for this device are used up/)).toBeTruthy())
    expect(getByText(/starts a fresh pass and resets the attempt count/)).toBeTruthy()
  })

  test('inside the backoff window it names the wait, and says the retry overrides it', async () => {
    const soon = Math.floor(Date.now() / 1000) + 42
    const { getByText } = renderWithApi(<AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />, {
      [PREP]: prep({ reason: 'bad or missing token', attempts: 1, nextAttemptAt: soon }),
    })
    await waitFor(() => expect(getByText(/The farm retries this on its own in/)).toBeTruthy())
    expect(getByText(/runs the pass now instead of waiting out that window/)).toBeTruthy()
  })

  test('unsupported gets no retry, and says why retrying could not help', async () => {
    const { getByText, queryByText } = renderWithApi(
      <AgentAlertDetail deviceId="dev-1" deviceLabel="old phone" fallbackState="failed" />,
      { [PREP]: prep({ state: 'unsupported', reason: 'api level 21 is below the agent floor of 24' }) },
    )
    await waitFor(() => expect(getByText(/below the guest agent’s Android version floor/)).toBeTruthy())
    expect(queryByText('Retry')).toBeNull()
    expect(queryByText('Check now')).toBeNull()
    expect(queryByText('Update')).toBeNull()
  })

  test('consent-required is neither ready nor failed, and its action is worded for what the operator must do first', async () => {
    const { getByText, queryByText } = renderWithApi(
      <AgentAlertDetail deviceId="dev-1" deviceLabel="CPH2819" fallbackState="failed" />,
      { [PREP]: prep({ state: 'consent-required', reason: 'ACTIVATE_VPN not granted; this build refuses to grant it from adb' }) },
    )
    await waitFor(() => expect(getByText('needs VPN consent')).toBeTruthy())
    // Not "Retry" — the last pass did not go wrong.
    expect(getByText('Check again')).toBeTruthy()
    expect(queryByText('Retry')).toBeNull()
    expect(getByText(/Accept the VPN dialog on the phone itself/)).toBeTruthy()
  })

  test('an unrecognised state renders plainly and offers no action', async () => {
    const { getByText, queryByText } = renderWithApi(
      <AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />,
      {
        [PREP]: {
          body: {
            // Not one of the six `AgentStateSchema` values this build knows —
            // `usePreparation` drops the record it cannot parse, so the panel
            // falls back to the coarse state the chip already had rather than
            // inventing a reason. The point of this test is that nothing here
            // claims a cause it does not have.
            'guest-agent': { state: 'quarantining', version: null, reason: 'x', checkedAt: 1700000000, attempts: 1, nextAttemptAt: null },
          },
        },
      },
    )
    await waitFor(() => expect(getByText('failed')).toBeTruthy())
    expect(queryByText('Retry')).toBeNull()
  })

  test('retry posts to this ONE device, disables itself while in flight, and reports the outcome on screen', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { getByText, apiMock } = renderWithApi(
      <AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />,
      {
        [PREP]: prep({ reason: 'bad or missing token' }),
        [RETRY]: async () => {
          await gate
          return { body: { state: 'ready', version: '1.4.0', reason: null, checkedAt: 1700000100, attempts: 0, nextAttemptAt: null } }
        },
      },
    )
    await waitFor(() => expect(getByText('Retry')).toBeTruthy())
    fireEvent.click(getByText('Retry'))
    await waitFor(() => expect(getByText('Retrying…')).toBeTruthy())
    expect((getByText('Retrying…').closest('button') as HTMLButtonElement).disabled).toBe(true)
    release?.()
    await waitFor(() => expect(getByText('The guest agent is ready on moto g06 now.')).toBeTruthy())
    const posts = apiMock.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.path).toBe(RETRY)
  })

  test('a retry that lands on failed again says so, rather than reading as success', async () => {
    const { getByText } = renderWithApi(<AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />, {
      [PREP]: prep({ reason: 'bad or missing token' }),
      [RETRY]: {
        body: { state: 'failed', version: null, reason: 'still bad or missing token', checkedAt: 1700000100, attempts: 1, nextAttemptAt: null },
      },
    })
    await waitFor(() => expect(getByText('Retry')).toBeTruthy())
    fireEvent.click(getByText('Retry'))
    await waitFor(() => expect(getByText(/Still failing/)).toBeTruthy())
    // The reason on screen is the one from THIS attempt, not the stale one.
    expect(getByText('still bad or missing token')).toBeTruthy()
  })

  test('a retry the server refuses is reported on screen, never silently swallowed', async () => {
    const { getByText } = renderWithApi(<AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />, {
      [PREP]: prep({ reason: 'bad or missing token' }),
      [RETRY]: { status: 404, body: { error: { code: 'device_not_found', message: 'no such device: dev-1' } } },
    })
    await waitFor(() => expect(getByText('Retry')).toBeTruthy())
    fireEvent.click(getByText('Retry'))
    await waitFor(() => expect(getByText(/The retry could not be started: no such device: dev-1/)).toBeTruthy())
  })

  test('a preparation fetch that fails gets its own error state, not a blank panel', async () => {
    const { getByText } = renderWithApi(<AgentAlertDetail deviceId="dev-1" deviceLabel="moto g06" fallbackState="failed" />, {})
    await waitFor(() => expect(getByText(/no mock for GET/)).toBeTruthy())
  })
})
