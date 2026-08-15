import { useState } from 'react'
import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, within } from '@testing-library/react'
import type { Predicate } from '@enkaku/protocol'
import { cleanup, render } from '@testing-library/react'
import { placeholderPredicate } from './model'
import { PredicateEditor } from './PredicateEditor'

afterEach(cleanup)

function Harness({ initial = placeholderPredicate() }: { initial?: Predicate }) {
  const [value, setValue] = useState<Predicate>(initial)
  return (
    <>
      <PredicateEditor value={value} onChange={setValue} workflowParams={[]} nodeOptions={[]} />
      <pre data-testid="value">{JSON.stringify(value)}</pre>
    </>
  )
}

function currentValue(): Predicate {
  return JSON.parse(screen.getByTestId('value').textContent ?? 'null') as Predicate
}

async function openAndPick(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.click(trigger)
  const listbox = await screen.findByRole('listbox')
  fireEvent.click(within(listbox).getByRole('option', { name: optionName }))
}

describe('PredicateEditor — the one bespoke control (plan 99 §4.11, §5 step 99.9)', () => {
  test('switching the shape to "All of" wraps the current condition as the first child', async () => {
    render(<Harness />)
    await openAndPick(screen.getByRole('combobox', { name: 'Condition shape' }), 'All of (AND)')
    const value = currentValue()
    expect('all' in value).toBe(true)
    expect((value as { all: Predicate[] }).all).toHaveLength(1)
  })

  test('"Add condition" appends a placeholder; the remove button drops exactly one', async () => {
    render(<Harness initial={{ all: [placeholderPredicate(), placeholderPredicate()] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    expect((currentValue() as { all: Predicate[] }).all).toHaveLength(3)

    const removeButtons = screen.getAllByRole('button', { name: 'Remove condition' })
    fireEvent.click(removeButtons[0]!)
    expect((currentValue() as { all: Predicate[] }).all).toHaveLength(2)
  })

  test('the last remaining condition in a group has no remove button — a group of zero is not representable', () => {
    render(<Harness initial={{ any: [placeholderPredicate()] }} />)
    expect(screen.queryByRole('button', { name: 'Remove condition' })).toBeNull()
  })

  test('nesting is capped at WORKFLOW_LIMITS.maxPredicateDepth — the deepest level shows the limit note instead of a further nested editor', () => {
    // Three levels of `all`, each wrapping the next — depth 3 is the cap
    // (`WORKFLOW_LIMITS.maxPredicateDepth`), so the innermost `all`'s own
    // child (a leaf) never gets its own recursive `PredicateEditor`.
    const deep: Predicate = { all: [{ all: [{ all: [placeholderPredicate()] }] }] }
    render(<Harness initial={deep} />)
    // One "Condition shape" selector per level actually rendered — levels 1–3, never a 4th.
    expect(screen.getAllByRole('combobox', { name: 'Condition shape' })).toHaveLength(3)
    expect(screen.getByText(/Nested 3 levels deep/)).toBeTruthy()
  })

  test('an operator changing the comparison to "exists" (unary) removes the right-hand operand editor', async () => {
    render(<Harness initial={{ left: { const: 1 }, op: 'eq', right: { const: 2 } }} />)
    expect(screen.getAllByRole('combobox', { name: 'Value source' })).toHaveLength(2)
    await openAndPick(screen.getByRole('combobox', { name: 'Comparison' }), 'exists')
    expect(screen.getAllByRole('combobox', { name: 'Value source' })).toHaveLength(1)
    expect(currentValue()).toEqual({ left: { const: 1 }, op: 'exists' })
  })
})
