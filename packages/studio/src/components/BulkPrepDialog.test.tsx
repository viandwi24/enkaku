import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DeviceInfo, DevicePrepApplyResult } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { BulkPrepDialog } = await import('./BulkPrepDialog')

afterEach(cleanup)

function makeDevice(id: string, label: string): DeviceInfo {
  return {
    id,
    stableId: id,
    serial: id,
    // Plan 124 step 124.3 — a number on every fixture, because the report
    // these tests read is exactly the surface that has to tell two
    // identically labelled phones apart.
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

const okRow = (deviceId: string, state: 'applied' | 'no-session' = 'applied'): DevicePrepApplyResult => ({
  deviceId,
  saved: true,
  changed: ['rotation'],
  rotation: { mode: 'lock-portrait', state },
  error: null,
})
const busyRow = (deviceId: string): DevicePrepApplyResult => ({
  deviceId,
  saved: true,
  changed: ['rotation'],
  rotation: { mode: 'lock-portrait', state: 'busy', reason: 'a job is running on this device' },
  error: null,
})
const declinedRow = (deviceId: string): DevicePrepApplyResult => ({
  deviceId,
  saved: true,
  changed: ['rotation'],
  rotation: { mode: 'lock-portrait', state: 'failed', reason: 'user_rotation reads back "1", not "0"' },
  error: null,
})

const tickRotation = (r: { getByLabelText: (t: string) => HTMLElement }) =>
  fireEvent.click(r.getByLabelText('Apply screen rotation to the selection'))

/**
 * The two properties this dialog exists to hold: it sends ONLY what was
 * ticked, and its report is per-device rather than one aggregate sentence over
 * a mix of outcomes.
 */
describe('BulkPrepDialog — only the chosen keys leave the browser', () => {
  test('Apply is refused until at least one setting is switched on', () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    const r = renderWithApi(<BulkPrepDialog open devices={devices} onOpenChange={() => {}} />, {})
    expect((r.getByText('Apply to 2 devices').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(r.baseElement.textContent).toContain('Nothing is switched on yet, so this would write nothing')
  })

  test('ticking one setting sends exactly that one key — the other four are absent, not defaulted', async () => {
    const devices = [makeDevice('d1', 'Phone A'), makeDevice('d2', 'Phone B')]
    const r = renderWithApi(<BulkPrepDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/devices/prep/apply': {
        body: { total: 2, keys: ['rotation'], results: [okRow('d1'), okRow('d2', 'no-session')] },
      },
    })

    tickRotation(r)
    fireEvent.click(r.getByText('Apply to 2 devices'))

    await waitFor(() => expect(r.apiMock.calls.some((c) => c.path === '/api/devices/prep/apply')).toBe(true))
    const call = r.apiMock.calls.find((c) => c.path === '/api/devices/prep/apply')
    const body = call?.body as { deviceIds: string[]; prep: Record<string, unknown> }
    expect(Object.keys(body.prep)).toEqual(['rotation'])
    expect(body.prep.rotation).toBe('lock-portrait')
    expect(body.deviceIds).toEqual(['d1', 'd2'])
  })

  test('two ticked settings send two keys, and the form says which and how many are untouched', async () => {
    const devices = [makeDevice('d1', 'Phone A')]
    const r = renderWithApi(<BulkPrepDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/devices/prep/apply': { body: { total: 1, keys: ['keepAwake', 'rotation'], results: [okRow('d1')] } },
    })

    tickRotation(r)
    fireEvent.click(r.getByLabelText('Apply keep the screen awake to the selection'))
    expect(r.baseElement.textContent).toContain('The other 3 are not part of this request and are not touched')

    fireEvent.click(r.getByText('Apply to 1 device'))
    await waitFor(() => expect(r.apiMock.calls.length).toBeGreaterThan(0))
    const body = r.apiMock.calls[0]?.body as { prep: Record<string, unknown> }
    expect(Object.keys(body.prep).sort()).toEqual(['keepAwake', 'rotation'])
  })
})

describe('BulkPrepDialog — a mixed twenty-device result', () => {
  const devices = Array.from({ length: 20 }, (_, i) => makeDevice(`d${i + 1}`, `Phone ${String(i + 1).padStart(2, '0')}`))
  const results: DevicePrepApplyResult[] = [
    declinedRow('d1'),
    declinedRow('d2'),
    { deviceId: 'd3', saved: false, changed: [], rotation: null, error: { code: 'device_not_found', message: 'no such device: d3' } },
    busyRow('d4'),
    busyRow('d5'),
    busyRow('d6'),
    ...devices.slice(6, 12).map((d) => okRow(d.id, 'no-session')),
    ...devices.slice(12).map((d) => okRow(d.id)),
  ]

  async function renderReport() {
    const r = renderWithApi(<BulkPrepDialog open devices={devices} onOpenChange={() => {}} />, {
      '/api/devices/prep/apply': { body: { total: results.length, keys: ['rotation'], results } },
    })
    tickRotation(r)
    fireEvent.click(r.getByText('Apply to 20 devices'))
    await waitFor(() => expect(r.getByText('14 ok · 3 failed · 3 skipped (20/20)')).toBeTruthy())
    return r
  }

  test('the counts split applied, failed and job-deferred — never one "applied to 20"', async () => {
    const r = await renderReport()
    expect(r.baseElement.textContent).not.toContain('Applied to 20 devices')
  })

  test('a busy device is said to be saved AND not applied live, and nothing was taken from its job', async () => {
    const r = await renderReport()
    const text = r.baseElement.textContent ?? ''
    expect(text).toContain('3 devices are running a job')
    expect(text).toContain('The setting is saved on them')
    expect(text).toContain('the lock applies on the job’s next session')
    expect(text).toContain('Nothing was taken from a running job')
  })

  test('every count expands into the named devices behind it, failures first', async () => {
    const r = await renderReport()
    const groups = Array.from(r.baseElement.querySelectorAll('[data-testid="skipped-groups"] > li'))
    // failed (declined) · failed (no such device) · skipped (job running).
    expect(groups).toHaveLength(3)
    expect(groups[0]?.textContent).toContain('failed')
    expect(groups[0]?.textContent).toContain('The screen did not re-lock')
    expect(groups[2]?.textContent).toContain('skipped')
    expect(groups[2]?.textContent).toContain('Saved, but the screen was not re-locked')

    expect(r.queryAllByText('Phone 01')).toHaveLength(0)
    fireEvent.click(groups[0]?.querySelector('button') as HTMLButtonElement)
    await waitFor(() => expect(r.getByText('Phone 01')).toBeTruthy())
    expect(r.getByText('Phone 02')).toBeTruthy()
    // Plan 124 §4.4, step 124.3 — named WITH the number, not just the label.
    expect(r.getByText('#1')).toBeTruthy()
    expect(r.getByText('#2')).toBeTruthy()
  })

  test('the devices with no session open are counted honestly, not reported as screens that moved', async () => {
    const r = await renderReport()
    const text = r.baseElement.textContent ?? ''
    expect(text).toContain('6 of the 14 that saved had no session open, so no screen moved')
    expect(text).toContain('8 screens re-locked while you watched')
  })

  test('retry re-sends only the six that did not apply, and their rows are the ones that change', async () => {
    const r = await renderReport()
    fireEvent.click(r.getByText('Retry the 6 that did not apply'))

    await waitFor(() => expect(r.apiMock.calls.length).toBe(2))
    const retry = r.apiMock.calls[1]?.body as { deviceIds: string[] }
    expect(retry.deviceIds).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6'])
    // The fourteen that worked are neither re-sent…
    expect(retry.deviceIds).not.toContain('d7')
    // …nor dropped from the report: the retry's rows replace only their own.
    await waitFor(() => expect(r.getByText('14 ok · 3 failed · 3 skipped (20/20)')).toBeTruthy())
  })
})
