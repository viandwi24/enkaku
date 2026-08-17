import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { PluginViewProps } from '@/lib/plugin-host'

/**
 * Plan 111 step 111.3 — the tier-C tests below need a host, and the real one
 * injects a `<script type="module">` and waits up to 15 s for a browser to
 * evaluate it. None of that happens under `happy-dom`, so the module is
 * replaced here (`plugin-host.test.ts` covers the real one against its own DOM
 * seam). Declared BEFORE `./page` is imported, because that is what makes the
 * replacement visible to `ReactView`'s own import of it.
 */
function PluginScreen({ plugin, viewId, params, setParams }: PluginViewProps) {
  return (
    <div>
      <p>plugin screen for {plugin}</p>
      <p>
        view={viewId} tab={params.tab ?? '(none)'} name={params.name ?? '(unclaimed)'}
      </p>
      <button type="button" onClick={() => setParams({ tab: 'logs' })}>
        Go to logs
      </button>
    </div>
  )
}

const loadView = mock(async () => ({ ok: true as const, component: PluginScreen }))

mock.module('@/lib/plugin-host', () => ({
  pluginHost: () => ({ loadView, globals: { hostApiVersion: 1, register: () => {}, hostModules: {} } }),
}))

const { default: PluginViewPage } = await import('./page')

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
 * Plan 111 §3.6, step 111.1 — plan 108 shipped a SECOND renderer on this page,
 * a sandboxed iframe (tier B), and this block used to assert that the page
 * routed to it. It was removed, not deprecated: once a plugin can ship real
 * React with full page access there is no reason to choose an iframe that
 * cannot even `fetch`, and 00-overview §4.3 forbids keeping the weaker path
 * around "for one release". What survives is the assertion that matters —
 * the declared table still draws, and this page renders no iframe at all.
 */
describe('PluginViewPage — the declared table renderer', () => {
  test('a `data` + `table` view renders the table, and no iframe', async () => {
    setSearchParams({ name: 'tiktok', view: 'accounts' })
    const { container } = renderWithApi(<PluginViewPage />, {
      '/api/plugins/tiktok/view/accounts': { body: VIEW_BODY },
      '/api/plugins/tiktok/data/scan*': { body: SCAN_ROWS },
    })

    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.getByRole('table')).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
  })
})

/**
 * Plan 111 §4.1, §5 step 111.3 — this page is the ONE place the renderer is
 * chosen, and `react` vs `table` is the whole choice. `validatePluginSurface`
 * already refuses a view declaring both or neither, so the branch is a
 * discriminator rather than a guess.
 */
const REACT_VIEW_BODY = {
  plugin: 'proxy-manager',
  version: '2.0.0',
  origin: 'plugin',
  viewId: 'catalogue',
  view: {
    title: 'Proxies',
    description: 'The catalogue, its assignments, and what happened.',
    react: { entry: 'index.js', apiVersion: 1 },
    toolbar: [],
    rowActions: [],
  },
  actions: {},
}

describe('PluginViewPage — the React renderer (tier C)', () => {
  test('a `react` view mounts the plugin’s component, and draws no table', async () => {
    setSearchParams({ name: 'proxy-manager', view: 'catalogue' })
    const { container } = renderWithApi(<PluginViewPage />, { '/api/plugins/proxy-manager/view/catalogue': { body: REACT_VIEW_BODY } })

    await waitFor(() => expect(screen.getByText('plugin screen for proxy-manager')).toBeTruthy())
    // The page's own chrome still belongs to Studio — a plugin owns its view
    // and nothing outside it (plan 111 §2).
    expect(screen.getByText('Proxies')).toBeTruthy()
    expect(container.querySelector('table')).toBeNull()
  })

  test('the view is loaded at the version the core resolved — a dev slot’s `buildVersion`, which moves every push', async () => {
    setSearchParams({ name: 'proxy-manager', view: 'catalogue' })
    loadView.mockClear()
    renderWithApi(<PluginViewPage />, {
      '/api/plugins/proxy-manager/view/catalogue': { body: { ...REACT_VIEW_BODY, origin: 'dev', version: '2.0.0+dev.4' } },
    })

    await waitFor(() => expect(loadView).toHaveBeenCalled())
    expect(loadView.mock.calls[0]?.[0]).toMatchObject({ pluginName: 'proxy-manager', version: '2.0.0+dev.4', viewId: 'catalogue', entry: 'index.js' })
  })
})

/**
 * Plan 111 §9 Q2 — Studio claims `name` and `view`; everything else in the
 * query is the plugin's, passed through uninterpreted, and writable back
 * without a navigation.
 */
describe('PluginViewPage — the query passthrough', () => {
  test('the unclaimed parameters reach the component, and the claimed two do not', async () => {
    setSearchParams({ name: 'proxy-manager', view: 'catalogue', tab: 'assignments' })
    renderWithApi(<PluginViewPage />, { '/api/plugins/proxy-manager/view/catalogue': { body: REACT_VIEW_BODY } })

    await waitFor(() => expect(screen.getByText(/tab=assignments/)).toBeTruthy())
    expect(screen.getByText(/name=\(unclaimed\)/)).toBeTruthy()
  })

  test('writing one back edits the URL in place — no router navigation, and the claimed keys survive', async () => {
    setSearchParams({ name: 'proxy-manager', view: 'catalogue' })
    mockRouter.push.mockClear()
    mockRouter.replace.mockClear()
    renderWithApi(<PluginViewPage />, { '/api/plugins/proxy-manager/view/catalogue': { body: REACT_VIEW_BODY } })

    await waitFor(() => expect(screen.getByText('Go to logs')).toBeTruthy())

    // Asserted on the call rather than on `window.location`: happy-dom serves
    // this document from `about:blank`, against which a relative URL does not
    // resolve, so the location never moves however correct the call is.
    const original = window.history.replaceState
    const written: string[] = []
    window.history.replaceState = ((_state: unknown, _title: string, url: string) => {
      written.push(url)
    }) as typeof window.history.replaceState
    try {
      fireEvent.click(screen.getByText('Go to logs'))
    } finally {
      window.history.replaceState = original
    }

    expect(written.length).toBe(1)
    const search = new URLSearchParams(written[0]?.split('?')[1] ?? '')
    expect(search.get('tab')).toBe('logs')
    expect(search.get('name')).toBe('proxy-manager')
    expect(search.get('view')).toBe('catalogue')
    // A navigation would risk remounting the plugin's subtree and losing its
    // state; `history.replaceState` is a pure URL edit Next feeds back into
    // `useSearchParams`.
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })
})
