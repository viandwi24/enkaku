import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import PluginDetailPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * A plugin carrying all three things this page exists to read back: its member
 * scripts, the screen it contributes, and the service an operator consented to
 * at install. `manifest.service` is real wire data — the core stores it in the
 * same JSON column as `scripts`/`surface` — even though `PluginManifestSchema`
 * in `@enkaku/protocol` still drops it (see `../plugin-list.ts`).
 */
const active = {
  id: 'p-1',
  name: 'proxy-manager',
  title: 'Proxy manager',
  description: 'Rotating proxies, one bridge port per record.',
  version: '0.3.1',
  status: 'active',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  verifyError: null,
  verifyErrorCode: null,
  createdBy: 'local-admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  scriptCount: 1,
  manifest: {
    scripts: [
      {
        id: 'check',
        title: 'Check a proxy',
        description: 'Dials the proxy and reports the egress it saw.',
        paramsSchema: { properties: { url: { type: 'string' } } },
      },
    ],
    surface: {
      nav: [{ id: 'proxies', label: 'Proxy manager', icon: 'network', view: 'proxies' }],
      views: {
        proxies: {
          title: 'Proxies',
          description: 'Every proxy this farm knows about.',
          table: { rowKey: 'id', columns: [{ field: 'id', header: 'Id' }] },
        },
      },
      actions: {},
    },
    service: {
      permissions: ['device.list', 'job.run'],
      isolation: 'in-process',
      listeners: [
        { id: 'proxy-bridge', proto: 'tcp', deviceReachable: false, description: 'One loopback TCP port per enabled proxy record.' },
      ],
      events: [],
      webhooks: [],
    },
  },
}

const older = {
  ...active,
  id: 'p-0',
  version: '0.3.0',
  status: 'superseded',
  scriptCount: 0,
}

const failed = {
  id: 'p-bad',
  name: 'broken-pack',
  title: 'Broken pack',
  description: null,
  version: '1.0.0',
  status: 'failed',
  verifiedAt: null,
  verifyError: 'E_PLUGIN_NAME_CONFLICT: "broken-pack/login" is already owned by plugin "shop" — "broken-pack" cannot also claim it',
  verifyErrorCode: 'E_PLUGIN_NAME_CONFLICT',
  createdBy: 'local-admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  scriptCount: 0,
  manifest: { scripts: [{ id: 'login', paramsSchema: {} }] },
}

/** The `<plugin>/<script>` → row id join the member links are built from. */
const scriptRows = {
  '/api/scripts?group=name': {
    body: {
      items: [
        {
          id: 'script-9',
          name: 'proxy-manager/check',
          latestVersion: '0.3.1',
          versionCount: 1,
          lastPublishedAt: 0,
          enabled: true,
          kind: 'script',
        },
      ],
      nextCursor: null,
      total: 1,
    },
  },
}

describe('PluginDetailPage — identity, members, screen and service', () => {
  test('a healthy plugin shows its identity, its member scripts with a way through, its screen and its declared service', async () => {
    setSearchParams({ name: 'proxy-manager' })
    renderWithApi(<PluginDetailPage />, {
      ...scriptRows,
      '/api/plugins?name=proxy-manager': { body: { items: [older, active], dev: [] } },
    })

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proxy manager', level: 1 })).toBeTruthy())

    // Identity — the identifier, which is also the KV namespace, not only the title.
    expect(screen.getByText('key/value namespace')).toBeTruthy()
    expect(screen.getByText('local-admin')).toBeTruthy()

    // Members, linked into the script detail page that already exists.
    const member = screen.getByRole('link', { name: 'proxy-manager/check' })
    expect(member.getAttribute('href')).toBe('/scripts/detail?id=script-9')
    expect(screen.getByText('Dials the proxy and reports the egress it saw.')).toBeTruthy()

    // The screen it contributes, linked at the address the sidebar uses.
    const view = screen.getByRole('link', { name: /Proxy manager$/ })
    expect(view.getAttribute('href')).toBe('/plugins/view?name=proxy-manager&view=proxies')

    // The service — declared, and never worded as "running".
    expect(screen.getByText('device.list')).toBeTruthy()
    expect(screen.getByText('job.run')).toBeTruthy()
    expect(screen.getByText('proxy-bridge')).toBeTruthy()
    expect(screen.getByText('host-only')).toBeTruthy()
    expect(document.body.textContent).toContain('no route yet that reports whether the service is actually running')
  })

  test('the version picker defaults to the active version, not the newest row order', async () => {
    setSearchParams({ name: 'proxy-manager' })
    renderWithApi(<PluginDetailPage />, {
      ...scriptRows,
      '/api/plugins?name=proxy-manager': { body: { items: [older, active], dev: [] } },
    })
    await waitFor(() => expect(screen.getByLabelText('Version of proxy-manager')).toBeTruthy())
    expect(screen.getByLabelText('Version of proxy-manager').textContent).toContain('0.3.1')
  })

  test('?version= pins the page to that version and its own actions', async () => {
    setSearchParams({ name: 'proxy-manager', version: '0.3.0' })
    renderWithApi(<PluginDetailPage />, {
      ...scriptRows,
      '/api/plugins?name=proxy-manager': { body: { items: [older, active], dev: [] } },
    })
    await waitFor(() => expect(screen.getByLabelText('Version of proxy-manager').textContent).toContain('0.3.0'))
    // A superseded version offers the way back, never Disable.
    expect(screen.getByRole('button', { name: 'Rollback to this' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    // Its screen is not reachable — only the ACTIVE version's is.
    expect(screen.queryByRole('link', { name: /Proxy manager$/ })).toBeNull()
    expect(document.body.textContent).toContain('Not reachable while this version is superseded')
  })
})

describe('PluginDetailPage — a failed plugin', () => {
  test('the verify error renders VERBATIM with its code, first on the page', async () => {
    setSearchParams({ name: 'broken-pack' })
    const { container } = renderWithApi(<PluginDetailPage />, {
      ...scriptRows,
      '/api/plugins?name=broken-pack': { body: { items: [failed], dev: [] } },
    })
    const code = await waitFor(() => screen.getByText('E_PLUGIN_NAME_CONFLICT'))
    expect(screen.getByText(failed.verifyError)).toBeTruthy()
    // Ahead of Identity — the error is what the page is opened for when a
    // plugin is broken.
    const order = [...container.querySelectorAll('*')]
    expect(order.indexOf(code)).toBeLessThan(order.indexOf(screen.getByRole('heading', { name: 'Identity' })))
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  test('a declared member that never registered has no link, and says why', async () => {
    setSearchParams({ name: 'broken-pack' })
    renderWithApi(<PluginDetailPage />, {
      ...scriptRows,
      '/api/plugins?name=broken-pack': { body: { items: [failed], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('broken-pack/login')).toBeTruthy())
    expect(screen.queryByRole('link', { name: 'broken-pack/login' })).toBeNull()
    expect(document.body.textContent).toContain('only the live version of a plugin registers its members')
  })
})

describe('PluginDetailPage — the states every fetching screen must handle', () => {
  test('no ?name= is named, not left blank', () => {
    setSearchParams({})
    renderWithApi(<PluginDetailPage />, {})
    expect(screen.getByText('The address is missing a plugin name')).toBeTruthy()
  })

  test('loading shows a busy skeleton', () => {
    setSearchParams({ name: 'proxy-manager' })
    renderWithApi(<PluginDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('a failed fetch shows the server error with a retry', async () => {
    setSearchParams({ name: 'proxy-manager' })
    renderWithApi(<PluginDetailPage />, {
      '/api/plugins?name=proxy-manager': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'plugins boom' } } },
    })
    await waitFor(() => expect(screen.getByText('plugins boom')).toBeTruthy())
  })

  test('a name with no rows is a named empty state, not an error', async () => {
    setSearchParams({ name: 'ghost' })
    renderWithApi(<PluginDetailPage />, {
      ...scriptRows,
      '/api/plugins?name=ghost': { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('No plugin named “ghost” on this farm')).toBeTruthy())
  })
})
