import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { CommandHistory } from './CommandHistory'

/**
 * Plan 93 §3.9, step 93.7 — "history is durable, per-user, browsable, and
 * re-runnable." Reads the SAME `GET /api/command-runs?mine=1` store
 * `TerminalPane`'s own arrow-up recall already seeds from (step 93.5).
 */

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    cmd: 'getprop ro.build.version.release',
    target: { deviceIds: ['dev-1'] },
    savedCommandId: null,
    stageFirstN: 0,
    stage: 1,
    concurrency: 0,
    status: 'ok',
    acknowledged: false,
    createdBy: 'user-1',
    startedAt: 1_700_000_000,
    finishedAt: 1_700_000_005,
    counts: { total: 1, pending: 0, running: 0, ok: 1, failed: 0, skipped: 0, cancelled: 0 },
    ...overrides,
  }
}

describe('CommandHistory', () => {
  test('renders past runs with an outcome chip and a resolved target label', async () => {
    const { getByText } = renderWithApi(
      <CommandHistory devices={[{ id: 'dev-1', label: 'Pixel 6' } as never]} clusters={[]} reloadKey={0} onRunAgain={() => {}} onRunAgainOn={() => {}} />,
      { '/api/command-runs*': { body: { items: [summary()], nextCursor: null, total: null } } },
    )
    await waitFor(() => expect(getByText('getprop ro.build.version.release')).toBeTruthy())
    expect(getByText('Pixel 6')).toBeTruthy()
    expect(getByText('ok')).toBeTruthy()
  })

  test('a failed run shows a failed-count chip', async () => {
    const { getByText } = renderWithApi(
      <CommandHistory devices={[]} clusters={[]} reloadKey={0} onRunAgain={() => {}} onRunAgainOn={() => {}} />,
      {
        '/api/command-runs*': {
          body: { items: [summary({ status: 'failed', counts: { total: 2, pending: 0, running: 0, ok: 1, failed: 1, skipped: 0, cancelled: 0 } })], nextCursor: null, total: null },
        },
      },
    )
    await waitFor(() => expect(getByText('1 failed')).toBeTruthy())
  })

  test('"Run again" hands back the exact cmd and target; "Run again on…" hands back only the cmd', async () => {
    let again: [string, unknown] | null = null
    let onDeviceOnly: string | null = null
    const { getByText, getByRole } = renderWithApi(
      <CommandHistory
        devices={[]}
        clusters={[]}
        reloadKey={0}
        onRunAgain={(cmd, target) => (again = [cmd, target])}
        onRunAgainOn={(cmd) => (onDeviceOnly = cmd)}
      />,
      { '/api/command-runs*': { body: { items: [summary()], nextCursor: null, total: null } } },
    )
    await waitFor(() => expect(getByText('getprop ro.build.version.release')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Run again' }))
    expect(again).toEqual(['getprop ro.build.version.release', { deviceIds: ['dev-1'] }])
    fireEvent.click(getByRole('button', { name: 'Run again on…' }))
    expect(onDeviceOnly).toBe('getprop ro.build.version.release')
  })

  test('no history yet — an empty state, not a blank panel', async () => {
    const { getByText } = renderWithApi(
      <CommandHistory devices={[]} clusters={[]} reloadKey={0} onRunAgain={() => {}} onRunAgainOn={() => {}} />,
      { '/api/command-runs*': { body: { items: [], nextCursor: null, total: null } } },
    )
    await waitFor(() => expect(getByText('No commands run yet')).toBeTruthy())
  })

  test('a failed fetch leaves the panel usable, never an error banner (history is a convenience)', async () => {
    const { container } = renderWithApi(<CommandHistory devices={[]} clusters={[]} reloadKey={0} onRunAgain={() => {}} onRunAgainOn={() => {}} />, {})
    await new Promise((r) => setTimeout(r, 50))
    expect(container.textContent).not.toContain('Could not load')
  })

  test('bumping reloadKey refetches', async () => {
    let calls = 0
    const { rerender, getByText } = renderWithApi(
      <CommandHistory devices={[]} clusters={[]} reloadKey={0} onRunAgain={() => {}} onRunAgainOn={() => {}} />,
      {
        '/api/command-runs*': () => {
          calls += 1
          return { body: { items: [summary({ id: `run-${calls}` })], nextCursor: null, total: null } }
        },
      },
    )
    await waitFor(() => expect(getByText('getprop ro.build.version.release')).toBeTruthy())
    expect(calls).toBe(1)
    rerender(<CommandHistory devices={[]} clusters={[]} reloadKey={1} onRunAgain={() => {}} onRunAgainOn={() => {}} />)
    await waitFor(() => expect(calls).toBe(2))
  })
})
