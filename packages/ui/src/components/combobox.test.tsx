import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Combobox, type ComboboxOption } from './combobox'

afterEach(cleanup)

/**
 * Plan 124 §4.3's four non-optional behaviours, actually exercised.
 *
 * These are driven through `fireEvent` rather than `@testing-library/user-event`
 * (which `ModelCombobox.test.tsx` uses) for one reason: `user-event` is a
 * devDependency of `packages/studio`, not of `packages/ui`, and adding a
 * dependency to run these tests would touch the lockfile for every other
 * package in the workspace. `fireEvent` reaches every handler that matters
 * here — Radix's trigger is an `onClick`, `cmdk`'s input is an `onChange`, and
 * `cmdk`'s item is an `onClick` that is not attached at all when the item is
 * disabled — which is the same code path a real click takes. What it does NOT
 * cover is arrow-key navigation and Enter-to-select; those are `cmdk`'s own,
 * they are covered by `ModelCombobox.test.tsx` against the same primitive, and
 * they are not re-proved here.
 *
 * Almost every assertion below counts matches rather than asserting on an
 * element. That is not style: `happy-dom`'s elements serialise to megabytes,
 * so a single failed `expect(node).toBeNull()` inside a retrying `waitFor`
 * produces a ~100MB failure report that takes minutes to write. Counts fail
 * with a number.
 *
 * `happy-dom` has no layout engine, so nothing below asserts a measured size —
 * the same honest limit `dialog.test.tsx` and `input-group.test.tsx` record.
 */

/**
 * Neither stableId here contains the digit `7`, and neither label does. That
 * is deliberate: the keyword test below asserts that typing `7` leaves ONLY
 * the `#7` row, and a `7` hiding in the other row's serial would make it pass
 * or fail for a reason that has nothing to do with the component.
 */
const DEVICES: ComboboxOption[] = [
  { value: 'dev-a1', label: 'Galaxy A15', keywords: ['7', '#7', 'R5CW10ABCDE'], hint: 'R5CW10ABCDE' },
  { value: 'dev-b2', label: 'Pixel 5', keywords: ['12', '#12', 'ZY223MMKQX'], hint: 'ZY223MMKQX' },
]

const SEARCH = 'Filter devices…'

function base(props: Partial<Parameters<typeof Combobox>[0]> = {}) {
  return (
    <Combobox
      value=""
      onValueChange={() => undefined}
      options={DEVICES}
      ariaLabel="Device"
      placeholder="Add a device…"
      searchPlaceholder={SEARCH}
      {...props}
    />
  )
}

function trigger() {
  return screen.getByRole('combobox', { name: 'Device' })
}

/** Counting queries — see the file header on why nothing here returns a node to `expect`. */
const texts = (t: string | RegExp) => screen.queryAllByText(t).length
const inputs = () => screen.queryAllByPlaceholderText(SEARCH).length

async function openList() {
  fireEvent.click(trigger())
  await waitFor(() => expect(inputs()).toBe(1))
  return screen.getByPlaceholderText(SEARCH)
}

describe('Combobox', () => {
  test('the trigger shows the placeholder when nothing is selected, and the label once something is', () => {
    const { rerender } = render(base())
    expect(trigger().textContent).toContain('Add a device…')
    rerender(base({ value: 'dev-b2' }))
    expect(trigger().textContent).toContain('Pixel 5')
  })

  /**
   * The filter matches `keywords`, not just the label — the entire reason plan
   * 124 §4.5 can promise that typing `7` in the Mikrotik "Add a device…" box
   * finds `#7`. A row's `value` is an opaque device id and its label is a model
   * name shared by three other phones, so the number only ever reaches the
   * filter through `keywords` (which is exactly the array `deviceSearchTerms()`
   * produces).
   */
  test('typing a keyword filters to the row it belongs to (criterion 1: `7` finds `#7`)', async () => {
    render(base())
    const input = await openList()
    fireEvent.change(input, { target: { value: '7' } })
    await waitFor(() => expect(texts('Pixel 5')).toBe(0))
    expect(texts('Galaxy A15')).toBe(1)
  })

  /**
   * `cmdk` filters with `command-score`, which is FUZZY: a query is not
   * required to appear as a substring, only in order and with penalties. A
   * run of one letter (`zzzz`) is therefore a bad "matches nothing" probe —
   * measured against this fixture it still scores 0.0099 for `Pixel 5`,
   * because command-score's skip penalties never quite reach zero. A real
   * word whose letters do not appear in order does score zero, which is what
   * this uses.
   */
  test('typing something no row carries shows the empty text', async () => {
    render(base({ emptyText: 'No device matches.' }))
    const input = await openList()
    fireEvent.change(input, { target: { value: 'nothing' } })
    await waitFor(() => expect(texts('No device matches.')).toBe(1))
    expect(texts('Galaxy A15')).toBe(0)
    expect(texts('Pixel 5')).toBe(0)
  })

  /**
   * §3.4 / §4.3 behaviour 1. A Mikrotik group can name a device that has since
   * been forgotten; dropping it from the list would read as "this group points
   * at nothing" rather than "this group points at a phone that is gone".
   *
   * `data-selected` is `cmdk`'s own highlight attribute — asserting it is what
   * proves `defaultValue` pre-highlighted the CURRENT row rather than the first
   * one, which is the difference between Enter confirming the selection and
   * Enter silently changing it.
   */
  test('the current value is listed and pre-highlighted even when it is absent from `options`', async () => {
    render(base({ value: 'dev-forgotten' }))
    expect(trigger().textContent).toContain('dev-forgotten')
    await openList()
    // Two matches, not one: the trigger shows it as well as the row. Taking
    // the last is what reaches the row — the popover is portalled to the end
    // of `body`, after the trigger.
    await waitFor(() => expect(texts('dev-forgotten')).toBe(2))
    const item = screen.getAllByText('dev-forgotten').at(-1)?.closest('[data-slot="command-item"]')
    expect(item?.getAttribute('data-selected')).toBe('true')
  })

  test('a value that IS in `options` is the pre-highlighted one, not the first row', async () => {
    render(base({ value: 'dev-b2' }))
    await openList()
    await waitFor(() => expect(texts('Pixel 5')).toBeGreaterThan(0))
    const item = screen.getAllByText('Pixel 5').at(-1)?.closest('[data-slot="command-item"]')
    expect(item?.getAttribute('data-selected')).toBe('true')
  })

  test("choosing a row reports the caller's own value verbatim and closes the list", async () => {
    const seen: string[] = []
    render(base({ value: 'dev-a1', onValueChange: (v: string) => seen.push(v) }))
    await openList()
    await waitFor(() => expect(texts('Pixel 5')).toBe(1))
    fireEvent.click(screen.getByText('Pixel 5'))
    // Verbatim: `cmdk` derives and trims its own copy of the item value before
    // handing it to `onSelect`. The component ignores that argument and reports
    // the option's own `value`, so a device id survives unchanged.
    await waitFor(() => expect(seen).toEqual(['dev-b2']))
    await waitFor(() => expect(inputs()).toBe(0))
  })

  /** §4.3 behaviour 2. `cmdk`/Radix's own dismissal — asserted, not re-implemented. */
  test('Escape dismisses and changes nothing', async () => {
    const seen: string[] = []
    render(base({ value: 'dev-a1', onValueChange: (v: string) => seen.push(v) }))
    const input = await openList()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(inputs()).toBe(0))
    expect(seen).toEqual([])
    expect(trigger().textContent).toContain('Galaxy A15')
  })

  /**
   * §4.3 behaviour 3. An empty list and a failed fetch look identical, and
   * "this farm has no devices" is a very different statement from "we could not
   * ask it". The message must replace the list rather than sit above an empty
   * one — so the rows are gone AND the empty text never appears.
   */
  test('`error` replaces the list instead of rendering an empty one', async () => {
    render(base({ error: 'The device list failed to load — core unreachable' }))
    fireEvent.click(trigger())
    await waitFor(() => expect(texts(/core unreachable/)).toBeGreaterThan(0))
    expect(texts('Galaxy A15')).toBe(0)
    expect(texts('No match.')).toBe(0)
  })

  /**
   * §4.3 behaviour 4, and plan 19 §4.4's farm-wide rule: a thing you cannot
   * pick stays visible with the reason. Removing the row instead would leave an
   * operator hunting for a device that is right there in the rack.
   */
  test('a disabled option shows its reason, and clicking it selects nothing', async () => {
    const seen: string[] = []
    render(
      base({
        onValueChange: (v: string) => seen.push(v),
        options: [
          ...DEVICES,
          {
            value: 'dev-c3',
            label: 'Galaxy A15 (spare)',
            hint: 'RF8N20ZZZZZ',
            disabled: true,
            disabledReason: 'Already in this group',
          },
        ],
      }),
    )
    await openList()
    await waitFor(() => expect(texts('Already in this group')).toBe(1))
    const item = screen.getByText('Already in this group').closest('[data-slot="command-item"]')
    expect(item?.getAttribute('data-disabled')).toBe('true')
    fireEvent.click(item as Element)
    // Still open, nothing chosen — the two halves of "not selectable".
    expect(inputs()).toBe(1)
    expect(seen).toEqual([])
  })

  test('`disabled` on the whole control disables the trigger', () => {
    render(base({ disabled: true }))
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})
