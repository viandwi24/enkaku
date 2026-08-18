import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import PluginsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const activePlugin = {
  id: 'p-active',
  name: 'tiktok',
  title: 'TikTok pack',
  version: '1.0.0',
  status: 'active',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  verifyError: null,
  verifyErrorCode: null,
  manifest: { scripts: [{ id: 'login', paramsSchema: {} }, { id: 'warmup', paramsSchema: {} }] },
  createdAt: '2026-01-01T00:00:00.000Z',
  scriptCount: 2,
}

const failedPlugin = {
  id: 'p-failed',
  name: 'broken-pack',
  title: 'Broken pack',
  version: '1.0.0',
  status: 'failed',
  verifiedAt: null,
  verifyError: 'E_PLUGIN_NAME_CONFLICT: "broken-pack/login" is already owned by plugin "shop" — "broken-pack" cannot also claim it',
  verifyErrorCode: 'E_PLUGIN_NAME_CONFLICT',
  manifest: { scripts: [{ id: 'login', paramsSchema: {} }, { id: 'other', paramsSchema: {} }] },
  createdAt: '2026-01-01T00:00:00.000Z',
  scriptCount: 0,
}

const disabledPlugin = {
  id: 'p-disabled',
  name: 'legacy-pack',
  title: 'Legacy pack',
  version: '1.0.0',
  status: 'disabled',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  verifyError: null,
  verifyErrorCode: null,
  manifest: { scripts: [{ id: 'login', paramsSchema: {} }] },
  createdAt: '2026-01-01T00:00:00.000Z',
  scriptCount: 0,
}

const devSlot = {
  pluginName: 'tiktok',
  declaredVersion: '1.0.0',
  buildVersion: '1.0.0+dev.1',
  buildN: 1,
  bundlePath: '/tmp/x.mjs',
  scripts: [{ exportId: 'login', paramsSchema: {} }],
  owner: { kind: 'workspace', label: '/scripts/tiktok/index.ts' },
  createdAt: 0,
  lastBuildAt: 0,
  lastBuildOk: true,
  lastError: null,
  expiresAt: 0,
  kvNamespace: 'tiktok',
}

/**
 * The Scripts section's own two reads. Every test in this file supplies them
 * — the two halves of this screen load INDEPENDENTLY (that is the point of
 * the merge's own design; see `page.tsx`), so a plugin test that left them
 * unmocked would be asserting against a script list stuck in its error state
 * and would not notice if that ever became the plugin list's problem too.
 */
const noScripts = {
  '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/scripts?group=name': { body: { items: [], nextCursor: null, total: 0 } },
}

/**
 * Every row in this list is a plugin member — a script is published as a
 * member of a plugin and nothing else (plan 110 §3.2), so there is no second
 * shape of row to fixture here and no origin to filter on.
 */
const memberScript = {
  id: 'script-1',
  name: 'demo/checkout',
  latestVersion: '1.0.0',
  versionCount: 1,
  lastPublishedAt: 0,
  enabled: true,
  kind: 'script',
}

const pluginScript = {
  id: 'script-2',
  name: 'shop/login',
  latestVersion: '1.0.0',
  versionCount: 2,
  lastPublishedAt: 0,
  enabled: true,
  kind: 'script',
}

const scriptDetail = {
  id: 'script-1',
  name: 'demo/checkout',
  version: '1.0.0',
  kind: 'script',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
}

const withScripts = (items: unknown[]) => ({
  '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/scripts?group=name': { body: { items, nextCursor: null, total: items.length } },
  '/api/scripts/script-1': { body: { script: scriptDetail } },
})

describe('PluginsPage — criterion 29: a failed plugin, its verbatim error, and which scripts did/did not register', () => {
  test('loaded: shows the failed plugin sorted first, its error VERBATIM with its code, and 0 registered vs 2 declared', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin, failedPlugin], dev: [] } },
    })
    // Both names are shown and they are different things: the human title, and
  // the identifier a script reference is keyed on. Asserting on the readout
  // rather than the title, since the identifier is the one that must be exact.
  await waitFor(() => expect(screen.getByText('Broken pack')).toBeTruthy())
    expect(screen.getByText('E_PLUGIN_NAME_CONFLICT')).toBeTruthy()
    expect(screen.getByText(new RegExp(failedPlugin.verifyError!.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy()
    expect(screen.getByText(/2 script.*declared.*login, other/)).toBeTruthy()
    expect(screen.getByText(/0 registered/)).toBeTruthy()
    // A farm-health summary line names the count.
    expect(screen.getByText(/1 plugin.*failed to register/)).toBeTruthy()

    // The failed plugin's row appears before the active one in document order (§4.6: "failed plugins sort first").
    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '')
    const failedIdx = rows.findIndex((t) => t.includes('broken-pack'))
    const activeIdx = rows.findIndex((t) => t.includes('tiktok'))
    expect(failedIdx).toBeGreaterThan(-1)
    expect(activeIdx).toBeGreaterThan(-1)
    expect(failedIdx).toBeLessThan(activeIdx)
  })

  test('an active plugin shows its registered count with no error box', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())
    expect(screen.getByText(/2 registered/)).toBeTruthy()
    expect(screen.queryByText('E_PLUGIN_NAME_CONFLICT')).toBeNull()
  })

  test('a dev slot renders with its DEV badge, owner, and shared KV namespace', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [], dev: [devSlot] } },
    })
    await waitFor(() => expect(screen.getByText('DEV')).toBeTruthy())
    expect(screen.getByText(/\/scripts\/tiktok\/index\.ts/)).toBeTruthy()
  })
})

describe('PluginsPage — loading, loaded-empty, and error states', () => {
  test('loading: shows a busy skeleton before plugins load', () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('loaded: no plugins at all shows the empty state', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('No plugins yet')).toBeTruthy())
  })

  test('error: a failed /api/plugins fetch shows a named error', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'plugins boom' } } },
    })
    await waitFor(() => expect(screen.getByText('plugins boom')).toBeTruthy())
  })
})

/**
 * Plan 108 §0.2 / §5 step 108.9 — the four server capabilities that had no
 * way in from Studio. Each test below is one of them, asserting the ROUTE
 * that gets called and not only that a control renders: a button wired to
 * the wrong path is exactly the class of gap this step exists to close.
 */
describe('PluginsPage — P1: installing a plugin from Studio', () => {
  test('the Install dialog posts the bundle and renders a verify failure verbatim', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': (req) =>
        req.method === 'POST'
          ? {
              status: 201,
              body: {
                plugin: { ...failedPlugin, id: 'p-new', name: 'broken-pack', version: '2.0.0', manifest: null },
                verify: {
                  ok: false,
                  scripts: [],
                  resetPackages: [],
                  error: 'E_PLUGIN_BAD_EXPORT: the bundle has no default export',
                  errorCode: 'E_PLUGIN_BAD_EXPORT',
                },
              },
            }
          : { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('No plugins yet')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Install plugin/ }))
    await waitFor(() => expect(screen.getByText('Install a plugin')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'broken-pack' } })
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.0.0' } })
    fireEvent.change(screen.getByLabelText('Bundle text'), { target: { value: 'export default {}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish and verify' }))

    // Verbatim, with its code — the same rule the table itself follows.
    await waitFor(() => expect(screen.getByText('E_PLUGIN_BAD_EXPORT')).toBeTruthy())
    expect(screen.getByText('E_PLUGIN_BAD_EXPORT: the bundle has no default export')).toBeTruthy()

    const post = apiMock.calls.find((c) => c.method === 'POST' && c.path === '/api/plugins')
    expect(post?.body).toEqual({ name: 'broken-pack', version: '2.0.0', bundle: 'export default {}' })
  })

  test('§3.10 consent: a verified bundle names its title, description and declared scripts before Activate is posted', async () => {
    setSearchParams({})
    const staged = {
      id: 'p-new',
      name: 'tiktok',
      title: 'TikTok pack',
      description: 'Automates the TikTok app.',
      version: '2.0.0',
      status: 'staged',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      verifyError: null,
      verifyErrorCode: null,
      manifest: { scripts: [{ id: 'login', paramsSchema: {} }] },
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': (req) =>
        req.method === 'POST'
          ? {
              status: 201,
              body: {
                plugin: staged,
                verify: {
                  ok: true,
                  scripts: [
                    { id: 'login', paramsSchema: {} },
                    { id: 'warmup', paramsSchema: {} },
                  ],
                  resetPackages: [],
                },
              },
            }
          : { body: { items: [], dev: [] } },
      '/api/plugins/*': { body: { plugin: { ...staged, status: 'active' } } },
    })
    await waitFor(() => expect(screen.getByText('No plugins yet')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Install plugin/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'tiktok' } })
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.0.0' } })
    fireEvent.change(screen.getByLabelText('Bundle text'), { target: { value: 'export default {}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish and verify' }))

    await waitFor(() => expect(screen.getByText('Activate TikTok pack?')).toBeTruthy())
    expect(screen.getByText('Automates the TikTok app.')).toBeTruthy()
    expect(screen.getByText('tiktok/login')).toBeTruthy()
    expect(screen.getByText('tiktok/warmup')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/plugins/p-new/activate')).toBe(true))
  })
})

describe('PluginsPage — P2/P3/P4: disable, drop a dev slot, and remove with its stored data', () => {
  test('P2: an active plugin offers Disable, names what stops resolving, and posts to the disable route', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
      '/api/plugins/*': { body: { ok: true } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(screen.getByText('Disable tiktok@1.0.0?')).toBeTruthy())
    // The copy that said "There is no Enable button" was accurate until
    // `POST /:name/enable` shipped; it must be gone, not merely contradicted
    // by a button sitting next to it.
    expect(document.body.textContent).not.toContain('There is no Enable button')
    expect(document.body.textContent).toContain('Enable, on this same row, puts this exact version back')

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/plugins/tiktok/disable')).toBe(true))
  })

  test('P3: a dev slot offers Drop, names its owner, and deletes the slot', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [], dev: [devSlot] } },
      '/api/plugins/*': { body: { ok: true } },
    })
    await waitFor(() => expect(screen.getByText('DEV')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Drop' }))
    await waitFor(() => expect(screen.getByText('Drop the dev slot for tiktok?')).toBeTruthy())
    expect(within(screen.getByRole('alertdialog')).getByText('/scripts/tiktok/index.ts')).toBeTruthy()

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Drop' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'DELETE' && c.path === '/api/plugins/dev/tiktok')).toBe(true))
  })

  test('P4: Remove states the real entry count and passes deleteKv=1 once the box is ticked', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
      '/api/plugins/tiktok/data/count': { body: { global: 3, device: 7 } },
      '/api/plugins/*': { body: { removed: true, kvDeleted: 10 } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(document.body.textContent).toContain('3 global, 7 device entries'))

    fireEvent.click(screen.getByLabelText('Also delete data stored by tiktok'))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove and delete data' }))
    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'DELETE' && c.path === '/api/plugins/tiktok/1.0.0?deleteKv=1')).toBe(true),
    )
  })

  test('P4: the box is off by default (deleteKv=0), and still offered when the count route is not there', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
      // An older core has no `/data/count` (step 108.4) — the option degrades
      // to a checkbox with no number rather than disappearing.
      '/api/plugins/*': (req) =>
        req.path.endsWith('/data/count')
          ? { status: 404, body: { error: { code: 'E_NOT_FOUND', message: 'no such route' } } }
          : { body: { removed: true, kvDeleted: 0 } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(document.body.textContent).toContain('could not report how many entries'))
    expect(screen.getByLabelText('Also delete data stored by tiktok')).toBeTruthy()

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'DELETE' && c.path === '/api/plugins/tiktok/1.0.0?deleteKv=0')).toBe(true),
    )
  })
})

/**
 * `POST /api/plugins/:name/enable` — the way back from Disable. Before it
 * existed a `disabled` version was reachable by no transition at all, and
 * this screen said so; both halves of that (the missing button and the
 * sentence explaining its absence) are settled here.
 */
describe('PluginsPage — Enable, the way back from Disable', () => {
  test('a disabled plugin offers Enable and posts to /api/plugins/:name/enable', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [disabledPlugin], dev: [] } },
      '/api/plugins/*': { body: { plugin: { ...disabledPlugin, status: 'active' } } },
    })
    await waitFor(() => expect(screen.getByText('Legacy pack')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/plugins/legacy-pack/enable')).toBe(true),
    )
  })

  test('an active plugin offers Disable, never Enable — the pair is never both at once', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  })

  test('a 409 (another version already holds the slot) leaves the row disabled rather than optimistically flipping it', async () => {
    setSearchParams({})
    const { apiMock } = renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [disabledPlugin], dev: [] } },
      '/api/plugins/*': {
        status: 409,
        body: { error: { code: 'plugin_enable_conflict', message: 'legacy-pack@2.0.0 is already active' } },
      },
    })
    await waitFor(() => expect(screen.getByText('Legacy pack')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/plugins/legacy-pack/enable')).toBe(true),
    )
    // The server's own wording goes to `useAction`'s failure toast; what
    // matters here is that the row did NOT move — nothing is enabled until
    // the server says it is.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy())
    expect(screen.getByText('disabled')).toBeTruthy()
  })
})

/**
 * The Scripts list, absorbed from `/scripts` (owner's own ask, 2026-08-17:
 * *"halaman scripts menurut saya jadi satu aja dengan plugins"*). It is the
 * members of the plugins above it and nothing else — no origin filter, no
 * Plugin column — with the same link into `/scripts/detail?id=…`.
 */
describe('PluginsPage — the Scripts section', () => {
  test('both sections render on the one screen, each with its own list', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript, pluginScript]),
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('demo/checkout')).toBeTruthy())

    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Scripts' })).toBeTruthy()
    expect(screen.getByText('shop/login')).toBeTruthy()
  })

  test('a script row links into the detail page, which did not move', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript]),
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: 'demo/checkout' }))
    expect(link.getAttribute('href')).toBe('/scripts/detail?id=script-1')
  })

  test('there is no origin filter and no Plugin column — the list is the plugins\' own members, whole', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript, pluginScript]),
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('demo/checkout')).toBeTruthy())

    expect(screen.queryByRole('combobox', { name: 'Filter by origin' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Plugin' })).toBeNull()
    expect(document.body.textContent).not.toContain('Standalone')
    // Nothing was narrowed away: every member of every plugin is on screen.
    expect(screen.getByText('shop/login')).toBeTruthy()
  })

  test('the failed-plugin warning stays above both sections — a long script list cannot push it down', async () => {
    setSearchParams({})
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...memberScript,
      id: `script-${i + 1}`,
      name: `demo/script-${i + 1}`,
    }))
    const { container } = renderWithApi(<PluginsPage />, {
      ...withScripts(many),
      '/api/plugins': { body: { items: [failedPlugin], dev: [] } },
    })
    const warning = await waitFor(() => screen.getByText(/1 plugin.*failed to register/))
    const scriptsHeading = screen.getByRole('heading', { name: 'Scripts' })

    const order = [...container.querySelectorAll('*')]
    expect(order.indexOf(warning)).toBeLessThan(order.indexOf(scriptsHeading))
    // And it is the first thing in the body, ahead of the Plugins heading too.
    expect(order.indexOf(warning)).toBeLessThan(order.indexOf(screen.getByRole('heading', { name: 'Plugins' })))
  })
})

/**
 * The two data sources are independent by construction (`page.tsx`'s own
 * comment) — one screen must never mean one failure blanks both lists.
 */
describe('PluginsPage — the two sections load, empty and fail independently', () => {
  test('a failed /api/plugins leaves the script list rendered', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript]),
      '/api/plugins': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'plugins boom' } } },
    })
    await waitFor(() => expect(screen.getByText('plugins boom')).toBeTruthy())
    expect(await screen.findByText('demo/checkout')).toBeTruthy()
  })

  test('a failed /api/scripts leaves the plugin table rendered', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/scripts?group=name': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'scripts boom' } } },
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('scripts boom')).toBeTruthy())
    expect(screen.getByText('TikTok pack')).toBeTruthy()
  })

  test('an empty script list shows the Scripts empty state while the plugin table stays', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('No scripts yet')).toBeTruthy())
    expect(screen.getByText('TikTok pack')).toBeTruthy()
  })

  test('an empty plugin list shows the Plugins empty state while the script list stays', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript]),
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('No plugins yet')).toBeTruthy())
    expect(await screen.findByText('demo/checkout')).toBeTruthy()
  })

  test('loading: both sections show a busy skeleton before either resolves', () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * The tabs (owner's own ask, 2026-08-18: *"di halaman plugins dan scripts
 * keknya dibuatkan tab aja jadi tab Plugins dan Script"*). Both panels stay
 * MOUNTED — the tab only chooses which is displayed — which is what keeps the
 * two loads independent and keeps a failure behind a closed tab from being a
 * silent one; the assertions in the two describes above are the ones that
 * would break the moment a tab started unmounting its panel.
 */
describe('PluginsPage — tabs', () => {
  test('both tabs are links carrying ?tab=, and Plugins is the default', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())

    const plugins = screen.getByRole('link', { name: /^Plugins/ })
    const scripts = screen.getByRole('link', { name: /^Scripts/ })
    expect(plugins.getAttribute('href')).toBe('/plugins?tab=plugins')
    expect(scripts.getAttribute('href')).toBe('/plugins?tab=scripts')
    expect(plugins.getAttribute('aria-current')).toBe('page')
    expect(scripts.getAttribute('aria-current')).toBeNull()
  })

  test('?tab=scripts makes Scripts the current tab', async () => {
    setSearchParams({ tab: 'scripts' })
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript]),
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('demo/checkout')).toBeTruthy())
    expect(screen.getByRole('link', { name: /^Scripts/ }).getAttribute('aria-current')).toBe('page')
  })

  /**
   * `?device=`/`?cluster=` mean "run a script on this thing" — a device card's
   * Run button and `/scripts`'s own redirect both arrive carrying one. Landing
   * on the Plugins tab would put the operator one click from where they asked
   * to be.
   */
  test('arriving with ?device= selects the Scripts tab and keeps the parameter', async () => {
    setSearchParams({ device: 'dev-1' })
    const { container } = renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript]),
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    // `?device=` also auto-opens the run dialog (that is the whole point of the
    // parameter), and a modal marks the rest of the page `aria-hidden` — so the
    // tab strip is read off the DOM here rather than through a role query.
    const tab = (key: string) => container.querySelector(`a[href*="tab=${key}"]`)
    await waitFor(() => expect(tab('scripts')).toBeTruthy())
    expect(tab('scripts')?.getAttribute('aria-current')).toBe('page')
    expect(tab('plugins')?.getAttribute('href')).toContain('device=dev-1')
  })

  test('the failed-plugin warning is above the tab strip, so it is on screen from the Scripts tab too', async () => {
    setSearchParams({ tab: 'scripts' })
    const { container } = renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript]),
      '/api/plugins': { body: { items: [failedPlugin], dev: [] } },
    })
    const warning = await waitFor(() => screen.getByText(/1 plugin.*failed to register/))
    const order = [...container.querySelectorAll('*')]
    expect(order.indexOf(warning)).toBeLessThan(order.indexOf(screen.getByRole('link', { name: /^Plugins/ })))
    // And the Plugins tab itself carries the marker, so the count is not only
    // in a banner someone might dismiss visually.
    expect(screen.getByLabelText('1 failed to register')).toBeTruthy()
  })
})

describe('PluginsPage — search', () => {
  test('the box says what it covers, and ?q= arrives applied', async () => {
    setSearchParams({ q: 'tiktok' })
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin, disabledPlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())
    expect((screen.getByLabelText('Search plugins') as HTMLInputElement).value).toBe('tiktok')
    expect(screen.queryByText('Legacy pack')).toBeNull()
    expect(document.body.textContent).toContain('the scripts it registers')
  })

  /**
   * The case worth having: "which plugin does `warmup` come from". The member
   * list is `manifest.scripts`, already on the row, so it costs no fetch — and
   * the row says WHY it is on screen, because otherwise a search for `warmup`
   * returning a row labelled `tiktok` reads as a broken filter.
   */
  test('a plugin is findable by the name of a script it registers, and the row says so', async () => {
    setSearchParams({ q: 'warmup' })
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin, disabledPlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())
    expect(screen.getByText('tiktok/warmup')).toBeTruthy()
    expect(screen.queryByText('Legacy pack')).toBeNull()
  })

  test('a search with no hits is a DIFFERENT state from having no plugins at all', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'nothing-like-this' } })
    await waitFor(() => expect(screen.getByText('No plugin matches “nothing-like-this”')).toBeTruthy())
    expect(screen.queryByText('No plugins yet')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show all plugins' }))
    await waitFor(() => expect(screen.getByText('TikTok pack')).toBeTruthy())
  })

  test('the Scripts tab searches the full plugin/script name and reports no match distinctly', async () => {
    setSearchParams({ tab: 'scripts' })
    renderWithApi(<PluginsPage />, {
      ...withScripts([memberScript, pluginScript]),
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('demo/checkout')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search scripts'), { target: { value: 'shop/' } })
    await waitFor(() => expect(screen.queryByText('demo/checkout')).toBeNull())
    expect(screen.getByText('shop/login')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search scripts'), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('No script matches “zzz”')).toBeTruthy())
    expect(screen.queryByText('No scripts yet')).toBeNull()
  })

  test('a failed plugin hidden by the search is named in the warning, with a way to clear it', async () => {
    setSearchParams({ q: 'tiktok' })
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin, failedPlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText(/1 plugin.*failed to register/)).toBeTruthy())
    const clear = screen.getByRole('button', { name: /hidden by the current search/ })
    fireEvent.click(clear)
    await waitFor(() => expect(screen.getByText('Broken pack')).toBeTruthy())
  })
})

describe('PluginsPage — the row links into the plugin detail page', () => {
  test('the plugin name is a link to /plugins/detail?name=…', async () => {
    setSearchParams({})
    renderWithApi(<PluginsPage />, {
      ...noScripts,
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    const link = await waitFor(() => screen.getByRole('link', { name: 'TikTok pack' }))
    expect(link.getAttribute('href')).toBe('/plugins/detail?name=tiktok')
  })
})
