import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { AppShell } from './AppShell'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(() => {
  cleanup()
  // The collapsed-rail test seeds `sidebarCollapsed`, and happy-dom keeps one
  // `localStorage` for the whole file — without this, every test after it
  // would render the 72px rail instead of the full sidebar.
  localStorage.clear()
})

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

/**
 * The Scripts/Plugins merge (owner's own ask, 2026-08-17) — one nav entry for
 * one screen. The old Scripts item's `scripts` count is FOLDED INTO this
 * entry rather than dropped: it shows while there is no failure to warn
 * about, and yields to the warning when there is.
 */
describe('AppShell — Scripts merged into the Plugins entry', () => {
  test('there is no Scripts nav entry, and the Plugins entry names both halves', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: 'Plugins & scripts' }))
    expect(link.getAttribute('href')).toBe('/plugins')
    expect(screen.queryByRole('link', { name: 'Scripts' })).toBeNull()
    expect(screen.queryAllByRole('link').some((a) => a.getAttribute('href') === '/scripts')).toBe(false)
  })

  test('with no failed plugin, the entry carries the neutral script count the Scripts item used to', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/scripts': { body: { scripts: [], total: 41 } },
      '/api/plugins': { body: { items: [{ id: 'p1', name: 'tiktok', version: '1.0.0', status: 'active' }], dev: [] } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: 'Plugins & scripts' }))
    await waitFor(() => expect(link.textContent).toContain('41'))
    // A count, not a warning — no `role="status"` and no danger tone.
    expect(link.querySelector('[role="status"]')).toBeNull()
  })

  test('a failed plugin outranks the script count — the warning is shown instead, never beside it', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/scripts': { body: { scripts: [], total: 41 } },
      '/api/plugins': {
        body: { items: [{ id: 'p2', name: 'broken-pack', version: '1.0.0', status: 'failed', verifyError: 'boom' }], dev: [] },
      },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: 'Plugins & scripts' }))
    await waitFor(() => expect(link.querySelector('[role="status"]')).toBeTruthy())
    expect(link.textContent).toContain('1')
    expect(link.textContent).not.toContain('41')
  })
})

/**
 * The content pane's own floating rounded panel (plan 101 §5 step 101.8,
 * owner-specified 2026-08-16) — the sidebar's visual counterpart
 * (`refs/ui`'s whole content area is a large rounded panel inset from the
 * window edge; before this step Studio's content rendered flush edge-to-
 * edge with no container at all). Asserted against the rendered classes
 * rather than a pixel measurement, the same style `design-rules.test.ts`
 * already uses for this codebase's other CSS-only rules.
 */
describe('AppShell — the content pane floats as a rounded panel (plan 101 §5 step 101.8)', () => {
  test('the content wrapper around <main> carries the desktop-only rounded-panel treatment', async () => {
    const { container } = renderWithApi(<AppShell>content</AppShell>, emptyPages)
    const main = await waitFor(() => container.querySelector('main'))
    expect(main).toBeTruthy()
    const panel = main?.parentElement
    expect(panel?.className).toContain('lg:rounded-[22px]')
    expect(panel?.className).toContain('lg:bg-surface-2/40')
    // No backdrop-filter on this element — `design-rules.test.ts` does not
    // scope to AppShell.tsx (it is the one file allowed to carry the
    // sidebar's own blur), but this panel specifically should not add a
    // second one: the reference's own content container has none either.
    expect(panel?.className).not.toMatch(/backdrop-(blur|filter|saturate)/)
  })

  test('the ambient glow is decorative — aria-hidden and pointer-events-none', async () => {
    const { container } = renderWithApi(<AppShell>content</AppShell>, emptyPages)
    await waitFor(() => expect(container.querySelector('main')).toBeTruthy())
    const glows = container.querySelectorAll('[aria-hidden="true"].pointer-events-none.rounded-full')
    expect(glows.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * Plan 108 (M73) §3.5, §5 step 108.8, criterion 7 — a live plugin's declared
 * screens appear in the sidebar, in their OWN labelled group below the static
 * nav rather than interleaved with it, so installing or removing a plugin
 * never moves Jobs or Devices to a different place.
 */
describe('AppShell — plugin-declared nav entries (plan 108 step 108.8)', () => {
  const withUi = (items: unknown[]) => ({
    ...emptyPages,
    '/api/plugins': { body: { items: [], dev: [] } },
    '/api/plugins/ui': { body: { items } },
  })

  const tiktokAccounts = (over: Record<string, unknown> = {}, navOver: Record<string, unknown> = {}) => ({
    plugin: 'tiktok',
    version: '1.0.0',
    origin: 'plugin',
    nav: [{ id: 'accounts', label: 'TikTok Accounts', icon: 'users', view: 'accounts', ...navOver }],
    ...over,
  })

  test('a plugin entry renders in its own group, linking to /plugins/view with the plugin and view named', async () => {
    renderWithApi(<AppShell>content</AppShell>, withUi([tiktokAccounts()]))

    const link = await screen.findByRole('link', { name: /tiktok accounts/i })
    expect(link.getAttribute('href')).toBe('/plugins/view?name=tiktok&view=accounts')

    // Its own group, and the static nav is NOT inside it.
    const group = screen.getByRole('group', { name: /plugin views/i })
    expect(group.contains(link)).toBe(true)
    expect(group.contains(screen.getByRole('link', { name: 'Plugins & scripts' }))).toBe(false)
    expect(group.contains(screen.getByRole('link', { name: 'Devices' }))).toBe(false)
  })

  test('an unknown icon name falls back to a default icon instead of throwing', async () => {
    renderWithApi(<AppShell>content</AppShell>, withUi([tiktokAccounts({}, { icon: 'not-a-real-icon' })]))

    const link = await screen.findByRole('link', { name: /tiktok accounts/i })
    // Still an icon, and still the whole static nav around it.
    expect(link.querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Devices' })).toBeTruthy()
  })

  test('a dev-slot entry carries a DEV chip', async () => {
    renderWithApi(
      <AppShell>content</AppShell>,
      withUi([tiktokAccounts({ origin: 'dev', version: '1.0.0+dev.3' })]),
    )

    const link = await screen.findByRole('link', { name: /tiktok accounts/i })
    expect(link.textContent).toContain('DEV')
  })

  test('a published entry carries no DEV chip', async () => {
    renderWithApi(<AppShell>content</AppShell>, withUi([tiktokAccounts()]))
    const link = await screen.findByRole('link', { name: /tiktok accounts/i })
    expect(link.textContent).not.toContain('DEV')
  })

  test('a failed /api/plugins/ui read leaves the static nav intact and adds no group', async () => {
    const { apiMock } = renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/plugins': { body: { items: [], dev: [] } },
      '/api/plugins/ui': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
    })

    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/plugins/ui')).toBe(true))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Devices' })).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Plugins & scripts' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: /plugin views/i })).toBeNull()
  })

  test('collapsed, the entry is still an icon with a tooltip — nothing moves into an overflow menu', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    localStorage.setItem('enkaku:local-prefs', JSON.stringify({ sidebarCollapsed: true }))

    renderWithApi(<AppShell>content</AppShell>, withUi([tiktokAccounts()]))

    const link = await screen.findByRole('link', { name: 'TikTok Accounts' })
    await waitFor(() => expect(link.textContent).not.toContain('TikTok Accounts'))
    expect(link.querySelector('svg')).toBeTruthy()

    // Hover, not click, is what shows a Radix tooltip's content.
    await user.hover(link)
    await waitFor(() => expect(document.body.textContent).toContain('TikTok Accounts'))
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
    // `/topology` is a 22-line `router.replace('/?view=wall&group=cluster')`
    // — a compatibility redirect kept so an old bookmark still resolves
    // (plan 47 §3.6), not a page with content of its own. Hotfix §96.29 read
    // it as an orphaned page and gave it a nav entry; that was wrong twice
    // over. The view it redirects to already has a front door — the grid's
    // own `GroupBy` control (`app/page.tsx`) — so the nav item was a second
    // door onto a screen the operator is usually already looking at, which
    // is the exact thing plan 101 §2 declined to build for the reference
    // design's separate Dashboard. Excluded here rather than re-added, and
    // this comment exists so the next person does not "fix" it back.
    '/topology',
    // `/scripts` is the same shape and here for the same reason: since the
    // owner's 2026-08-17 merge (*"halaman scripts menurut saya jadi satu aja
    // dengan plugins"*) it is a query-preserving `router.replace('/plugins')`
    // — a compatibility redirect kept so an old bookmark, and the
    // `?device=`/`?cluster=` Run links that were in flight when this shipped,
    // still resolve. Giving it a nav entry would put a second door in the
    // sidebar onto the screen `/plugins` already opens, which is precisely
    // the duplication the merge removed. The directory also still holds
    // `scripts/detail`, the real page a script row links to — a detail page
    // is legitimately reached from its list, never from the nav.
    '/scripts',
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
