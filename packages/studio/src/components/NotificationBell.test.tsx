import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

// See `app/page.test.tsx` for why `@/lib/ws` is mocked rather than
// left to open a real WebSocket in happy-dom.
mock.module('@/lib/ws', () => ({
  coreBase: () => 'http://core.test',
  ws: {
    send: () => {},
    on: () => () => {},
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(false)
      return () => {}
    },
    onReconnected: () => () => {},
    isConnected: () => false,
    getSessionId: () => null,
    request: () => Promise.reject(new Error('ws.request is not mocked in this test')),
    connect: () => {},
  },
  newId: () => 'test-id',
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

const { NotificationBell } = await import('./NotificationBell')

afterEach(cleanup)

/**
 * Smoke render only (plan 72 §4.5 — "per component with meaningful
 * branching"): the popover's own content is Radix `Popover` machinery
 * (Popper positioning) that needs browser layout APIs happy-dom does not
 * implement, so this stays at "mounts, fetches, does not throw, shows an
 * unread badge when the count is nonzero" rather than opening the popover.
 */
describe('NotificationBell — smoke render', () => {
  test('loaded: no unread notifications, no badge', async () => {
    renderWithApi(<NotificationBell />, {
      '/api/notifications*': { body: { items: [], unreadCount: 0 } },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy())
    expect(screen.queryByText('9+')).toBeFalsy()
  })

  test('loaded: unread notifications show a badge', async () => {
    renderWithApi(<NotificationBell />, {
      '/api/notifications*': { body: { items: [], unreadCount: 3 } },
    })
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy())
  })

  test('a failed fetch does not crash the bell', () => {
    expect(() =>
      renderWithApi(<NotificationBell />, {
        '/api/notifications*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'bell boom' } } },
      }),
    ).not.toThrow()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy()
  })
})
