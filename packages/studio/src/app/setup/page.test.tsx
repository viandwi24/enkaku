import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { AuthContext, type AuthState } from '@/lib/auth'
import { cleanup, renderWithApi } from '@/lib/test/render'
import SetupPage from './page'

// `coreBase()` falls back to `location.origin`, which happy-dom reports as
// the literal string "null" for a document with no real URL — pin it the
// same way every other Studio test does.
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function renderSetup(refresh: () => Promise<void>, responses: Parameters<typeof renderWithApi>[1] = {}) {
  const value: AuthState = { user: null, authMode: 'server', setupNeeded: true, refresh, logout: async () => {} }
  return renderWithApi(
    <AuthContext.Provider value={value}>
      <SetupPage />
    </AuthContext.Provider>,
    responses,
  )
}

function fill(email: string, password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm } })
}

/**
 * Requirement 1 of the "Studio has no login page" gap: the first-admin
 * bootstrap screen. The backend rejects a short password (`auth.weak_password`,
 * `POST /api/auth/setup`) — this screen's job is to make that rejection
 * useful, which it does in two layers: a client-side length check that stops
 * a short password from ever being submitted, AND `describeAuthError`
 * translating the code if the backend ever disagrees anyway.
 */
describe('SetupPage', () => {
  test('submit stays disabled for a short password or a mismatched confirmation', () => {
    renderSetup(async () => {})
    const button = () => screen.getByRole('button', { name: /create admin account/i }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@farm.test' } })
    expect(button().disabled).toBe(true)

    fill('admin@farm.test', 'short', 'short')
    expect(button().disabled).toBe(true)
    expect(screen.getByText(/at least 8 characters/i).className).toContain('text-led-danger')

    fill('admin@farm.test', 'longenough1', 'notthesame')
    expect(button().disabled).toBe(true)
    expect(screen.getByText('Passwords do not match.')).toBeTruthy()

    fill('admin@farm.test', 'longenough1', 'longenough1')
    expect(button().disabled).toBe(false)
  })

  test('a successful setup posts credentials and hands off to refresh()', async () => {
    const refresh = mock(async () => {})
    const { apiMock } = renderSetup(refresh, {
      '/api/auth/setup': { status: 201, body: { user: { id: 'u1', email: 'admin@farm.test', role: 'admin' } } },
    })
    fill('admin@farm.test', 'longenough1', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(apiMock.calls[0]?.path).toBe('/api/auth/setup')
    expect(apiMock.calls[0]?.body).toEqual({ email: 'admin@farm.test', password: 'longenough1' })
  })

  test('a second setup attempt (admin already exists) shows actionable copy, not a raw 409', async () => {
    renderSetup(async () => {}, {
      '/api/auth/setup': { status: 409, body: { error: { code: 'auth.setup_done', message: 'an admin already exists' } } },
    })
    fill('admin@farm.test', 'longenough1', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toBe('An admin already exists — sign in instead.')
  })

  // The concrete backend inconsistency this guards against: `createUser`
  // (`packages/core/src/auth/service.ts`) can answer `auth.weak_password`
  // with "password minimal 8 karakter" (Indonesian) on a path the client-side
  // length check does not fully shadow. Whatever the wire says, Studio shows
  // its own English copy for this code.
  test('a weak-password rejection from the backend never leaks the raw (possibly non-English) message', async () => {
    renderSetup(async () => {}, {
      '/api/auth/setup': { status: 400, body: { error: { code: 'auth.weak_password', message: 'password minimal 8 karakter' } } },
    })
    fill('admin@farm.test', 'longenough1', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toBe('Password must be at least 8 characters.')
  })
})
