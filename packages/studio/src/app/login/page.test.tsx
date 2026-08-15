import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { AuthContext, type AuthState } from '@/lib/auth'
import { cleanup, renderWithApi } from '@/lib/test/render'
import LoginPage from './page'

// `coreBase()` falls back to `location.origin`, which happy-dom reports as
// the literal string "null" for a document with no real URL — pin it the
// same way every other Studio test does.
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function renderLogin(refresh: () => Promise<void>, responses: Parameters<typeof renderWithApi>[1] = {}) {
  const value: AuthState = { user: null, authMode: 'server', setupNeeded: false, refresh, logout: async () => {} }
  return renderWithApi(
    <AuthContext.Provider value={value}>
      <LoginPage />
    </AuthContext.Provider>,
    responses,
  )
}

function fillAndSubmit(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

/**
 * Requirement 2 of the "Studio has no login page" gap: email + password →
 * session cookie, with the backend's actual failure codes (wrong
 * credentials, rate-limited) translated into copy a human can act on. Where
 * the tab goes AFTER success is `AuthGate`'s job (its own tests cover that);
 * this component's only contract on success is: call `login()`, then call
 * the shared `refresh()` so the auth gate notices.
 */
describe('LoginPage', () => {
  test('the submit button stays disabled until both fields are filled', () => {
    renderLogin(async () => {})
    // `toBeDisabled()` (jest-dom) is not wired up for this workspace's
    // `bun:test` — a plain property read on the live DOM node, same as
    // `ScheduleEditorDialog.test.tsx` does.
    const button = () => screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement
    expect(button().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } })
    expect(button().disabled).toBe(true) // password still empty
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } })
    expect(button().disabled).toBe(false)
  })

  test('a successful login posts credentials and hands off to refresh() — no navigation of its own', async () => {
    const refresh = mock(async () => {})
    const { apiMock } = renderLogin(refresh, {
      '/api/auth/login': { body: { user: { id: 'u1', email: 'a@b.com', role: 'admin' } } },
    })
    fillAndSubmit('a@b.com', 'correcthorse')

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(apiMock.calls[0]?.path).toBe('/api/auth/login')
    expect(apiMock.calls[0]?.body).toEqual({ email: 'a@b.com', password: 'correcthorse' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('wrong credentials: shows actionable copy and re-enables the form', async () => {
    renderLogin(async () => {}, {
      '/api/auth/login': { status: 401, body: { error: { code: 'auth.invalid_credentials', message: 'wrong email or password' } } },
    })
    fillAndSubmit('a@b.com', 'wrongpass')

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toBe('That email or password is not right.')
    const button = screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Sign in')
  })

  test('rate limited: tells the user to wait, not a raw 429', async () => {
    renderLogin(async () => {}, {
      '/api/auth/login': { status: 429, body: { error: { code: 'auth.rate_limited', message: 'too many attempts — try again later' } } },
    })
    fillAndSubmit('a@b.com', 'x'.repeat(8))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toBe('Too many attempts. Wait a bit before trying again.')
  })

  test('the core being unreachable shows a network-shaped message, not a blank failure', async () => {
    renderLogin(async () => {}, {
      '/api/auth/login': () => {
        throw new Error('network down')
      },
    })
    fillAndSubmit('a@b.com', 'x'.repeat(8))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('Could not reach the core')
  })
})
