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
    // Plan 124 step 124.3 — the batch report and the re-attach banner both
    // name devices now, so every fixture carries a number.
    number: Number(id.replace(/\D/g, '')) || null,
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

describe('InstallBatchDialog — the target is a default, not a lock (plan 104 §3.4)', () => {
  test('a single pre-filled device can still be switched to Multiple devices and edited', () => {
    const other = makeDevice('d2', 'Phone B')
    const devices = [makeDevice('d1', 'Phone A')]
    renderWithApi(<InstallBatchDialog open devices={devices} allDevices={[...devices, other]} onOpenChange={() => {}} />, {
      '/api/artifacts*': { status: 400, body: {} },
    })
    // Defaulted to single — no concurrency/order yet.
    expect(screen.getByText('Install on 1 device')).toBeTruthy()
    expect(screen.queryByText('Concurrency')).toBeNull()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(screen.getByText('Phone A'))
    fireEvent.click(screen.getByText('Phone B'))
    expect(screen.getByText('Install on 2 devices')).toBeTruthy()
    expect(screen.getByText('Concurrency')).toBeTruthy()
  })
})

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

describe('InstallBatchDialog — re-attach instead of a fresh Install (plan 107 §3.6, step 107.5)', () => {
  const runningBatch = {
    id: 'batch-9',
    clusterId: null,
    scriptId: 'internal:install',
    scriptName: null,
    scriptVersion: null,
    params: {},
    concurrency: 0,
    order: 'as-listed',
    status: 'running',
    createdBy: null,
    createdAt: 100,
    finishedAt: null,
    counts: { total: 1, queued: 0, running: 1, success: 0, failed: 0, cancelled: 0, expired: 0, failedScript: 0, failedInfra: 0 },
    pacing: null,
    repeats: [],
    skipped: [],
  }
  const runningJobD1 = {
    jobId: 'jr1',
    deviceId: 'd1',
    scriptId: 'internal:install',
    scriptName: null,
    scriptVersion: null,
    status: 'running',
    error: null,
    priority: 0,
    createdAt: 100,
    startedAt: 100,
    finishedAt: null,
    batchId: 'batch-9',
    batchSeq: 0,
  }

  test('opening on a device with a fully-overlapping running install re-attaches silently — no fresh Install button', async () => {
    const devices = [makeDevice('d1', 'Phone A')]
    renderWithApi(<InstallBatchDialog open devices={devices} onOpenChange={() => {}} />, {
      // `/api/batches/batch-9` MUST be listed before the wildcard
      // `/api/batches*` below — `installApiMock` matches keys in
      // declaration order, and the wildcard would otherwise shadow this
      // exact path with the LIST envelope shape instead of `{batch, jobs}`.
      '/api/batches/batch-9': { body: { batch: runningBatch, jobs: [runningJobD1] } },
      '/api/transfers': { body: { transfers: [] } },
      '/api/jobs*': { body: { items: [runningJobD1], nextCursor: null, total: 1 } },
      '/api/batches*': { body: { items: [runningBatch], nextCursor: null, total: 1 } },
      '/api/command-runs*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/devices': { body: { items: devices, nextCursor: null, total: devices.length } },
    })

    // Silently re-attached to the running BATCH — `useBatchReport`'s own
    // progress view renders (no new UI invented), and there is no fresh
    // "Install" button offering a second start.
    await waitFor(() => expect(screen.getByText('0 ok · 0 failed · 0 skipped (0/1)')).toBeTruthy())
    expect(screen.getByText('Installing…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  test('a fully-overlapping ephemeral transfer (single-device install started elsewhere, not a batch) re-attaches to its own byte progress', async () => {
    const devices = [makeDevice('d1', 'Phone A')]
    renderWithApi(<InstallBatchDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/transfers': {
        body: { transfers: [{ transferId: 'tr-1', deviceId: 'd1', kind: 'install', state: 'running', startedAt: 100, updatedAt: 100, sent: 20, total: 200, ok: null, error: null }] },
      },
      '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/batches*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/command-runs*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/devices': { body: { items: devices, nextCursor: null, total: devices.length } },
    })

    await waitFor(() => expect(screen.getByText(/re-attached to the operation already running/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  test('a partial overlap is named, never merged — the Install button stays disabled until the target is narrowed', async () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    renderWithApi(<InstallBatchDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/transfers': { body: { transfers: [] } },
      '/api/jobs*': { body: { items: [runningJobD1], nextCursor: null, total: 1 } },
      '/api/batches*': { body: { items: [runningBatch], nextCursor: null, total: 1 } },
      '/api/command-runs*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/devices': { body: { items: devices, nextCursor: null, total: devices.length } },
    })

    await waitFor(() => expect(screen.getByText(/already running on 1 of the selected devices/i)).toBeTruthy())
    const installButton = screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement
    expect(installButton.disabled).toBe(true)
  })
})
