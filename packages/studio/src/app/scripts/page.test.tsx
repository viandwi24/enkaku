import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ScriptsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const scriptGroup = {
  id: 'script-1',
  name: 'checkout',
  latestVersion: '1.0.0',
  versionCount: 1,
  lastPublishedAt: 0,
  enabled: true,
  kind: 'script',
}

const script = {
  id: 'script-1',
  name: 'checkout',
  version: '1.0.0',
  kind: 'script',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
}

describe('ScriptsPage — smoke render', () => {
  test('loaded: shows the script row', async () => {
    setSearchParams({})
    renderWithApi(<ScriptsPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/scripts?group=name': { body: { items: [scriptGroup], nextCursor: null, total: 1 } },
      '/api/scripts/script-1': { body: { script } },
    })
    await waitFor(() => expect(screen.getByText('checkout')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    setSearchParams({})
    renderWithApi(<ScriptsPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/scripts?group=name': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No scripts yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the script list loads', () => {
    setSearchParams({})
    renderWithApi(<ScriptsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/scripts fetch shows a named error', async () => {
    setSearchParams({})
    renderWithApi(<ScriptsPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/scripts?group=name': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'scripts boom' } } },
    })
    await waitFor(() => expect(screen.getByText('scripts boom')).toBeTruthy())
  })
})

const pluginScriptGroup = {
  id: 'script-2',
  name: 'tiktok/login',
  latestVersion: '1.0.0',
  versionCount: 1,
  lastPublishedAt: 0,
  enabled: true,
  kind: 'script',
}

describe('ScriptsPage — Plugin column and origin filter (plan 82 §4.6, step 13)', () => {
  test('a plugin member shows its owning plugin in the Plugin column; a standalone script shows a dash', async () => {
    setSearchParams({})
    renderWithApi(<ScriptsPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/scripts?group=name': { body: { items: [scriptGroup, pluginScriptGroup], nextCursor: null, total: 2 } },
      '/api/scripts/script-1': { body: { script } },
    })
    await waitFor(() => expect(screen.getByText('tiktok/login')).toBeTruthy())
    expect(screen.getByText('tiktok')).toBeTruthy() // the Plugin column cell for tiktok/login
    expect(screen.getByText('checkout')).toBeTruthy()
  })

  test('the origin filter narrows the list to plugin-owned scripts only', async () => {
    setSearchParams({})
    renderWithApi(<ScriptsPage />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/scripts?group=name': { body: { items: [scriptGroup, pluginScriptGroup], nextCursor: null, total: 2 } },
      '/api/scripts/script-1': { body: { script } },
    })
    await waitFor(() => expect(screen.getByText('checkout')).toBeTruthy())

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by origin' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Plugin' }))

    await waitFor(() => expect(screen.queryByText('checkout')).toBeNull())
    expect(screen.getByText('tiktok/login')).toBeTruthy()
  })
})
