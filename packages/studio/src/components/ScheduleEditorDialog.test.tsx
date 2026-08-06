import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ScheduleEditorDialog, type ScheduleRow } from './ScheduleEditorDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const schedule: ScheduleRow = {
  id: 'sched-1',
  name: 'Nightly smoke',
  enabled: true,
  cron: '0 2 * * *',
  timezone: 'UTC',
  target: { kind: 'script', ref: 'checkout@latest' },
  scriptRef: 'checkout@latest',
  params: null,
  clusterId: null,
  deviceIds: ['device-1'],
  concurrency: 0,
  order: 'as-listed',
  onOverlap: 'skip',
  queueTimeoutSec: null,
  catchUp: 'skip',
  jitterSec: 0,
  priority: 0,
  threadMode: 'new',
  threadId: null,
  onApprovalRequired: 'deny',
  lastFiredAt: null,
  lastBatchId: null,
  lastAgentRunId: null,
  createdBy: null,
  createdAt: 0,
  nextFireAt: null,
}

const device = {
  id: 'device-1',
  stableId: 'stable-1',
  serial: 'serial-1',
  label: 'Pixel 7',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'online',
  lastSeen: 0,
  tags: [],
  cluster: null,
}

function baseResponses(validateBody: unknown = { valid: true, nextFires: [1000] }) {
  return {
    '/api/scripts*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/agents': { body: { agents: [] } },
    '/api/schedules/validate': { body: validateBody },
  }
}

describe('ScheduleEditorDialog — smoke render', () => {
  test('new: renders the create form with its default cron', async () => {
    renderWithApi(<ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    expect(screen.getByText('New schedule')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create schedule' })).toBeTruthy())
  })

  test('edit: seeds the fields from the given schedule', async () => {
    renderWithApi(<ScheduleEditorDialog schedule={schedule} devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    await waitFor(() => expect(screen.getByDisplayValue('Nightly smoke')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })

  test('closed: renders nothing', () => {
    renderWithApi(<ScheduleEditorDialog schedule={null} devices={[device]} onClose={() => {}} onSaved={() => {}} />, {})
    expect(screen.queryByText('New schedule')).toBeNull()
  })

  test('an invalid cron: the preview shows the named error, not a crash', async () => {
    renderWithApi(
      <ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />,
      baseResponses({ valid: false, nextFires: [], error: 'bad cron expression' }),
    )
    await waitFor(() => expect(screen.getByText('bad cron expression')).toBeTruthy())
  })

  test('save: a successful PATCH calls onSaved and onClose', async () => {
    let saved = false
    let closed = false
    renderWithApi(
      <ScheduleEditorDialog
        schedule={schedule}
        devices={[device]}
        onClose={() => {
          closed = true
        }}
        onSaved={() => {
          saved = true
        }}
      />,
      { ...baseResponses(), '/api/schedules/sched-1': { body: { schedule, resolvesTo: null } } },
    )
    // `canSubmit` only flips true once the debounced cron preview resolves
    // (300ms) — waiting for the button to stop being disabled, not merely
    // to exist, is what makes the click below actually fire. (`toBeDisabled()`
    // is not wired up for this workspace's `bun:test` — a plain property
    // read is what actually reflects the live DOM node on every poll.)
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saved).toBe(true))
    expect(closed).toBe(true)
  })
})
