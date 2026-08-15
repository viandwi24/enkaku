import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { InstallBatchDialog } = await import('./InstallBatchDialog')

afterEach(cleanup)

function makeDevice(id: string, label: string): DeviceInfo {
  return {
    id,
    stableId: id,
    serial: id,
    label,
    androidVersion: '15',
    apiLevel: 35,
    screenW: 720,
    screenH: 1600,
    density: 280,
    status: 'idle',
    lastSeen: 1,
    battery: null,
    quarantineReason: null,
    tags: [],
    cluster: null,
    lastCrashAt: null,
    readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  }
}

const batch = {
  id: 'batch-1',
  clusterId: null,
  scriptId: 'internal:install',
  scriptName: null,
  scriptVersion: null,
  params: {},
  concurrency: 0,
  order: 'as-listed',
  status: 'success',
  createdBy: null,
  createdAt: 0,
  finishedAt: 1,
  counts: { total: 2, queued: 0, running: 0, success: 1, failed: 1, cancelled: 0 },
}
const jobs = [
  { jobId: 'j1', deviceId: 'd1', scriptId: 'internal:install', scriptName: null, scriptVersion: null, status: 'success', error: null, priority: 0, createdAt: 0, startedAt: 0, finishedAt: 1, batchId: 'batch-1', batchSeq: 0 },
  { jobId: 'j2', deviceId: 'd2', scriptId: 'internal:install', scriptName: null, scriptVersion: null, status: 'failed', error: 'install failed: INSTALL_FAILED_INVALID_APK', priority: 0, createdAt: 0, startedAt: 0, finishedAt: 1, batchId: 'batch-1', batchSeq: 1 },
]

describe('InstallBatchDialog (plan 93 §3.11, §4.8, F15, F17, step 93.11)', () => {
  test('concurrency and order controls appear for a multi-device selection (F17)', () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    renderWithApi(<InstallBatchDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/artifacts*': { status: 400, body: { error: { code: 'E_BAD_REQUEST', message: 'either ?jobId=, ?deviceId=, or ?kind=upload is required' } } },
    })
    expect(screen.getByText('Concurrency')).toBeTruthy()
    expect(screen.getByText('Order')).toBeTruthy()
  })

  test('no concurrency/order controls for a single device (nothing to order)', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    renderWithApi(<InstallBatchDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/artifacts*': { status: 400, body: {} },
    })
    expect(screen.queryByText('Concurrency')).toBeNull()
  })

  test('stays open and shows the OutcomeSummary/SkippedGroups report instead of navigating away (F15)', async () => {
    const user = userEvent.setup()
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    let posted: unknown = null
    renderWithApi(<InstallBatchDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/artifacts*': (req) => {
        if (req.method === 'POST') return { body: { artifact: { id: 'art-1' } } }
        return { status: 400, body: {} }
      },
      '/api/batches': (req) => {
        posted = req.body
        return { body: { batch } }
      },
      '/api/batches/batch-1': { body: { batch, jobs } },
    })

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'app.apk', { type: 'application/vnd.android.package-archive' })
    await user.upload(fileInput, file)

    await user.click(screen.getByText('Install'))

    await waitFor(() => expect(screen.getByText('1 ok · 1 failed · 0 skipped (2/2)')).toBeTruthy())
    // Dialog is still open (F15) — its own title is still on screen.
    expect(screen.getByText('Install on 2 devices')).toBeTruthy()
    // Every count is nameable — the failed device's own reason is shown.
    expect(screen.getByText('install failed: INSTALL_FAILED_INVALID_APK')).toBeTruthy()
    expect((posted as { scriptId: string } | null)?.scriptId).toBe('internal:install')
  })
})
