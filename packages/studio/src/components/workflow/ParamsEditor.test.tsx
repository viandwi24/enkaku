import { useState } from 'react'
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { WorkflowParam } from '@enkaku/protocol'
import { ParamsEditor } from './ParamsEditor'

afterEach(cleanup)

function Harness({ initial = [] as WorkflowParam[] }) {
  const [params, setParams] = useState<WorkflowParam[]>(initial)
  return <ParamsEditor params={params} onChange={setParams} />
}

async function openAndPick(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.click(trigger)
  const listbox = await screen.findByRole('listbox')
  fireEvent.click(within(listbox).getByRole('option', { name: optionName }))
}

describe('ParamsEditor — authoring `doc.params` directly (plan 99 §3.8)', () => {
  test('empty state names the alternative (Promote) rather than leaving a blank card', () => {
    render(<Harness />)
    expect(screen.getByText(/Add one here, or bind a node field/)).toBeTruthy()
  })

  test('Add parameter appends one with schema-valid defaults; editing name/title/required round-trips into onChange', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }))
    expect(screen.getByLabelText('Parameter name')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'keyword' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Search keyword' } })
    fireEvent.click(screen.getByLabelText('Required'))

    expect((screen.getByLabelText('Parameter name') as HTMLInputElement).value).toBe('keyword')
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Search keyword')
    expect(screen.getByLabelText('Required').getAttribute('aria-checked')).toBe('true')
  })

  test('switching type clears an incompatible "meaning" hint rather than carrying a stale one', async () => {
    render(<Harness initial={[{ name: 'videos', type: 'integer', required: false, title: 'Videos', description: '', hints: { kind: 'count' } }]} />)
    await openAndPick(screen.getByRole('combobox', { name: 'Parameter type' }), 'Text')
    // `count` is not a valid meaning for a string — the hint select falls back to "Plain value".
    expect(screen.getByRole('combobox', { name: 'Parameter meaning' }).textContent).toContain('Plain value')
  })

  test('Remove drops exactly the targeted parameter', () => {
    render(
      <Harness
        initial={[
          { name: 'a', type: 'string', required: false, title: 'A', description: '' },
          { name: 'b', type: 'string', required: false, title: 'B', description: '' },
        ]}
      />,
    )
    const removeButtons = screen.getAllByRole('button', { name: 'Remove parameter' })
    fireEvent.click(removeButtons[0]!)
    expect(screen.queryByDisplayValue('a')).toBeNull()
    expect(screen.getByDisplayValue('b')).toBeTruthy()
  })
})
