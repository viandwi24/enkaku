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

describe('every top-level page has a way in', () => {
  /**
   * `/workflows`, `/recordings` and `/topology` were all built, tested and
   * shipped with no sidebar entry. Two were reachable only by a deep link
   * that appears after you have already done something else
   * (`RunScriptDialog`'s editor link; `RecordPanel`'s post-capture review
   * link), so their LIST pages — the way you find work you did yesterday —
   * could not be opened at all. `/topology` had no link anywhere in Studio.
   *
   * This test reads the router's own page files rather than a hand-kept
   * list, so a future page added without a front door fails here instead of
   * being found by an operator. It checks TOP-LEVEL routes only: detail
   * pages are legitimately reached from their list, and auth/dev routes are
   * legitimately not in the nav.
   */
  const NOT_IN_NAV_BY_DESIGN = new Set([
    '/device', // opened from the device list and the wall
    '/login', // auth route, AuthGate redirects here
    '/setup', // first-run only
    '/dev', // /dev/tools, a development-only surface
  ])

  test('no built top-level page is missing from the sidebar', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const appDir = new URL('../../app/', import.meta.url).pathname

    const topLevel = readdirSync(appDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `/${e.name}`)
      .filter((r) => !NOT_IN_NAV_BY_DESIGN.has(r))

    const shell = readFileSync(new URL('./AppShell.tsx', import.meta.url).pathname, 'utf8')
    const inNav = new Set([...shell.matchAll(/href: '([^']+)'/g)].map((m) => m[1]))

    const orphaned = topLevel.filter((r) => !inNav.has(r))
    expect(orphaned).toEqual([])
  })
})
