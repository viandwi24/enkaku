import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { AppShell } from './AppShell'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const emptyPages = {
  '/api/devices': { body: { devices: [], total: 0 } },
  '/api/scripts': { body: { scripts: [], total: 0 } },
  '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/health': { body: { version: '0.1.6', mode: 'local' } },
}

describe('AppShell — the Plugins nav entry carries a farm-health WARNING while any plugin is failed (plan 82, criterion 30)', () => {
  test('no failed plugins: the Plugins link shows no badge', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/plugins': { body: { items: [{ id: 'p1', name: 'tiktok', version: '1.0.0', status: 'active' }], dev: [] } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: /plugins/i }))
    await waitFor(() => expect(link.textContent).not.toMatch(/\d/))
  })

  test('one failed plugin: the Plugins link shows a warning badge naming the count, and links to /plugins', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/plugins': {
        body: {
          items: [
            { id: 'p1', name: 'tiktok', version: '1.0.0', status: 'active' },
            { id: 'p2', name: 'broken-pack', version: '1.0.0', status: 'failed', verifyError: 'boom' },
          ],
          dev: [],
        },
      },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: /plugins/i }))
    await waitFor(() => expect(link.textContent).toContain('1'))
    expect(link.getAttribute('href')).toBe('/plugins')
    // A visible status role, not just colour — colour alone is not an accessible signal.
    expect(link.querySelector('[role="status"]')).toBeTruthy()
  })

  test('a /api/plugins fetch failure never breaks the rest of the sidebar', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/plugins': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
    })
    await waitFor(() => expect(screen.getByRole('link', { name: /devices/i })).toBeTruthy())
    expect(screen.getByRole('link', { name: /plugins/i })).toBeTruthy()
  })
})
