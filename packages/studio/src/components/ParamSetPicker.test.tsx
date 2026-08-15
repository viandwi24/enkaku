import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ParamSetPicker } from './ParamSetPicker'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const schema = {
  type: 'object',
  properties: {
    videos: { type: 'integer' },
    chance: { type: 'number', minimum: 0, maximum: 0.5, default: 0.5 },
  },
}

const aggressive = {
  id: 'set-1',
  scriptName: 'checkout',
  name: 'Aggressive',
  params: { videos: 500, chance: 0.9, legacyFlag: true },
  createdBy: 'u1',
  createdAt: 0,
  updatedAt: 0,
}

/** This workspace's `bun:test` has no `@testing-library/jest-dom` extension
 *  (see `ScheduleEditorDialog.test.tsx`'s own comment) — a plain property
 *  read is what actually reflects the live DOM node, not `.toBeDisabled()`. */
function disabled(name: string): boolean {
  return (screen.getByRole('button', { name }) as HTMLButtonElement).disabled
}

describe('ParamSetPicker — smoke render and fetch', () => {
  test('no scriptName: renders nothing, fetches nothing', () => {
    const { apiMock } = renderWithApi(<ParamSetPicker scriptName="" schema={null} value={undefined} onApply={() => {}} />, {})
    expect(screen.queryByText('Preset')).toBeNull()
    expect(apiMock.calls).toHaveLength(0)
  })

  test('a script with no saved presets: lists none, and Update/Delete stay disabled', async () => {
    renderWithApi(
      <ParamSetPicker scriptName="checkout" schema={schema} value={{}} onApply={() => {}} />,
      { '/api/scripts/checkout/param-sets': { body: { items: [] } } },
    )
    await waitFor(() => expect(screen.getByText('Preset')).toBeTruthy())
    expect(disabled('Update')).toBe(true)
    expect(disabled('Delete')).toBe(true)
  })

  test('fetches the list scoped to the given script name', async () => {
    const { apiMock } = renderWithApi(
      <ParamSetPicker scriptName="checkout" schema={schema} value={{}} onApply={() => {}} />,
      { '/api/scripts/checkout/param-sets': { body: { items: [aggressive] } } },
    )
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/scripts/checkout/param-sets' && c.method === 'GET')).toBe(true))
    fireEvent.click(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText('Aggressive')).toBeTruthy())
  })
})

describe('ParamSetPicker — applying a preset reconciles it first (plan 95 §4.4, §4.7, §5 step 95.8)', () => {
  test('a value that still fits the schema is applied unchanged, and onApply receives it', async () => {
    let applied: unknown = 'not called'
    const clean = { id: 'set-2', scriptName: 'checkout', name: 'Steady', params: { videos: 10, chance: 0.2 }, createdBy: null, createdAt: 0, updatedAt: 0 }
    renderWithApi(
      <ParamSetPicker
        scriptName="checkout"
        schema={schema}
        value={{}}
        onApply={(next) => {
          applied = next
        }}
      />,
      { '/api/scripts/checkout/param-sets': { body: { items: [clean] } } },
    )
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByText('Steady'))
    await waitFor(() => expect(applied).toEqual({ videos: 10, chance: 0.2 }))
  })

  test('a value the schema has since tightened is reset to its new default before reaching onApply — never the raw stored 0.9', async () => {
    let applied: unknown = 'not called'
    renderWithApi(
      <ParamSetPicker
        scriptName="checkout"
        schema={schema}
        value={{}}
        onApply={(next) => {
          applied = next
        }}
      />,
      { '/api/scripts/checkout/param-sets': { body: { items: [aggressive] } } },
    )
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByText('Aggressive'))
    // `chance: 0.9` no longer satisfies `maximum: 0.5` — reconciled to the schema's
    // own default (0.5); `legacyFlag` (not in THIS schema at all) is dropped.
    await waitFor(() => expect(applied).toEqual({ videos: 500, chance: 0.5 }))
  })
})

describe('ParamSetPicker — Save as / Update / Delete', () => {
  test('Save as…: reveals a name field; saving POSTs { name, params: value } and selects the new preset', async () => {
    const { apiMock } = renderWithApi(
      <ParamSetPicker scriptName="checkout" schema={schema} value={{ videos: 42 }} onApply={() => {}} />,
      {
        '/api/scripts/checkout/param-sets': (req) =>
          req.method === 'POST'
            ? {
                status: 201,
                body: { paramSet: { id: 'set-new', scriptName: 'checkout', name: 'New preset', params: { videos: 42 }, createdBy: 'u1', createdAt: 0, updatedAt: 0 } },
              }
            : { body: { items: [] } },
      },
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as…' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save as…' }))
    const input = await screen.findByPlaceholderText('Preset name')
    fireEvent.change(input, { target: { value: 'New preset' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/scripts/checkout/param-sets')).toBe(true))
    const post = apiMock.calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ name: 'New preset', params: { videos: 42 } })
    // Selecting the freshly-saved preset enables Update/Delete with no second click.
    await waitFor(() => expect(disabled('Update')).toBe(false))
  })

  test('Update: PATCHes the SELECTED preset with the CURRENT form value, not its own saved one', async () => {
    const { apiMock } = renderWithApi(
      <ParamSetPicker scriptName="checkout" schema={schema} value={{ videos: 500, chance: 0.9, legacyFlag: true }} onApply={() => {}} />,
      {
        '/api/scripts/checkout/param-sets': { body: { items: [aggressive] } },
        '/api/scripts/checkout/param-sets/set-1': { body: { paramSet: { ...aggressive, params: { videos: 500, chance: 0.5 } } } },
      },
    )
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByText('Aggressive'))
    await waitFor(() => expect(disabled('Update')).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = apiMock.calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe('/api/scripts/checkout/param-sets/set-1')
    // The CALLER's own `value` prop at click time — the picker never invents
    // its own idea of "current settings".
    expect(patch.body).toEqual({ params: { videos: 500, chance: 0.9, legacyFlag: true } })
  })

  test('Delete: confirms first, then DELETEs the selected preset and clears the selection', async () => {
    const originalConfirm = window.confirm
    window.confirm = () => true
    try {
      const { apiMock } = renderWithApi(
        <ParamSetPicker scriptName="checkout" schema={schema} value={{}} onApply={() => {}} />,
        {
          '/api/scripts/checkout/param-sets': { body: { items: [aggressive] } },
          '/api/scripts/checkout/param-sets/set-1': { body: { ok: true } },
        },
      )
      await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
      fireEvent.click(screen.getByRole('combobox'))
      fireEvent.click(await screen.findByText('Aggressive'))
      await waitFor(() => expect(disabled('Delete')).toBe(false))

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'DELETE')).toBe(true))
      const del = apiMock.calls.find((c) => c.method === 'DELETE')!
      expect(del.path).toBe('/api/scripts/checkout/param-sets/set-1')
      await waitFor(() => expect(disabled('Delete')).toBe(true))
    } finally {
      window.confirm = originalConfirm
    }
  })

  test('Delete: declining the confirmation sends no request', async () => {
    const originalConfirm = window.confirm
    window.confirm = () => false
    try {
      const { apiMock } = renderWithApi(
        <ParamSetPicker scriptName="checkout" schema={schema} value={{}} onApply={() => {}} />,
        { '/api/scripts/checkout/param-sets': { body: { items: [aggressive] } } },
      )
      await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
      fireEvent.click(screen.getByRole('combobox'))
      fireEvent.click(await screen.findByText('Aggressive'))
      await waitFor(() => expect(disabled('Delete')).toBe(false))

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      expect(apiMock.calls.some((c) => c.method === 'DELETE')).toBe(false)
    } finally {
      window.confirm = originalConfirm
    }
  })
})
