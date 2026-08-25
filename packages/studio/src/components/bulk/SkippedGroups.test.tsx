import { afterEach, describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { groupOutcomes, SkippedGroups, type NamedOutcome } from './SkippedGroups'

afterEach(cleanup)

describe('groupOutcomes', () => {
  test('groups by exact reason text, preserving first-seen order', () => {
    const entries: NamedOutcome[] = [
      { deviceId: 'a', number: 1, label: 'rack-a-01', reason: 'offline' },
      { deviceId: 'b', number: 2, label: 'rack-a-02', reason: 'quarantined' },
      { deviceId: 'c', number: 3, label: 'rack-a-03', reason: 'offline' },
    ]
    const groups = groupOutcomes('skipped', entries)
    expect(groups.map((g) => g.reason)).toEqual(['offline', 'quarantined'])
    expect(groups[0]?.entries.map((e) => e.deviceId)).toEqual(['a', 'c'])
    expect(groups[1]?.entries.map((e) => e.deviceId)).toEqual(['b'])
  })

  test('two different reasons never merge, even for the same kind', () => {
    const entries: NamedOutcome[] = [
      { deviceId: 'a', number: 1, label: 'A', reason: 'exit 1' },
      { deviceId: 'b', number: null, label: 'B', reason: 'exit 137' },
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
        failed={[{ deviceId: 'd1', number: 7, label: 'rack-a-07', reason: 'exit 1' }]}
        skipped={[
          { deviceId: 'd2', number: 21, label: 'rack-b-01', reason: 'another client is controlling this device' },
          { deviceId: 'd3', number: 23, label: 'rack-b-03', reason: 'another client is controlling this device' },
        ]}
      />,
    )
    // A count is visible without expanding...
    expect(screen.getByText('exit 1')).toBeTruthy()
    expect(screen.getByText('another client is controlling this device')).toBeTruthy()
    expect(screen.getByText('2 devices')).toBeTruthy()
    // ...and every device behind it is reachable, expanded or not.
    expect(screen.getByText('#7 rack-a-07')).toBeTruthy()
    // The skipped group's collapsed preview already names its two devices —
    // with their numbers, since plan 124 step 124.3 (`#21`/`#23` is the only
    // thing telling two identically labelled phones apart in this preview).
    expect(screen.getByText('#21 rack-b-01, #23 rack-b-03')).toBeTruthy()
    // Expanding confirms the same names are present as individual rows.
    await user.click(screen.getByText('another client is controlling this device'))
    const rows = screen.getAllByText(/rack-b-0[13]/)
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * Plan 124 criterion 7 — a device with no number renders its bare label,
   * with no stray `#` and no `#null`. Asserted here and not only in
   * `@enkaku/ui`'s own `device-name.test.ts` because this component composes
   * the number in TWO places (the collapsed preview joins strings, the
   * expanded rows render `<DeviceName>`) and criterion 7 has to hold in both.
   */
  test('a device with no number renders a bare label, in the preview and expanded', async () => {
    const user = userEvent.setup()
    renderWithApi(
      <SkippedGroups
        failed={[]}
        skipped={[
          { deviceId: 'd1', number: null, label: 'unnumbered phone', reason: 'offline' },
          { deviceId: 'd2', number: 4, label: 'numbered phone', reason: 'offline' },
        ]}
      />,
    )
    expect(screen.getByText('unnumbered phone, #4 numbered phone')).toBeTruthy()
    await user.click(screen.getByText('offline'))
    expect(document.body.textContent).not.toContain('#null')
    expect(document.body.textContent).not.toContain('#undefined')
  })
})
