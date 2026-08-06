import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { mockRouter } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { RunScriptDialog, type ScriptRow } from './RunScriptDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const script: ScriptRow = {
  id: 'script-1',
  name: 'checkout',
  version: '1.0.0',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
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

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  status: 'queued',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
}

describe('RunScriptDialog — smoke render', () => {
  test('closed: no script and no scripts list renders nothing', () => {
    renderWithApi(<RunScriptDialog script={null} devices={[device]} onClose={() => {}} />, {})
    expect(screen.queryByText(/^Run /)).toBeNull()
  })

  test('open on a single script: shows the run dialog for a single device target', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByText('Run checkout')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
  })

  test('no scripts published: shows the "nothing published" message', () => {
    renderWithApi(<RunScriptDialog script={null} scripts={[]} devices={[device]} onClose={() => {}} />, {})
    expect(screen.getByText('Nothing is published to this farm yet.')).toBeTruthy()
  })

  test('run: a successful POST /api/jobs navigates to the new job', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      {
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/jobs': { body: { job } },
      },
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/jobs/detail?id=job-1'))
  })
})
