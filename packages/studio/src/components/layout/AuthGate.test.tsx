import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { mockRouter, setPathname, setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `AuthGate` (plan 09 §4.14, the "Studio has no login page" gap) subscribes
 * to `ws.onAuthExpired`/calls `ws.setAuthMode`/`ws.disconnect` on mount and
 * on logout — no real `WebSocket` in `happy-dom`, so `@/lib/ws` is replaced,
 * the same way `app/page.test.tsx` replaces it for the fleet page. The
 * `onAuthExpired` mock captures its callback so a test can simulate a WS
 * ticket discovering an expired session.
 */
let authExpiredCb: (() => void) | null = null
const wsMocks = {
  on: mock(() => () => {}),
  onStatus: mock(() => () => {}),
  onReconnected: mock(() => () => {}),
  onAuthExpired: mock((cb: () => void) => {
    authExpiredCb = cb
    return () => {
      authExpiredCb = null
    }
  }),
  setAuthMode: mock(() => {}),
  disconnect: mock(() => {}),
  send: mock(() => {}),
}

mock.module('@/lib/ws', () => ({
  ws: wsMocks,
  coreBase: () => 'http://core.test',
  newId: () => 'test-id',
}))

const { AuthGate } = await import('./AuthGate')

afterEach(() => {
  cleanup()
  setPathname('/')
  setSearchParams()
  mockRouter.replace.mockClear()
  wsMocks.setAuthMode.mockClear()
  wsMocks.disconnect.mockClear()
  wsMocks.onAuthExpired.mockClear()
  authExpiredCb = null
})

describe('AuthGate — loading', () => {
  test('shows a spinner before GET /api/auth/me resolves, not the page underneath', () => {
    const { container } = renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      {},
      { unmatched: 'pending' },
    )
    expect(container.querySelector('[role="status"]')).toBeTruthy()
    expect(screen.queryByText('page content')).toBeNull()
  })
})

describe('AuthGate — local mode (bun run dev must stay login-free)', () => {
  test('an implicit local admin passes straight through to AppShell — no redirect, no login wall', async () => {
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      { '/api/auth/me': { body: { user: { id: 'local-admin', email: 'admin@localhost', role: 'admin' }, authMode: 'local' } } },
    )
    await waitFor(() => expect(screen.getByText('page content')).toBeTruthy())
    expect(screen.getByRole('link', { name: /devices/i })).toBeTruthy() // real AppShell chrome, not a bare page
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(wsMocks.setAuthMode).toHaveBeenCalledWith('local')
    // Local mode hides the user menu entirely — there is no session to sign out of.
    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull()
  })
})

describe('AuthGate — server mode, already authenticated', () => {
  test('renders the app and shows the signed-in user with a logout control', async () => {
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      { '/api/auth/me': { body: { user: { id: 'u1', email: 'admin@farm.test', role: 'admin' }, authMode: 'server' } } },
    )
    await waitFor(() => expect(screen.getByText('page content')).toBeTruthy())
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(wsMocks.setAuthMode).toHaveBeenCalledWith('server')
    expect(screen.getByText('admin@farm.test')).toBeTruthy()
    expect(screen.getByRole('button', { name: /log out/i })).toBeTruthy()
  })

  test('logging out calls the API, disconnects the WS, and lets the redirect effect send the tab to /login', async () => {
    let authenticated = true
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      {
        '/api/auth/me': () =>
          authenticated
            ? { body: { user: { id: 'u1', email: 'admin@farm.test', role: 'admin' }, authMode: 'server' } }
            : { status: 401, body: { error: { code: 'auth.required', message: 'login required' }, setupNeeded: false } },
        '/api/auth/logout': () => {
          authenticated = false
          return { body: { ok: true } }
        },
      },
    )
    const logoutButton = await waitFor(() => screen.getByRole('button', { name: /log out/i }))
    logoutButton.click()

    await waitFor(() => expect(wsMocks.disconnect).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining('/login')))
  })

  test('a WS ticket fetch discovering an expired session re-checks auth and redirects to /login (fails cleanly, not silently)', async () => {
    let authenticated = true
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      {
        '/api/auth/me': () =>
          authenticated
            ? { body: { user: { id: 'u1', email: 'a@b.com', role: 'operator' }, authMode: 'server' } }
            : { status: 401, body: { error: { code: 'auth.required', message: 'login required' }, setupNeeded: false } },
      },
    )
    await waitFor(() => expect(screen.getByText('page content')).toBeTruthy())
    expect(wsMocks.onAuthExpired).toHaveBeenCalledTimes(1)

    authenticated = false
    expect(authExpiredCb).not.toBeNull()
    authExpiredCb?.()

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining('/login')))
  })
})

describe('AuthGate — server mode, unauthenticated: routes to /login or /setup, never a broken dashboard', () => {
  test('a normal route redirects to /login, remembering where it was going as ?next=', async () => {
    setPathname('/device')
    setSearchParams('id=abc')
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      { '/api/auth/me': { status: 401, body: { error: { code: 'auth.required', message: 'login required' }, setupNeeded: false } } },
    )
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/device?id=abc')}`))
    // Never the raw, half-authenticated dashboard while the redirect settles.
    expect(screen.queryByText('page content')).toBeNull()
  })

  test('setupNeeded (no admin exists yet) redirects to /setup instead of /login', async () => {
    setPathname('/')
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      { '/api/auth/me': { status: 401, body: { error: { code: 'auth.required', message: 'login required' }, setupNeeded: true } } },
    )
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/setup'))
  })

  test('already sitting on /login: renders it standalone, with no AppShell chrome and no redirect', async () => {
    setPathname('/login')
    renderWithApi(
      <AuthGate>
        <div>the login form</div>
      </AuthGate>,
      { '/api/auth/me': { status: 401, body: { error: { code: 'auth.required', message: 'login required' }, setupNeeded: false } } },
    )
    await waitFor(() => expect(screen.getByText('the login form')).toBeTruthy())
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /devices/i })).toBeNull()
  })

  test('setupNeeded but sitting on /login: bounced to /setup', async () => {
    setPathname('/login')
    renderWithApi(
      <AuthGate>
        <div>the login form</div>
      </AuthGate>,
      { '/api/auth/me': { status: 401, body: { error: { code: 'auth.required', message: 'login required' }, setupNeeded: true } } },
    )
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/setup'))
  })
})

describe('AuthGate — "continue to where they were going" after success', () => {
  test('authenticated while still sitting on /login (right after a successful submit): redirects to ?next=', async () => {
    setPathname('/login')
    setSearchParams(`next=${encodeURIComponent('/device?id=abc')}`)
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      { '/api/auth/me': { body: { user: { id: 'u1', email: 'a@b.com', role: 'operator' }, authMode: 'server' } } },
    )
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/device?id=abc'))
  })

  test('an off-origin ?next= is never followed — falls back to /', async () => {
    setPathname('/login')
    setSearchParams(`next=${encodeURIComponent('//evil.example.com')}`)
    renderWithApi(
      <AuthGate>
        <div>page content</div>
      </AuthGate>,
      { '/api/auth/me': { body: { user: { id: 'u1', email: 'a@b.com', role: 'operator' }, authMode: 'server' } } },
    )
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'))
  })
})
