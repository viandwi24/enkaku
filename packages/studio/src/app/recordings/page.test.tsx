import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import RecordingsPage from './page'

/**
 * `/recordings` (plan 94 §4.10, §5 step 94.5) — smoke render, following the
 * same pattern every other list page's own `page.test.tsx` already uses
 * (`app/clusters/page.test.tsx`, `app/batches/page.test.tsx`).
 */

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const item = {
  slug: 'checkout-flow',
  name: 'checkout-flow',
  description: 'Taps through checkout',
  stepCount: 12,
  recordedAt: Math.floor(Date.now() / 1000) - 60,
  detached: false,
  publishedVersion: null,
  corrupt: false,
}

describe('RecordingsPage — smoke render', () => {
  test('loaded: shows the recording row and its status', async () => {
    renderWithApi(<RecordingsPage />, { '/api/recordings': { body: { items: [item] } } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('not published')).toBeTruthy()
  })

  test('loaded: a published recording shows its version instead', async () => {
    renderWithApi(<RecordingsPage />, {
      '/api/recordings': { body: { items: [{ ...item, publishedVersion: '1.0.0' }] } },
    })
    await waitFor(() => expect(screen.getByText('published 1.0.0')).toBeTruthy())
  })

  test('loaded: a detached recording is labelled, not "not published"', async () => {
    renderWithApi(<RecordingsPage />, {
      '/api/recordings': { body: { items: [{ ...item, detached: true }] } },
    })
    await waitFor(() => expect(screen.getByText('detached')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<RecordingsPage />, { '/api/recordings': { body: { items: [] } } })
    await waitFor(() => expect(screen.getByText('No recordings yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the list loads', () => {
    renderWithApi(<RecordingsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('the Review link points at the detail page with the slug', async () => {
    renderWithApi(<RecordingsPage />, { '/api/recordings': { body: { items: [item] } } })
    await waitFor(() => expect(screen.getByText('checkout-flow')).toBeTruthy())
    const links = screen.getAllByRole('link', { name: /Review|checkout-flow/ })
    expect(links.some((l) => l.getAttribute('href') === '/recordings/detail?slug=checkout-flow')).toBe(true)
  })
})
