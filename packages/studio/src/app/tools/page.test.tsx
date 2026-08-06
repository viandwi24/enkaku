import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ToolsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const scrcpy = {
  id: 'scrcpy-server',
  displayName: 'scrcpy-server',
  swappable: true,
  managedByCore: false,
  activeVersion: '2.5',
  installed: [{ version: '2.5', active: true, sha256: null, installedAt: null }],
  available: [{ version: '2.5', knownGood: true, installable: true }],
  health: { ok: true, checkedAt: 0, detail: 'ok' },
}

describe('ToolsPage — smoke render', () => {
  test('loaded: shows the tool card', async () => {
    renderWithApi(<ToolsPage />, { '/api/tools': { body: { tools: [scrcpy] } } })
    await waitFor(() => expect(screen.getByText('scrcpy-server')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before tools load', () => {
    renderWithApi(<ToolsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/tools fetch shows a named error', async () => {
    renderWithApi(<ToolsPage />, {
      '/api/tools': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'tools boom' } } },
    })
    await waitFor(() => expect(screen.getByText('tools boom')).toBeTruthy())
  })
})
