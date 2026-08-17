import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import PluginViewPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * Plan 108 §3.5, criteria 8 and 9 — the page's whole job is to turn two
 * QUERY parameters into a view, and to say the right thing when it cannot.
 *
 * Query parameters, not route segments: Studio is `output: 'export'`, so
 * `/plugins/[name]/[view]` has no server to resolve it. `/device?id=…` set
 * this precedent and this page follows it exactly.
 */

const VIEW_BODY = {
  plugin: 'tiktok',
  version: '1.2.0',
  origin: 'plugin',
  viewId: 'accounts',
  view: {
    title: 'TikTok accounts',
    description: 'Which accounts are signed in on each device.',
    data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: true },
    table: { rowKey: 'username', selectable: true, columns: [{ field: 'username', header: 'Account' }] },
    toolbar: [],
    rowActions: [],
  },
  actions: {},
}

const SCAN_ROWS = {
  items: [
    {
      deviceId: 'dev-1',
      stableId: 'SER1',
      label: 'Pixel 7',
      status: 'online',
      clusterId: null,
      number: 12,
      entry: { key: 'accounts', value: { accounts: [{ username: 'alice' }] }, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 1_700_000_000 },
    },
  ],
  nextCursor: null,
}

describe('PluginViewPage — the query parameters drive the fetch', () => {
  test('?name= and ?view= are what the view request is built from', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    const { apiMock } = renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { body: VIEW_BODY },
      '/api/plugins/tiktok/data/scan*': { body: SCAN_ROWS },
    })
    await waitFor(() => expect(screen.getByText('TikTok accounts')).toBeTruthy())
    expect(apiMock.calls.some((c) => c.path === '/api/plugins/tiktok/view/accounts')).toBe(true)
  })

  test('a different ?view= asks for a different screen of the same plugin', async () => {
    setSearchParams({ name: 'tiktok', view: 'sounds' })
    const { apiMock } = renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/sounds': { body: { ...VIEW_BODY, viewId: 'sounds', view: { ...VIEW_BODY.view, title: 'Saved sounds' } } },
      '/api/plugins/tiktok/data/scan*': { body: { items: [], nextCursor: null } },
    })
    await waitFor(() => expect(screen.getByText('Saved sounds')).toBeTruthy())
    expect(apiMock.calls.some((c) => c.path === '/api/plugins/tiktok/view/sounds')).toBe(true)
  })

  test('a plugin name needing escaping is encoded, never concatenated raw', async () => {
    setSearchParams({ name: 'my plugin', view: 'accounts' })
    const { apiMock } = renderWithApi(<PluginViewPage />, { '/api/plugins/my%20plugin/view/accounts': { body: { ...VIEW_BODY, plugin: 'my plugin' } }, '/api/plugins/*': { body: { items: [], nextCursor: null } } })
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/plugins/my%20plugin/view/accounts')).toBe(true))
  })

  test('the page renders the view’s own title and description in the PageHeader, plus the version', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, { '/api/plugins/tiktok/view/accounts': { body: VIEW_BODY }, '/api/plugins/tiktok/data/scan*': { body: SCAN_ROWS } })
    await waitFor(() => expect(screen.getByText('TikTok accounts')).toBeTruthy())
    expect(screen.getByText('Which accounts are signed in on each device.')).toBeTruthy()
    expect(screen.getByText(/tiktok 1\.2\.0/)).toBeTruthy()
    // And the table underneath it is really rendered, from the scan.
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
  })

  test('a dev-slot surface is flagged DEV', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { body: { ...VIEW_BODY, origin: 'dev', version: '1.2.0+dev.3' } },
      '/api/plugins/tiktok/data/scan*': { body: SCAN_ROWS },
    })
    await waitFor(() => expect(screen.getByText('DEV')).toBeTruthy())
  })

  test('loading: a busy skeleton before the view resolves', () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('no parameters at all: a named message rather than a crash or a blank page', () => {
    setSearchParams({})
    renderWithApi(<PluginViewPage />, {})
    expect(screen.getByText('The address is missing a plugin and a view')).toBeTruthy()
  })
})

describe('PluginViewPage — a plugin that is no longer active (criterion 9)', () => {
  test('a 404 plugin_not_found names the PLUGIN, and never shows an empty table', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { status: 404, body: { error: { code: 'plugin_not_found', message: 'no active plugin or dev slot named "tiktok"' } } },
    })
    await waitFor(() => expect(screen.getByText(/The plugin “tiktok” is no longer active/)).toBeTruthy())
    // The named error, not the table's own empty state.
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('Nothing stored yet')).toBeNull()
  })

  test('a 404 view_not_found is a DIFFERENT sentence — the plugin is fine, the screen is gone', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { status: 404, body: { error: { code: 'view_not_found', message: 'plugin "tiktok" declares no view "accounts"' } } },
    })
    await waitFor(() => expect(screen.getByText(/no longer declares a screen called “accounts”/)).toBeTruthy())
    expect(screen.queryByText(/is no longer active/)).toBeNull()
  })

  test('any other failure keeps the server’s own message, with a retry', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'view boom' } } },
    })
    await waitFor(() => expect(screen.getByText('view boom')).toBeTruthy())
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  test('the error state still names the plugin in the header, so the page never loses its identity', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { status: 404, body: { error: { code: 'plugin_not_found', message: 'gone' } } },
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'tiktok' })).toBeTruthy())
  })
})

/**
 * Plan 108 §3.2, §4.4, §5 step 108.10 — one page, two renderers. Which one
 * draws is decided by which half the view declares, and `ViewSpecSchema`
 * already guarantees it is exactly one of them, so the page reads the answer
 * rather than re-deriving it.
 */
const FRAME_BODY = {
  plugin: 'tiktok',
  version: '1.2.0',
  origin: 'plugin',
  viewId: 'studio',
  view: {
    title: 'Sound studio',
    description: 'A layout the table vocabulary cannot say.',
    frame: { entry: 'index.html', height: 'fill' },
    toolbar: ['sync'],
    rowActions: [],
  },
  actions: { sync: { kind: 'batch', label: 'Sync', script: 'tiktok/list@latest', target: 'picker' } },
}

describe('PluginViewPage — tier A and tier B share the page', () => {
  test('a `frame` view renders the sandboxed iframe, not the table renderer', async () => {
    setSearchParams({ name: 'tiktok', view: 'studio' })
    const { container } = renderWithApi(<PluginViewPage />, { '/api/plugins/tiktok/view/studio': { body: FRAME_BODY } })

    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy())
    const iframe = container.querySelector('iframe')
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.getAttribute('src')).toContain('/api/plugins/tiktok/ui/index.html')
    // The header is the page's, shared by both tiers.
    expect(screen.getByText('Sound studio')).toBeTruthy()
    // And the tier-A renderer's own "this screen is not a table" fallback is
    // never reached, because the page routed the view before it could be.
    expect(screen.queryByText('This screen is not a table')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  test('a `data` + `table` view still renders the table, and no iframe', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    const { container } = renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { body: VIEW_BODY },
      '/api/plugins/tiktok/data/scan*': { body: SCAN_ROWS },
    })

    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.getByRole('table')).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
  })

  test('a frame view makes no data request — a frame reads a declared source or nothing', async () => {
    setSearchParams({ name: 'tiktok', view: 'studio' })
    const { apiMock } = renderWithApi(<PluginViewPage />, { '/api/plugins/tiktok/view/studio': { body: FRAME_BODY } })

    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/plugins/tiktok/view/studio')).toBe(true))
    expect(apiMock.calls.some((c) => c.path.includes('/data'))).toBe(false)
  })
})
