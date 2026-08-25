import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

/**
 * The sidebar subscribes to the live socket (`ws.on`), and plan 126 step
 * 126.3 is specifically about WHICH messages are allowed to re-fetch what —
 * so this file has to be able to deliver one. The real `WsClient` would open
 * a `WebSocket` the moment `ws.on` is called, which is both unavailable here
 * and untriggerable from a test; the mock is the only way to drive a
 * `job.status` into the component.
 *
 * `AppShell` is imported dynamically BELOW the mock, the same shape
 * `app/console/page.test.tsx` established: `mock.module` has to be in effect
 * before the module graph under test resolves `@/lib/ws`, and a static
 * `import` at the top of the file would already have bound the real one.
 * `NotificationBell`, `ProvisioningBanner` and `AdbServerBanner` all sit
 * inside `AppShell` and take `ws` from the same module, which is why the mock
 * carries the whole surface rather than just `on`.
 */
type WsHandler = (msg: { type: string; payload?: unknown }) => void
let wsHandlers: WsHandler[] = []

mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: WsHandler) => {
      wsHandlers.push(cb)
      return () => {
        wsHandlers = wsHandlers.filter((h) => h !== cb)
      }
    },
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(true)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 'session-1',
    isConnected: () => true,
    send: () => {},
    request: () => Promise.reject(new Error('ws.request is not used by the sidebar')),
  },
  coreBase: () => 'http://core.test',
  newId: (() => {
    let n = 0
    return () => `test-id-${n++}`
  })(),
}))

const { AppShell } = await import('./AppShell')

type ServerMessageLike = { type: string; payload?: unknown }

/**
 * Delivers messages to every live `ws.on` subscriber, inside `act` so React
 * flushes what they cause. The whole list goes out before the `act` yields,
 * which is what makes a genuine BURST expressible: a handler is synchronous,
 * so all of them land while the first pass is still awaiting its `fetch`.
 */
async function emitAll(msgs: ServerMessageLike[]): Promise<void> {
  await act(async () => {
    for (const m of msgs) for (const h of [...wsHandlers]) h(m)
  })
}

const emit = (msg: ServerMessageLike): Promise<void> => emitAll([msg])

afterEach(() => {
  cleanup()
  wsHandlers = []
  // The collapsed-rail test seeds `sidebarCollapsed`, and happy-dom keeps one
  // `localStorage` for the whole file — without this, every test after it
  // would render the 72px rail instead of the full sidebar.
  localStorage.clear()
})

const emptyPages = {
  '/api/devices': { body: { devices: [], total: 0 } },
  '/api/scripts': { body: { scripts: [], total: 0 } },
  '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
  // `failedPlugins` rides on health since plan 126 step 126.5 — the sidebar
  // no longer reads `/api/plugins` at all, so this is where the farm-health
  // badge's number comes from in every test below.
  '/api/health': { body: { version: '0.1.6', mode: 'local', failedPlugins: 0 } },
}

/**
 * The badge's SOURCE moved in plan 126 step 126.5: it was a filter over the
 * whole `GET /api/plugins` list (every plugin's full built bundle, ~1 MB per
 * version row, downloaded on every Studio page for one integer — §0.4), and
 * is now a scalar on the health poll the shell already makes. The rendered
 * behaviour these tests pin is unchanged; only the fixture is.
 */
describe('AppShell — the Plugins nav entry carries a farm-health WARNING while any plugin is failed (plan 82, criterion 30)', () => {
  test('no failed plugins: the Plugins link shows no badge', async () => {
    renderWithApi(<AppShell>content</AppShell>, emptyPages)
    const link = await waitFor(() => screen.getByRole('link', { name: /plugins/i }))
    await waitFor(() => expect(link.textContent).not.toMatch(/\d/))
  })

  test('one failed plugin: the Plugins link shows a warning badge naming the count, and links to /plugins', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/health': { body: { version: '0.1.6', mode: 'local', failedPlugins: 1 } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: /plugins/i }))
    await waitFor(() => expect(link.textContent).toContain('1'))
    expect(link.getAttribute('href')).toBe('/plugins')
    // A visible status role, not just colour — colour alone is not an accessible signal.
    expect(link.querySelector('[role="status"]')).toBeTruthy()
  })

  test('a health response with no failedPlugins field (an older core) shows no badge instead of a confident zero-or-worse', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/health': { body: { version: '0.1.6', mode: 'local' } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: /plugins/i }))
    // The rest of the health read still lands, which is what proves the parse
    // did not simply fail wholesale.
    await waitFor(() => expect(document.body.textContent).toContain('0.1.6'))
    expect(link.querySelector('[role="status"]')).toBeNull()
  })

  test('a /api/health fetch failure never breaks the rest of the sidebar', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/health': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
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
    renderWithApi(<AppShell>content</AppShell>, emptyPages)
    const link = await waitFor(() => screen.getByRole('link', { name: 'Plugins & scripts' }))
    expect(link.getAttribute('href')).toBe('/plugins')
    expect(screen.queryByRole('link', { name: 'Scripts' })).toBeNull()
    expect(screen.queryAllByRole('link').some((a) => a.getAttribute('href') === '/scripts')).toBe(false)
  })

  test('with no failed plugin, the entry carries the neutral script count the Scripts item used to', async () => {
    renderWithApi(<AppShell>content</AppShell>, {
      ...emptyPages,
      '/api/scripts': { body: { scripts: [], total: 41 } },
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
      '/api/health': { body: { version: '0.1.6', mode: 'local', failedPlugins: 1 } },
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

/**
 * Plan 126 §0.4, §3.5, steps 126.3 and 126.5 — the sidebar used to re-download
 * the whole plugin list on every `device.added`, `device.removed` AND
 * `job.status`, in one `Promise.all` with the counts. `job.status` fires per
 * job transition, so on a farm running batches that was the entire plugin
 * payload — at the time, every plugin's full built bundle — several times a
 * second, to recompute a number that cannot change when a job moves state.
 * Step 126.3 took it off the event path; step 126.5 deleted the request
 * outright by moving `failedPlugins` onto `GET /api/health`.
 *
 * This describe is the regression guard for exactly that, and it is invisible
 * to every other test in this file: they all assert on what is RENDERED, and
 * the rendered sidebar is identical whether the list was fetched once, never,
 * or two hundred times. Only a request count can see it.
 */
describe('AppShell — the plugin list is never requested, and the nav read is off the job-event path (plan 126 steps 126.3, 126.5)', () => {
  const pages = {
    ...emptyPages,
    '/api/plugins/ui': { body: { items: [] } },
  }

  const countOf = (calls: { path: string }[], path: string) => calls.filter((c) => c.path === path).length
  /**
   * Every request to the plugin LIST route, however it is spelled — bare, or
   * with a query (`?name=…` is the shape the detail page uses). Deliberately
   * NOT `countOf(calls, '/api/plugins')`: a re-added fetch that happened to
   * carry a query string would slip past an exact match, and the point of
   * this suite is that no such request exists at all. `/api/plugins/ui` and
   * the other sub-paths are excluded by the `?`/exact test rather than by
   * `startsWith`, which would have swallowed them.
   */
  const listReads = (calls: { path: string }[]) =>
    calls.filter((c) => c.path === '/api/plugins' || c.path.startsWith('/api/plugins?')).length
  // `/api/health` stands in for "the counts pass ran", because it is the ONE
  // request in this tree only `AppShell` makes. `/api/jobs?limit=200` looks
  // like the obvious choice and is not: `OperationTray` renders inside the
  // shell, fetches the same path on mount and re-fetches it on the same
  // events, so counting it would measure two components at once.
  const countsPasses = (calls: { path: string }[]) => countOf(calls, '/api/health')

  test('the shell issues NO /api/plugins request at all — the nav read is the only plugin request it makes', async () => {
    const { apiMock } = renderWithApi(<AppShell>content</AppShell>, pages)
    // The positive control first, so this cannot pass merely because nothing
    // was fetched yet: the nav read and the counts pass both landed.
    await waitFor(() => expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1))
    await waitFor(() => expect(countsPasses(apiMock.calls)).toBe(1))
    expect(listReads(apiMock.calls)).toBe(0)
    // And nothing else under `/api/plugins/` either — the shell's whole
    // plugin surface is the nav route.
    expect(apiMock.calls.filter((c) => c.path.startsWith('/api/plugins')).map((c) => c.path)).toEqual(['/api/plugins/ui'])
  })

  test('the nav is fetched exactly once on mount, not once per consumer', async () => {
    const { apiMock } = renderWithApi(<AppShell>content</AppShell>, pages)
    await waitFor(() => expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1))
    await waitFor(() => expect(countsPasses(apiMock.calls)).toBe(1))
    expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1)
  })

  test('a job.status message refreshes the counts and does NOT re-fetch the plugin nav, nor introduce a list read', async () => {
    const { apiMock } = renderWithApi(<AppShell>content</AppShell>, pages)
    await waitFor(() => expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1))
    await waitFor(() => expect(countsPasses(apiMock.calls)).toBe(1))

    await emit({ type: 'job.status', payload: { jobId: 'job-1', status: 'running' } })

    // The positive control, and the reason this test cannot pass vacuously:
    // the message WAS delivered and it DID drive a counts pass. `activeJobs`
    // is a real function of job state, so re-reading the counts is correct —
    // and `failedPlugins` now rides along on that same health response for
    // free, which is the whole point of step 126.5.
    await waitFor(() => expect(countsPasses(apiMock.calls)).toBeGreaterThan(1))
    expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1)
    expect(listReads(apiMock.calls)).toBe(0)
  })

  test('device.added and device.removed do not re-fetch the plugin nav either', async () => {
    const { apiMock } = renderWithApi(<AppShell>content</AppShell>, pages)
    await waitFor(() => expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1))
    await waitFor(() => expect(countOf(apiMock.calls, '/api/devices')).toBe(1))

    await emit({ type: 'device.added', payload: { device: { id: 'dev-1' } } })
    await emit({ type: 'device.removed', payload: { id: 'dev-1' } })

    // Same control: the device count genuinely changes on these, so the device
    // read is expected to repeat — plugging a phone in cannot add a plugin
    // screen, so the nav read is not.
    await waitFor(() => expect(countOf(apiMock.calls, '/api/devices')).toBeGreaterThan(1))
    expect(countOf(apiMock.calls, '/api/plugins/ui')).toBe(1)
    expect(listReads(apiMock.calls)).toBe(0)
  })

  test('a burst of job events collapses instead of putting several passes in flight at once', async () => {
    const { apiMock } = renderWithApi(<AppShell>content</AppShell>, pages)
    await waitFor(() => expect(countsPasses(apiMock.calls)).toBe(1))

    await emitAll(Array.from({ length: 12 }, (_, i) => ({ type: 'job.status', payload: { jobId: `job-${i}`, status: 'running' } })))

    // Twelve events, never twelve concurrent passes: the pass in flight owns
    // the state and everything arriving while it runs collapses into ONE
    // follow-up, so a stale reply can never land after a newer one. At most
    // two passes follow the mount's — the one the burst started, and the one
    // the other eleven collapsed into.
    await waitFor(() => expect(countsPasses(apiMock.calls)).toBeGreaterThan(1))
    expect(countsPasses(apiMock.calls)).toBeLessThanOrEqual(3)
    expect(listReads(apiMock.calls)).toBe(0)
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
