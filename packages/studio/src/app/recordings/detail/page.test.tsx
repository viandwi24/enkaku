import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import RecordingDetailPage from './page'

/**
 * `/recordings/detail?slug=…` — the review panel (plan 94 §4.10, §5 step
 * 94.5). `?slug=`, not a dynamic route segment (Studio is a static export,
 * `app/device/page.tsx`'s own `?id=` precedent). Covers the brief's own
 * named requirements: candidate + match count + anchor age, Promote gated on
 * count === 1, trim/delete/reorder, parameterise a text step, and — the
 * privacy requirement — a visible line at a step holding a stored-verbatim
 * literal, before publish.
 */

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function doc(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    name: 'checkout-flow',
    version: '1.0.0',
    description: 'Taps through checkout',
    recordedAt: 1_700_000_000,
    recordedOn: { stableId: 'abc123', model: 'moto g06 power', width: 1080, height: 2400 },
    speed: 1,
    maxGapMs: 15_000,
    cleanup: 'force-stop',
    packages: ['com.example.app'],
    steps: [
      {
        kind: 'tap',
        gapMs: 400,
        target: { kind: 'point', pos: { x: 0.5, y: 0.3 } },
        holdMs: 80,
        candidate: { selector: { id: 'com.example.app:id/btn' }, count: 1, anchorAgeMs: 120, anchorStepsSince: 0, anchorPackage: 'com.example.app' },
      },
      {
        kind: 'tap',
        gapMs: 200,
        target: { kind: 'point', pos: { x: 0.2, y: 0.8 } },
        candidate: { selector: { desc: 'row' }, count: 4, anchorAgeMs: 50, anchorStepsSince: 1, anchorPackage: 'com.example.app' },
      },
      { kind: 'text', gapMs: 500, value: 'hunter2' },
    ],
    ...overrides,
  }
}

function detailBody(overrides: Record<string, unknown> = {}) {
  return { slug: 'checkout-flow', doc: doc(), hash: 'h1', detached: false, publishedVersion: null, generatedSource: 'export default defineRecording({})', ...overrides }
}

describe('RecordingDetailPage — smoke render', () => {
  test('no slug given: an honest error, not a crash', () => {
    setSearchParams({})
    renderWithApi(<RecordingDetailPage />)
    expect(screen.getByText(/No recording specified/)).toBeTruthy()
  })

  test('loaded: shows the name, recorded-device note, and each step', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getByText(/Recorded on moto g06 power/)).toBeTruthy()
    expect(screen.getByText(/1080×2400/)).toBeTruthy()
    expect(screen.getAllByText('Tap')).toHaveLength(2)
  })

  test('a unique candidate (count 1) enables Promote; a 4-way match disables it with a reason', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    const promoteButtons = screen.getAllByRole('button', { name: 'Promote' }) as HTMLButtonElement[]
    expect(promoteButtons).toHaveLength(2)
    expect(promoteButtons[0]?.disabled).toBe(false)
    expect(promoteButtons[1]?.disabled).toBe(true)
    expect(promoteButtons[1]?.title).toContain('4 elements match')
  })

  test('the match count and anchor age are shown per step', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getByText('1 match')).toBeTruthy()
    expect(screen.getByText('4 matches')).toBeTruthy()
    expect(screen.getByText(/anchor 120 ms old, 0 step\(s\) since/)).toBeTruthy()
  })

  test('promoting turns a point target into a selector target', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    await user.click(screen.getAllByRole('button', { name: 'Promote' })[0] as HTMLButtonElement)
    expect(screen.getByText(/selector.*com.example.app:id\/btn/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Demote to point' })).toBeTruthy()
  })

  test('a literal typed-text step shows the verbatim-storage warning, before publish', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getByText(/Stored verbatim/)).toBeTruthy()
    expect(screen.getByText('"hunter2"')).toBeTruthy()
    // the summary line above the step list, too
    expect(screen.getByText(/store typed text verbatim/)).toBeTruthy()
  })

  test('parameterising a text step replaces the literal with a {param} reference', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    await user.type(screen.getByPlaceholderText(/parameter name/), 'password')
    await user.click(screen.getByRole('button', { name: 'Parameterise' }))
    expect(screen.getByText('param: password')).toBeTruthy()
    expect(screen.queryByText('"hunter2"')).toBeNull()
  })

  test('Revert to literal restores the exact text a step held before parameterising, in the same session (96.17)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    await user.type(screen.getByPlaceholderText(/parameter name/), 'password')
    await user.click(screen.getByRole('button', { name: 'Parameterise' }))
    expect(screen.getByText('param: password')).toBeTruthy()
    expect(screen.queryByText('"hunter2"')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Revert to literal' }))
    // The literal must come back verbatim — NOT be blanked (the 96.17 bug: it used to silently set value to '').
    expect(screen.getByText(/Stored verbatim/)).toBeTruthy()
    expect(screen.getByText('"hunter2"')).toBeTruthy()
    expect(screen.queryByText('param: password')).toBeNull()
  })

  test('a step already parameterised on load has nothing to revert to, and says so honestly instead of offering a fake revert', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, {
      '/api/recordings/checkout-flow': { body: detailBody({ doc: doc({ steps: [{ kind: 'text', gapMs: 500, value: { param: 'password' } }] }) }) },
    })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getByText('param: password')).toBeTruthy()
    // No "Revert to literal" button — there is nothing this tab could restore.
    expect(screen.queryByRole('button', { name: 'Revert to literal' })).toBeNull()
    expect(screen.getByText(/original text not kept/)).toBeTruthy()
    const clearButton = screen.getByRole('button', { name: 'Clear and re-type as literal' })
    expect(clearButton).toBeTruthy()
  })

  test('deleting a step removes it from the list and enables Save', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody() } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getAllByText('Tap')).toHaveLength(2)
    const deleteButtons = screen.getAllByRole('button').filter((b) => b.querySelector('svg.lucide-trash2'))
    await user.click(deleteButtons[0] as HTMLElement)
    expect(screen.getAllByText('Tap')).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('Save PATCHes the edited doc with the CAS hash and reports success', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ slug: 'checkout-flow' })
    const { apiMock } = renderWithApi(<RecordingDetailPage />, {
      '/api/recordings/checkout-flow': (req) => {
        if (req.method === 'PATCH') return { body: { slug: 'checkout-flow', doc: doc({ speed: 2 }), hash: 'h2' } }
        return { body: detailBody() }
      },
    })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    const speedInput = screen.getByDisplayValue('1')
    await user.clear(speedInput)
    await user.type(speedInput, '2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patchCall = apiMock.calls.find((c) => c.method === 'PATCH')
    expect((patchCall?.body as { ifMatch: string }).ifMatch).toBe('h1')
  })

  test('Publish sends the version and, on success, refreshes the published badge', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ slug: 'checkout-flow' })
    let published = false
    renderWithApi(<RecordingDetailPage />, {
      '/api/recordings/checkout-flow': () => ({ body: detailBody(published ? { publishedVersion: '1.0.1' } : {}) }),
      '/api/recordings/checkout-flow/publish': () => {
        published = true
        return { status: 201, body: { script: { id: 's1', name: 'checkout-flow', version: '1.0.1' } } }
      },
    })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Publish as script' }))
    await waitFor(() => expect(screen.getByText('published 1.0.1')).toBeTruthy())
  })

  test('a detached recording disables replay-setting edits and hides the publish panel', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, { '/api/recordings/checkout-flow': { body: detailBody({ detached: true, generatedSource: null }) } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getByText('detached')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish as script' })).toBeNull()
    expect(screen.getByText(/Already detached/)).toBeTruthy()
  })

  test('error: a failed fetch shows a named error with a retry', async () => {
    setSearchParams({ slug: 'checkout-flow' })
    renderWithApi(<RecordingDetailPage />, {
      '/api/recordings/checkout-flow': { status: 404, body: { error: { code: 'E_RECORDING_NOT_FOUND', message: 'no such recording' } } },
    })
    await waitFor(() => expect(screen.getByText('no such recording')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
