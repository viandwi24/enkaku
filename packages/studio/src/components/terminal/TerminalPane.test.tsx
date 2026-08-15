import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * Plan 93 §3.5, §3.9, §5 step 93.5 — `TerminalPane`'s arrow-up history used
 * to live only in a `useState` (F3), wiped on every remount. `shell.exec`
 * now records through the same store the fan-out console uses, and this
 * component seeds its own recall from `GET /api/command-runs?mine=1&limit=50`
 * on mount. The transcript itself talks to `@/lib/ws`, which has nothing to
 * connect to under `happy-dom` — replaced with a stand-in, same pattern
 * `DeviceLog.test.tsx` uses for the same reason.
 */

mock.module('@/lib/ws', () => ({
  ws: {
    on: () => () => {},
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(true)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 's1',
    isConnected: () => true,
    send: () => {},
    request: () => Promise.reject(new Error('ws not available in test')),
  },
  coreBase: () => 'http://localhost:7700',
  newId: (() => {
    let n = 0
    return () => `test-id-${n++}`
  })(),
}))

const { TerminalPane } = await import('./TerminalPane')

afterEach(() => {
  cleanup()
})

/** A minimal, schema-satisfying `CommandRunSummary` (`@enkaku/protocol`'s `CommandRunSummarySchema`). */
function summary(cmd: string, startedAt: number) {
  return {
    id: `run-${startedAt}`,
    cmd,
    target: { deviceIds: ['dev-1'] },
    savedCommandId: null,
    stageFirstN: 0,
    stage: 1,
    concurrency: 0,
    status: 'ok',
    acknowledged: false,
    createdBy: 'user-1',
    startedAt,
    finishedAt: startedAt + 1,
    counts: { total: 1, pending: 0, running: 0, ok: 1, failed: 0, skipped: 0, cancelled: 0 },
  }
}

describe('TerminalPane history seeding (plan 93 §3.5, §3.9)', () => {
  test('ArrowUp on a fresh mount recalls the most recent command from GET /api/command-runs?mine=1 — reloading the page no longer wipes recall', async () => {
    const { getByPlaceholderText, apiMock } = renderWithApi(
      <TerminalPane deviceId="dev-1" canType={true} onRunAsStream={() => {}} />,
      {
        '/api/command-runs*': {
          // Server order is newest-first (`startedAt DESC`) — this is the
          // literal shape `GET /api/command-runs?mine=1&limit=50` returns.
          body: { items: [summary('second cmd', 200), summary('first cmd', 100)], nextCursor: null, total: null },
        },
      },
    )

    await waitFor(() => expect(apiMock.calls.some((c) => c.path.startsWith('/api/command-runs'))).toBe(true))
    const call = apiMock.calls.find((c) => c.path.startsWith('/api/command-runs'))
    expect(call?.path).toContain('mine=1')
    expect(call?.path).toContain('limit=50')

    const input = getByPlaceholderText('getprop ro.serialno') as HTMLInputElement
    // Give the fetch's `.then` a tick to land before pressing ArrowUp.
    await waitFor(() => {
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input.value).toBe('second cmd')
    })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('first cmd')
  })

  test('a failed or missing /api/command-runs leaves the terminal usable — history is a convenience, never load-bearing', async () => {
    const { getByPlaceholderText } = renderWithApi(<TerminalPane deviceId="dev-1" canType={true} onRunAsStream={() => {}} />, {})

    const input = getByPlaceholderText('getprop ro.serialno') as HTMLInputElement
    // No mock registered for `/api/command-runs*` → the harness 404s it;
    // the component must swallow that rather than throw or show an error.
    await new Promise((r) => setTimeout(r, 0))
    expect(input).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('')
  })
})
