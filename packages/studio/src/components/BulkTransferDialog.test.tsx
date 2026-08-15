import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { BulkTransferDialog } = await import('./BulkTransferDialog')

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

const pullBatch = {
  id: 'batch-2',
  clusterId: null,
  scriptId: 'internal:pull',
  scriptName: null,
  scriptVersion: null,
  params: {},
  concurrency: 0,
  order: 'as-listed',
  status: 'success',
  createdBy: null,
  createdAt: 0,
  finishedAt: 1,
  counts: { total: 1, queued: 0, running: 0, success: 1, failed: 0, cancelled: 0 },
  skipped: [{ deviceId: 'd2', reason: 'offline' }],
}
const pullJobs = [
  { jobId: 'j1', deviceId: 'd1', scriptId: 'internal:pull', scriptName: null, scriptVersion: null, status: 'success', error: null, priority: 0, createdAt: 0, startedAt: 0, finishedAt: 1, batchId: 'batch-2', batchSeq: 0 },
]

describe('BulkTransferDialog (plan 93 §3.11, §3.13, §4.8, F15, step 93.11)', () => {
  test('pull mode has no artifact picker, only a remote-path field', () => {
    const devices = [makeDevice('d1', 'Phone A')]
    renderWithApi(<BulkTransferDialog mode="pull" open devices={devices} onOpenChange={() => {}} />, {})
    expect(screen.getByText('Pull file from 1 device')).toBeTruthy()
    expect(screen.getByPlaceholderText('/sdcard/report.txt')).toBeTruthy()
    expect(screen.queryByText('Upload new')).toBeNull()
  })

  test('push mode requires both a source and a path before Push is enabled', async () => {
    const user = userEvent.setup()
    const devices = [makeDevice('d1', 'Phone A')]
    renderWithApi(<BulkTransferDialog mode="push" open devices={devices} onOpenChange={() => {}} />, {
      '/api/artifacts*': { status: 400, body: {} },
    })
    const pushButton = screen.getByRole('button', { name: 'Push' }) as HTMLButtonElement
    expect(pushButton.disabled).toBe(true)

    await user.type(screen.getByPlaceholderText('/sdcard/Download/file.bin'), '/sdcard/Download/x.bin')
    expect(pushButton.disabled).toBe(true) // still no file

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(fileInput, new File(['x'], 'x.bin'))
    expect(pushButton.disabled).toBe(false)
  })

  test('a pull batch stays open and names its skipped device (F11, F15, H3)', async () => {
    const user = userEvent.setup()
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    let posted: unknown = null
    renderWithApi(<BulkTransferDialog mode="pull" open devices={devices} onOpenChange={() => {}} />, {
      '/api/batches': (req) => {
        posted = req.body
        return { body: { batch: pullBatch } }
      },
      '/api/batches/batch-2': { body: { batch: pullBatch, jobs: pullJobs } },
    })

    await user.type(screen.getByPlaceholderText('/sdcard/report.txt'), '/sdcard/report.txt')
    await user.click(screen.getByRole('button', { name: 'Pull' }))

    await waitFor(() => expect(screen.getByText('1 ok · 0 failed · 1 skipped (2/2)')).toBeTruthy())
    expect(screen.getByText('offline')).toBeTruthy()
    expect(screen.getByText('Pull file from 2 devices')).toBeTruthy() // still open
    expect((posted as { scriptId: string; params: { remotePath: string } } | null)?.scriptId).toBe('internal:pull')
    expect((posted as { params: { remotePath: string } }).params.remotePath).toBe('/sdcard/report.txt')
  })
})
