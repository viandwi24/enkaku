import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import WorkspacePage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * `/workspace` (plan 64) talks to the `fs.*` capabilities through
 * `lib/workspace.ts`'s own `invokeCap` wrapper (out of scope for this plan —
 * owned elsewhere, already migrated to `api()` + a real schema on its own).
 * Every call lands on `POST /api/v1/cap/:id`; this smoke render mocks that
 * one path for the page's own call sites.
 */
describe('WorkspacePage — smoke render', () => {
  test('loaded: lists the root directory', async () => {
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': {
        body: { ok: true, output: { entries: [{ path: '/hello.ts', kind: 'file', size: 12, hash: 'abc', updatedAt: 0 }] } },
      },
    })
    await waitFor(() => expect(screen.getByText('hello.ts')).toBeTruthy())
  })

  test('loaded: empty directory shows the empty hint', async () => {
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [] } } },
    })
    await waitFor(() => expect(screen.getByText('Nothing here yet.')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the directory loads', () => {
    renderWithApi(<WorkspacePage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed fs.list call shows a named error', async () => {
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'workspace boom' } } },
    })
    await waitFor(() => expect(screen.getByText('workspace boom')).toBeTruthy())
  })
})
