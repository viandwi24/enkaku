import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DevicePicker } from './device-picker'

type PickableDevice = ComponentProps<typeof DevicePicker>['devices'][number]

/**
 * The picker moved here from `packages/studio` on 2026-08-26 (see the
 * component's own doc for why). Studio's existing suite still covers the rich
 * path — status badges, holder badges, unavailable reasons — through its thin
 * wrapper, unchanged.
 *
 * What is new, and therefore what this file covers, is the LEAN path: a
 * caller that has less than a `DeviceInfo`. The MikroTik plugin's
 * `FleetDeviceRow` knows a device's id, name, number and stableId and nothing
 * about its status, tags or cluster. Before the move it could not use this
 * component at all and fell back to a one-at-a-time combobox; the whole point
 * of the move is that it can now pass what it actually has.
 */

afterEach(cleanup)

/** Exactly what a plugin row carries — no status, no tags, no cluster. */
const LEAN: PickableDevice[] = [
  { id: 'd1', label: 'SM-F721U1', stableId: 'R5CT81JZR3B', number: 4 },
  { id: 'd2', label: 'SM-F721U1', stableId: 'R5CT70LHKEA', number: 5 },
  { id: 'd3', label: 'Galaxy A15', stableId: 'R5CT819X6DH', number: 6 },
]

describe('DevicePicker — a caller with less than a DeviceInfo', () => {
  test('renders every device when status, tags and cluster are all absent', () => {
    render(<DevicePicker devices={LEAN} value={[]} onChange={() => {}} multiple />)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText('R5CT81JZR3B')).toBeTruthy()
  })

  test('an unknown status never makes a device unavailable', () => {
    // `cannotTakeJob` refuses only `quarantined`. Absent is not quarantined —
    // and a row nobody can pick, on a screen with no way to learn why, would
    // be worse than no picker at all.
    const onChange = mock(() => {})
    render(<DevicePicker devices={LEAN} value={[]} onChange={onChange} multiple />)
    const rows = screen.getAllByRole('option') as HTMLButtonElement[]
    expect(rows.every((r) => !r.disabled)).toBe(true)
    fireEvent.click(rows[0]!)
    expect(onChange).toHaveBeenCalledWith(['d1'])
  })

  test('no tag chips are drawn when no device carries tags', () => {
    render(<DevicePicker devices={LEAN} value={[]} onChange={() => {}} multiple />)
    // Device rows carry `role="option"`, so a tag chip would be the only
    // thing on this surface answering to `button`. There must be none.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  test('the list stays flat when no device carries a cluster', () => {
    render(<DevicePicker devices={LEAN} value={[]} onChange={() => {}} multiple />)
    expect(screen.queryByText('Unclustered')).toBeNull()
  })

  test('multi-select accumulates — the shape the plugin editor needed', () => {
    const picked: string[][] = []
    function Harness() {
      return <DevicePicker devices={LEAN} value={picked.at(-1) ?? []} onChange={(ids) => picked.push(ids)} multiple />
    }
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getAllByRole('option')[0]!)
    rerender(<Harness />)
    fireEvent.click(screen.getAllByRole('option')[2]!)
    expect(picked.at(-1)).toEqual(['d1', 'd3'])
  })

  test('search matches the number both bare and #-prefixed, and the stableId', () => {
    render(<DevicePicker devices={LEAN} value={[]} onChange={() => {}} multiple />)
    const box = screen.getByLabelText('Search devices')

    fireEvent.change(box, { target: { value: '6' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Galaxy A15')).toBeTruthy()

    fireEvent.change(box, { target: { value: 'R5CT70' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('R5CT70LHKEA')).toBeTruthy()
  })

  test('a quarantined device is shown disabled, never dropped from the list', () => {
    const withOneOut: PickableDevice[] = [...LEAN, { id: 'd4', label: 'SM-F721U1', stableId: 'R5CT99ZZZZZ', number: 2, status: 'quarantined' }]
    const onChange = mock(() => {})
    render(<DevicePicker devices={withOneOut} value={[]} onChange={onChange} multiple />)
    const rows = screen.getAllByRole('option') as HTMLButtonElement[]
    expect(rows).toHaveLength(4)
    const disabled = rows.filter((r) => r.disabled)
    expect(disabled).toHaveLength(1)
    fireEvent.click(disabled[0]!)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('DevicePicker — the injected slots are genuinely optional', () => {
  test('omitting every slot renders no status badge, no holder badge and no crash', () => {
    render(<DevicePicker devices={LEAN} value={[]} onChange={() => {}} multiple />)
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  test('a supplied slot is called once per row', () => {
    const renderStatus = mock(() => <span>badge</span>)
    render(<DevicePicker devices={LEAN} value={[]} onChange={() => {}} multiple renderStatus={renderStatus} />)
    expect(screen.getAllByText('badge')).toHaveLength(3)
  })
})
