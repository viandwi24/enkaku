import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { AuthContext, type AuthState } from '@/lib/auth'
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

/**
 * Same shape as `scrcpy` above, plus a not-installed version (Install
 * button) and an installed-but-inactive one (Activate + Delete buttons) —
 * `tool.manage` (`packages/core/src/auth/acl.ts`, admin-only) is meant to
 * gate all three below, so the fixture needs all three on screen at once.
 */
const scrcpyWithActions = {
  ...scrcpy,
  installed: [
    { version: '2.3', active: false, sha256: null, installedAt: null },
    { version: '2.5', active: true, sha256: null, installedAt: null },
  ],
  available: [
    { version: '2.3', knownGood: true, installable: true },
    { version: '2.5', knownGood: true, installable: true },
    { version: '2.6', knownGood: true, installable: true },
  ],
}

/** A core-managed, version-pinned tool with no active version — the "Reinstall missing" repair banner's own gate. */
const missingPinnedTool = {
  id: 'ui-server',
  displayName: 'ui-server',
  swappable: false,
  managedByCore: true,
  activeVersion: null,
  installed: [],
  available: [],
  health: null,
}

function authValue(overrides: Partial<AuthState>): AuthState {
  return { user: null, authMode: 'server', setupNeeded: false, refresh: async () => {}, logout: async () => {}, ...overrides }
}

function renderAs(value: AuthState, tools: unknown[]) {
  return renderWithApi(
    <AuthContext.Provider value={value}>
      <ToolsPage />
    </AuthContext.Provider>,
    { '/api/tools': { body: { tools } } },
  )
}

/**
 * `tool.manage` — install/activate/delete/refresh-manifest/check/repair —
 * is admin-only (`packages/core/src/auth/acl.ts`); `tool.view` (the list
 * itself, read here through `/api/tools`) is not. An operator keeps every
 * one of those buttons ON SCREEN, disabled with a reason, rather than
 * losing them entirely — see `ADMIN_ONLY` and its call sites in `page.tsx`.
 */
describe('ToolsPage — role gating (tool.manage, admin-only)', () => {
  test('operator: every tool.manage control is disabled, with a reason', async () => {
    renderAs(authValue({ user: { id: 'u1', email: 'op@x.com', role: 'operator' } }), [scrcpyWithActions, missingPinnedTool])
    await waitFor(() => expect(screen.getByText('scrcpy-server')).toBeTruthy())

    for (const name of [/refresh manifest/i, /^check$/i, /^install$/i, /^activate$/i, /^delete$/i, /reinstall missing/i]) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title.length).toBeGreaterThan(0)
    }
    // `tool.view` (the list, and diagnostics) is NOT admin-only — an operator keeps it.
    expect((screen.getByRole('button', { name: /run diagnostics/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('admin: every control is enabled', async () => {
    renderAs(authValue({ user: { id: 'u1', email: 'admin@x.com', role: 'admin' } }), [scrcpyWithActions, missingPinnedTool])
    await waitFor(() => expect(screen.getByText('scrcpy-server')).toBeTruthy())

    for (const name of [/refresh manifest/i, /^check$/i, /^install$/i, /^activate$/i, /^delete$/i, /reinstall missing/i]) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      expect(button.title).toBe('')
    }
  })

  test('local mode (implicit admin): unaffected — every control stays enabled exactly as before this gate existed', async () => {
    renderAs(authValue({ authMode: 'local', user: { id: 'local-admin', email: 'admin@localhost', role: 'admin' } }), [
      scrcpyWithActions,
      missingPinnedTool,
    ])
    await waitFor(() => expect(screen.getByText('scrcpy-server')).toBeTruthy())

    for (const name of [/refresh manifest/i, /^check$/i, /^install$/i, /^activate$/i, /^delete$/i, /reinstall missing/i]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
  })
})

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
