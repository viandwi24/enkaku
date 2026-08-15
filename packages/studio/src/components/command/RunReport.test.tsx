import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { CommandMember } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { RunReport, type RunReportRun } from './RunReport'

/**
 * Plan 93 §3.15, §4.4, step 93.7 — the report's own "Verifiable result"
 * bullets, pinned directly against the rendered DOM (plan 72's renderer, not
 * just the pure `groupMembers` logic `run-grouping.test.ts` already covers):
 * 100 members render without an expanded row per device; a failing device
 * sorts above a succeeding one; a skipped device's reason is on the page;
 * Retry skipped/failed call back with the right action.
 */

afterEach(cleanup)

function member(overrides: Partial<CommandMember> = {}): CommandMember {
  return {
    deviceId: 'd',
    seq: 0,
    stageIndex: 0,
    status: 'ok',
    exitCode: 0,
    durationMs: 100,
    outputHash: 'h1',
    truncated: false,
    skip: null,
    error: null,
    ...overrides,
  }
}

function run(overrides: Partial<RunReportRun> = {}): RunReportRun {
  return {
    id: 'run-1',
    cmd: 'getprop ro.build.version.release',
    status: 'ok',
    stage: 1,
    stageFirstN: 0,
    counts: { total: 0, pending: 0, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 },
    startedAt: 1_700_000_000,
    finishedAt: 1_700_000_010,
    ...overrides,
  }
}

function noop() {}

describe('RunReport', () => {
  test('100 members render without one row per device — collapsed groups only', () => {
    const members = Array.from({ length: 100 }, (_, i) => member({ deviceId: `d${i}`, outputHash: 'same' }))
    const { container } = renderWithApi(
      <RunReport
        run={run({ counts: { total: 100, pending: 0, running: 0, ok: 100, failed: 0, skipped: 0, cancelled: 0 } })}
        members={members}
        outputs={[]}
        deviceLabel={(id) => id}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={noop}
        onRetrySkipped={noop}
        fetchFullOutput={async () => ''}
        busy={null}
      />,
    )
    // One collapsed group, one row — never 100 "terminal"/"output" links.
    expect(container.querySelectorAll('li').length).toBeLessThan(10)
    expect(container.textContent).toContain('100 devices')
  })

  test('a failing device sorts above a succeeding one', () => {
    const members = [member({ deviceId: 'good', status: 'ok', outputHash: 'h1' }), member({ deviceId: 'bad', status: 'failed', exitCode: 1, outputHash: 'h2' })]
    const { container } = renderWithApi(
      <RunReport
        run={run({ counts: { total: 2, pending: 0, running: 0, ok: 1, failed: 1, skipped: 0, cancelled: 0 } })}
        members={members}
        outputs={[]}
        deviceLabel={(id) => id}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={noop}
        onRetrySkipped={noop}
        fetchFullOutput={async () => ''}
        busy={null}
      />,
    )
    const groupTitles = [...container.querySelectorAll('[class*="font-medium"]')].map((el) => el.textContent).filter((t): t is string => !!t)
    const failedIdx = groupTitles.findIndex((t) => t.includes('exit 1'))
    const okIdx = groupTitles.findIndex((t) => t === 'ok')
    expect(failedIdx).toBeGreaterThanOrEqual(0)
    expect(okIdx).toBeGreaterThan(failedIdx)
  })

  test('a skipped device shows its reason text, not just a count', () => {
    const members = [
      member({ deviceId: 'held', status: 'skipped', skip: { code: 'not_lease_holder', message: 'another client is controlling this device' } }),
    ]
    const { getByText } = renderWithApi(
      <RunReport
        run={run({ counts: { total: 1, pending: 0, running: 0, ok: 0, failed: 0, skipped: 1, cancelled: 0 } })}
        members={members}
        outputs={[]}
        deviceLabel={(id) => id}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={noop}
        onRetrySkipped={noop}
        fetchFullOutput={async () => ''}
        busy={null}
      />,
    )
    expect(getByText('another client is controlling this device')).toBeTruthy()
  })

  test('Retry failed and Retry skipped call back, disabled when the count is zero', async () => {
    let retriedFailed = 0
    let retriedSkipped = 0
    const members = [
      member({ deviceId: 'bad', status: 'failed', exitCode: 1, outputHash: null }),
      member({ deviceId: 'held', status: 'skipped', skip: { code: 'x', message: 'reason' } }),
    ]
    const { getByRole } = renderWithApi(
      <RunReport
        run={run({ counts: { total: 2, pending: 0, running: 0, ok: 0, failed: 1, skipped: 1, cancelled: 0 } })}
        members={members}
        outputs={[]}
        deviceLabel={(id) => id}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={() => (retriedFailed += 1)}
        onRetrySkipped={() => (retriedSkipped += 1)}
        fetchFullOutput={async () => ''}
        busy={null}
      />,
    )
    fireEvent.click(getByRole('button', { name: 'Retry failed (1)' }))
    fireEvent.click(getByRole('button', { name: 'Retry skipped (1)' }))
    expect(retriedFailed).toBe(1)
    expect(retriedSkipped).toBe(1)
  })

  test('Retry buttons are disabled when there is nothing of that kind', () => {
    const { getByRole } = renderWithApi(
      <RunReport
        run={run({ counts: { total: 1, pending: 0, running: 0, ok: 1, failed: 0, skipped: 0, cancelled: 0 } })}
        members={[member({ deviceId: 'a', status: 'ok' })]}
        outputs={[]}
        deviceLabel={(id) => id}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={noop}
        onRetrySkipped={noop}
        fetchFullOutput={async () => ''}
        busy={null}
      />,
    )
    expect((getByRole('button', { name: 'Retry failed (0)' }) as HTMLButtonElement).disabled).toBe(true)
    expect((getByRole('button', { name: 'Retry skipped (0)' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('an awaiting-continue run shows the no-lease-held note, and Continue/Stop', () => {
    const { getByText, getByRole } = renderWithApi(
      <RunReport
        run={run({ status: 'awaiting-continue', stage: 1, counts: { total: 5, pending: 3, running: 0, ok: 2, failed: 0, skipped: 0, cancelled: 0 } })}
        members={[member({ deviceId: 'a' }), member({ deviceId: 'b' })]}
        outputs={[]}
        deviceLabel={(id) => id}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={noop}
        onRetrySkipped={noop}
        fetchFullOutput={async () => ''}
        busy={null}
      />,
    )
    expect(getByText(/No device is held while this waits/)).toBeTruthy()
    expect(getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(getByRole('button', { name: 'Stop' })).toBeTruthy()
  })

  test('expanding a group and clicking output opens the full-output drawer', async () => {
    const fetchFullOutput = async (deviceId: string, stream: 'stdout' | 'stderr') => (stream === 'stdout' ? `hello from ${deviceId}` : '')
    const { getByRole, getByText } = renderWithApi(
      <RunReport
        run={run({ counts: { total: 1, pending: 0, running: 0, ok: 1, failed: 0, skipped: 0, cancelled: 0 } })}
        members={[member({ deviceId: 'dev-a' })]}
        outputs={[]}
        deviceLabel={(id) => (id === 'dev-a' ? 'Pixel 6' : id)}
        onCancel={noop}
        onContinue={noop}
        onRetryFailed={noop}
        onRetrySkipped={noop}
        fetchFullOutput={fetchFullOutput}
        busy={null}
      />,
    )
    fireEvent.click(getByRole('button', { name: /1 device/ }))
    fireEvent.click(getByRole('button', { name: 'output' }))
    await waitFor(() => expect(getByText('hello from dev-a')).toBeTruthy())
  })
})
