import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import { AuthContext, type AuthState } from '@/lib/auth'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { SavedCommands } from './SavedCommands'

/**
 * Plan 93 §3.10, step 93.7 — "saved commands are a farm asset... visible to
 * all; editable and deletable by the owner or an admin." "Use" hands the
 * command back to the console rather than running it directly, so every run
 * still goes through the same target-preview/confirmation path (§3.14).
 */

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function auth(overrides: Partial<AuthState> = {}): AuthState {
  return { user: null, authMode: 'local', setupNeeded: false, refresh: async () => {}, logout: async () => {}, ...overrides }
}

function saved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sc-1',
    name: 'battery level',
    description: 'quick check',
    cmd: 'dumpsys battery | grep level',
    defaultTarget: null,
    createdBy: 'user-1',
    createdAt: 0,
    updatedAt: 0,
    sortOrder: 0,
    ...overrides,
  }
}

describe('SavedCommands', () => {
  test('lists saved commands and "Use" hands the command back rather than running it', async () => {
    let used: [string, unknown] | null = null
    const { getByText, getByRole } = renderWithApi(
      <SavedCommands currentCmd="" currentTarget={null} onUse={(cmd, target) => (used = [cmd, target])} />,
      { '/api/saved-commands': { body: { items: [saved()] } } },
    )
    await waitFor(() => expect(getByText('battery level')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Use' }))
    expect(used).toEqual(['dumpsys battery | grep level', null])
  })

  test('a missing or unmounted route (93.6\'s own state today) leaves the panel empty, never an error', async () => {
    const { getByText } = renderWithApi(<SavedCommands currentCmd="" currentTarget={null} onUse={() => {}} />, {})
    await waitFor(() => expect(getByText('No saved commands yet')).toBeTruthy())
  })

  test('the owner sees Delete', async () => {
    const { getByText, getByRole } = renderWithApi(
      <AuthContext.Provider value={auth({ user: { id: 'user-1', email: 'a@x.com', role: 'operator' }, authMode: 'server' })}>
        <SavedCommands currentCmd="" currentTarget={null} onUse={() => {}} />
      </AuthContext.Provider>,
      { '/api/saved-commands': { body: { items: [saved({ createdBy: 'user-1' })] } } },
    )
    await waitFor(() => expect(getByText('battery level')).toBeTruthy())
    expect(getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  test('another operator does not see Delete on someone else\'s', async () => {
    const { getByText, queryByRole } = renderWithApi(
      <AuthContext.Provider value={auth({ user: { id: 'user-2', email: 'b@x.com', role: 'operator' }, authMode: 'server' })}>
        <SavedCommands currentCmd="" currentTarget={null} onUse={() => {}} />
      </AuthContext.Provider>,
      { '/api/saved-commands': { body: { items: [saved({ createdBy: 'user-1' })] } } },
    )
    await waitFor(() => expect(getByText('battery level')).toBeTruthy())
    expect(queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  test('an admin sees Delete on anyone\'s', async () => {
    const { getByText, getByRole } = renderWithApi(
      <AuthContext.Provider value={auth({ user: { id: 'user-3', email: 'c@x.com', role: 'admin' }, authMode: 'server' })}>
        <SavedCommands currentCmd="" currentTarget={null} onUse={() => {}} />
      </AuthContext.Provider>,
      { '/api/saved-commands': { body: { items: [saved({ createdBy: 'user-1' })] } } },
    )
    await waitFor(() => expect(getByText('battery level')).toBeTruthy())
    expect(getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  test('creating one posts name/description/cmd/defaultTarget and refreshes the list', async () => {
    let postSeen = false
    const { getByText, getByPlaceholderText, getByRole, apiMock } = renderWithApi(
      <SavedCommands currentCmd="getprop ro.serialno" currentTarget={{ deviceIds: ['dev-1'] }} onUse={() => {}} />,
      {
        '/api/saved-commands': (req) => {
          if (req.method === 'POST') {
            postSeen = true
            return { status: 201, body: { savedCommand: saved({ id: 'sc-2', name: 'serial', cmd: 'getprop ro.serialno' }) } }
          }
          return { body: { items: postSeen ? [saved({ id: 'sc-2', name: 'serial', cmd: 'getprop ro.serialno' })] : [] } }
        },
      },
    )
    await waitFor(() => expect(getByText('No saved commands yet')).toBeTruthy())
    fireEvent.click(getByText('Save current command'))
    fireEvent.change(getByPlaceholderText(/Name/), { target: { value: 'serial' } })
    fireEvent.click(getByRole('button', { name: 'Save' }))
    // `apiMock.calls` records the CALL synchronously (before the mock's own
    // async handler runs), so asserting off it — not off a variable the
    // handler sets — avoids a race between "the call landed" and "the
    // handler finished".
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST')).toBe(true))
    const postCall = apiMock.calls.find((c) => c.method === 'POST')
    expect(postCall?.body).toEqual({ name: 'serial', description: null, cmd: 'getprop ro.serialno', defaultTarget: { deviceIds: ['dev-1'] } })
    await waitFor(() => expect(getByText('serial')).toBeTruthy())
  })
})
