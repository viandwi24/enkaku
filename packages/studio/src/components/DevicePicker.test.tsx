import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
import { TooltipProvider } from '@enkaku/ui'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { DevicePicker } from './DevicePicker'

afterEach(cleanup)

const BASE_DEVICE: DeviceInfo = {
  id: 'd1',
  stableId: 'stable-1',
  serial: 'emulator-5554',
  label: 'moto g06 power',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'busy',
  lastSeen: 1_700_000_000,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 1_700_000_000 },
}

/**
 * `DeviceInfo.assistedBy` (plan 91 §3.4 item 4, §4.4, F25 — gap 2). Before
 * this test the picker rendered `heldBy` via `HolderBadge` but never
 * `assistedBy`, so a device being assisted right now looked identical to one
 * that was not, here specifically. Same fix, same component, one more badge
 * — mirroring `DeviceCard`'s and `WallTile`'s own `assistedBy` block.
 */
describe('DevicePicker — assistedBy (plan 91 §3.4 item 4, §4.4, F25, gap 2)', () => {
  test('a device with no assistedBy shows no assist badge', () => {
    renderWithApi(<DevicePicker devices={[BASE_DEVICE]} value="" onChange={() => {}} />)
    expect(screen.queryByTitle(/Assisting|Assisted by/)).toBeNull()
  })

  test('a busy device being assisted shows the assist badge beside the holder badge', () => {
    const device: DeviceInfo = {
      ...BASE_DEVICE,
      heldBy: { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
      // Plan 105 §3.2 — a fresh `expiresAt` (just touched) so this reads
      // "Assisting", not "May assist" (`HolderBadge`'s activity split).
      assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: Math.floor(Date.now() / 1000) + 300 }],
    }
    renderWithApi(<DevicePicker devices={[device]} value="" onChange={() => {}} />)
    // `HolderBadge` defaults to `asLink={true}` here (the picker's row is a
    // `<button>`, not a `next/link`, so nothing is nested) — the title still
    // carries the "— open the job" suffix, unlike the Wall's `asLink={false}`.
    expect(screen.getByTitle('Running checkout@1.4.2 — open the job')).toBeTruthy()
    expect(screen.getByTitle('Assisting — Alice')).toBeTruthy()
  })

  test('a caller that predates the field (no assistedBy at all) still renders — the ?? [] guard', () => {
    const { assistedBy: _omit, ...withoutAssistedBy } = { ...BASE_DEVICE, assistedBy: [] } as DeviceInfo & { assistedBy?: unknown }
    renderWithApi(<DevicePicker devices={[withoutAssistedBy as DeviceInfo]} value="" onChange={() => {}} />)
    expect(screen.getByText('moto g06 power')).toBeTruthy()
  })
})

describe('DevicePicker — the device number (plan 89 §3.3, §5 step 89.3)', () => {
  test('a device with no number renders no `#` badge', () => {
    renderWithApi(<DevicePicker devices={[BASE_DEVICE]} value="" onChange={() => {}} />)
    expect(screen.queryByText('#7')).toBeNull()
  })

  test('the number leads the label as `#7`', () => {
    const device: DeviceInfo = { ...BASE_DEVICE, number: 7 }
    renderWithApi(<DevicePicker devices={[device]} value="" onChange={() => {}} />)
    expect(screen.getByText('#7')).toBeTruthy()
  })

  test('typing `7` matches `#7` (plan 89 §3.3)', () => {
    const numbered: DeviceInfo = { ...BASE_DEVICE, id: 'd2', stableId: 'stable-2', label: 'unrelated name', number: 7 }
    renderWithApi(<DevicePicker devices={[BASE_DEVICE, numbered]} value="" onChange={() => {}} />)
    fireEvent.change(screen.getByLabelText('Search devices'), { target: { value: '7' } })
    expect(screen.getByText('unrelated name')).toBeTruthy()
    expect(screen.queryByText('moto g06 power')).toBeNull()
  })

  test('typing `#7` also matches', () => {
    const numbered: DeviceInfo = { ...BASE_DEVICE, id: 'd2', stableId: 'stable-2', label: 'unrelated name', number: 7 }
    renderWithApi(<DevicePicker devices={[BASE_DEVICE, numbered]} value="" onChange={() => {}} />)
    fireEvent.change(screen.getByLabelText('Search devices'), { target: { value: '#7' } })
    expect(screen.getByText('unrelated name')).toBeTruthy()
    expect(screen.queryByText('moto g06 power')).toBeNull()
  })
})

describe('DevicePicker — an offline device can still be given a job', () => {
  /**
   * The core is the authority here and it only ever rejected `quarantined`:
   * `createJobStore.enqueue` throws for that one status, and `claimNext`'s
   * SQL predicate holds every other job until its device reaches `idle`,
   * which an offline phone does by itself on reconnect. Nothing expires the
   * job while it waits. The picker used to disable `offline` too, so a job
   * the server would have queued and run could not be created at all.
   */
  const offline: DeviceInfo = { ...BASE_DEVICE, status: 'offline' }
  const quarantined: DeviceInfo = { ...BASE_DEVICE, id: 'd3', stableId: 'stable-3', label: 'pulled phone', status: 'quarantined' }

  test('selecting an offline device fires onChange', () => {
    let picked = ''
    renderWithApi(<DevicePicker devices={[offline]} value="" onChange={(id) => (picked = id)} />)
    fireEvent.click(screen.getByText('moto g06 power'))
    expect(picked).toBe('d1')
  })

  test('it says the job waits, rather than leaving the status word to imply failure', () => {
    renderWithApi(<DevicePicker devices={[offline]} value="" onChange={() => {}} />)
    expect(screen.getByText('Queues until this device reconnects')).toBeTruthy()
  })

  test('a quarantined device is still refused — the one status the core rejects at enqueue', () => {
    let picked = ''
    // Only the refused path wraps its row in a `Tooltip` (to carry the
    // reason), so only this test needs the provider `app/layout.tsx` supplies
    // in the real app — the same reason `DeviceCard.test.tsx` wraps its own.
    // That the two tests above do NOT need it is itself the point: an offline
    // device no longer takes the disabled/tooltip path at all.
    renderWithApi(
      <TooltipProvider>
        <DevicePicker devices={[quarantined]} value="" onChange={(id) => (picked = id)} />
      </TooltipProvider>,
    )
    fireEvent.click(screen.getByText('pulled phone'))
    expect(picked).toBe('')
  })
})
