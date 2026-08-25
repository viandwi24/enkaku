import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

// See `app/page.test.tsx` for why `@/lib/ws` is mocked rather than
// left to open a real WebSocket in happy-dom — `takeOver` also calls
// `ws.request`, which this mock rejects by default (unused by these tests).
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

const { TakeControlDialog } = await import('./TakeControlDialog')

afterEach(cleanup)

describe('TakeControlDialog — smoke render', () => {
  test('open, holder is a person: names the holder and shows the take-control action', async () => {
    renderWithApi(
      <TakeControlDialog
        deviceId="dev-1"
        deviceLabel="Pixel 7"
        holder={{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: true, acquiredAt: 0, expiresAt: null }}
        open
        onOpenChange={() => {}}
        onTaken={() => {}}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText('Take control of Pixel 7 from Alice?')).toBeTruthy())
  })

  /**
   * Plan 124 §4.4, step 124.3 — `deviceLabel` stays a plain `string` prop and
   * the caller composes it with `formatDeviceName()`. What this pins is the
   * other half of that contract: the value is rendered VERBATIM at every
   * mention, so a composed name never arrives twice (`#7 #7 Galaxy A15`),
   * which is exactly the failure plan 124 §10's note on `MirrorMember`
   * records for the popup's own member list.
   */
  test('an already-composed name is rendered verbatim, never composed twice', async () => {
    renderWithApi(
      <TakeControlDialog
        deviceId="dev-1"
        deviceLabel="#7 Galaxy A15"
        holder={{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: true, acquiredAt: 0, expiresAt: null }}
        open
        onOpenChange={() => {}}
        onTaken={() => {}}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText('Take control of #7 Galaxy A15 from Alice?')).toBeTruthy())
    expect(document.body.textContent).not.toContain('#7 #7')
  })

  test('open, holder is an agent: fetches the run/thread title without throwing', async () => {
    renderWithApi(
      <TakeControlDialog
        deviceId="dev-1"
        deviceLabel="Pixel 7"
        holder={{ kind: 'agent', id: 'agent-1', label: 'Triage bot', runId: 'run-1', takeable: true, acquiredAt: 0, expiresAt: null }}
        open
        onOpenChange={() => {}}
        onTaken={() => {}}
      />,
      {
        '/api/v1/runs/run-1': {
          body: {
            run: {
              id: 'run-1',
              threadId: 'thread-1',
              status: 'running',
              stopReason: null,
              errorClass: null,
              error: null,
              steps: 0,
              usage: null,
              startedAt: 0,
              finishedAt: null,
              parentRunId: null,
              rootRunId: 'run-1',
              depth: 1,
              awaited: false,
              deviceGrantsOverride: null,
            },
          },
        },
        '/api/v1/threads/thread-1': { body: { thread: { id: 'thread-1', agentId: 'agent-1', title: 'Checking device state', origin: 'chat', onApprovalRequired: 'pause', deviceScope: null, createdBy: null, createdAt: 0, updatedAt: 0 } } },
      },
    )
    await waitFor(() => expect(screen.getByText(/is using this device now/)).toBeTruthy())
  })

  test('closed: renders nothing throw-worthy', () => {
    expect(() =>
      renderWithApi(
        <TakeControlDialog
          deviceId="dev-1"
          deviceLabel="Pixel 7"
          holder={{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: true, acquiredAt: 0, expiresAt: null }}
          open={false}
          onOpenChange={() => {}}
          onTaken={() => {}}
        />,
        {},
      ),
    ).not.toThrow()
  })
})
