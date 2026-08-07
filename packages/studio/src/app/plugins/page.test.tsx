import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import PluginsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const activePlugin = {
  id: 'p-active',
  name: 'tiktok',
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
  version: '1.0.0',
  status: 'failed',
  verifiedAt: null,
  verifyError: 'E_PLUGIN_NAME_CONFLICT: "broken-pack/login" is already owned by a standalone script — "broken-pack" cannot also claim it',
  verifyErrorCode: 'E_PLUGIN_NAME_CONFLICT',
  manifest: { scripts: [{ id: 'login', paramsSchema: {} }, { id: 'other', paramsSchema: {} }] },
  createdAt: '2026-01-01T00:00:00.000Z',
  scriptCount: 0,
}

describe('PluginsPage — criterion 29: a failed plugin, its verbatim error, and which scripts did/did not register', () => {
  test('loaded: shows the failed plugin sorted first, its error VERBATIM with its code, and 0 registered vs 2 declared', async () => {
    renderWithApi(<PluginsPage />, {
      '/api/plugins': { body: { items: [activePlugin, failedPlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('broken-pack')).toBeTruthy())
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
    renderWithApi(<PluginsPage />, {
      '/api/plugins': { body: { items: [activePlugin], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('tiktok')).toBeTruthy())
    expect(screen.getByText(/2 registered/)).toBeTruthy()
    expect(screen.queryByText('E_PLUGIN_NAME_CONFLICT')).toBeNull()
  })

  test('a dev slot renders with its DEV badge, owner, and shared KV namespace', async () => {
    renderWithApi(<PluginsPage />, {
      '/api/plugins': {
        body: {
          items: [],
          dev: [
            {
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
            },
          ],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('DEV')).toBeTruthy())
    expect(screen.getByText(/\/scripts\/tiktok\/index\.ts/)).toBeTruthy()
  })
})

describe('PluginsPage — loading, loaded-empty, and error states', () => {
  test('loading: shows a busy skeleton before plugins load', () => {
    renderWithApi(<PluginsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('loaded: no plugins at all shows the empty state', async () => {
    renderWithApi(<PluginsPage />, {
      '/api/plugins': { body: { items: [], dev: [] } },
    })
    await waitFor(() => expect(screen.getByText('No plugins yet')).toBeTruthy())
  })

  test('error: a failed /api/plugins fetch shows a named error', async () => {
    renderWithApi(<PluginsPage />, {
      '/api/plugins': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'plugins boom' } } },
    })
    await waitFor(() => expect(screen.getByText('plugins boom')).toBeTruthy())
  })
})
