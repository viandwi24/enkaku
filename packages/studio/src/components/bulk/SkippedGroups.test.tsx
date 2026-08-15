import { afterEach, describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { groupOutcomes, SkippedGroups, type NamedOutcome } from './SkippedGroups'

afterEach(cleanup)

describe('groupOutcomes', () => {
  test('groups by exact reason text, preserving first-seen order', () => {
    const entries: NamedOutcome[] = [
      { deviceId: 'a', label: 'rack-a-01', reason: 'offline' },
      { deviceId: 'b', label: 'rack-a-02', reason: 'quarantined' },
      { deviceId: 'c', label: 'rack-a-03', reason: 'offline' },
    ]
    const groups = groupOutcomes('skipped', entries)
    expect(groups.map((g) => g.reason)).toEqual(['offline', 'quarantined'])
    expect(groups[0]?.entries.map((e) => e.deviceId)).toEqual(['a', 'c'])
    expect(groups[1]?.entries.map((e) => e.deviceId)).toEqual(['b'])
  })

  test('two different reasons never merge, even for the same kind', () => {
    const entries: NamedOutcome[] = [
      { deviceId: 'a', label: 'A', reason: 'exit 1' },
      { deviceId: 'b', label: 'B', reason: 'exit 137' },
    ]
    expect(groupOutcomes('failed', entries)).toHaveLength(2)
  })

  test('empty input produces no groups', () => {
    expect(groupOutcomes('skipped', [])).toEqual([])
  })
})

describe('SkippedGroups', () => {
  test('renders nothing when there is nothing to show', () => {
    const { container } = renderWithApi(<SkippedGroups failed={[]} skipped={[]} />)
    expect(container.querySelector('[data-testid="skipped-groups"]')).toBeNull()
  })

  test('names every device behind a count — the whole of F15', async () => {
    const user = userEvent.setup()
    renderWithApi(
      <SkippedGroups
        failed={[{ deviceId: 'd1', label: 'rack-a-07', reason: 'exit 1' }]}
        skipped={[
          { deviceId: 'd2', label: 'rack-b-01', reason: 'another client is controlling this device' },
          { deviceId: 'd3', label: 'rack-b-03', reason: 'another client is controlling this device' },
        ]}
      />,
    )
    // A count is visible without expanding...
    expect(screen.getByText('exit 1')).toBeTruthy()
    expect(screen.getByText('another client is controlling this device')).toBeTruthy()
    expect(screen.getByText('2 devices')).toBeTruthy()
    // ...and every device behind it is reachable, expanded or not.
    expect(screen.getByText('rack-a-07')).toBeTruthy()
    // The skipped group's collapsed preview already names its two devices.
    expect(screen.getByText('rack-b-01, rack-b-03')).toBeTruthy()
    // Expanding confirms the same names are present as individual rows.
    await user.click(screen.getByText('another client is controlling this device'))
    const rows = screen.getAllByText(/rack-b-0[13]/)
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})
