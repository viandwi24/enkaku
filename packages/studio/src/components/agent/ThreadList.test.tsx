import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ThreadList } from './ThreadList'

/**
 * Plan 83 §3.6, §4.4, criteria 14-17 — a per-row Delete affordance did not
 * exist anywhere before this plan. The cascade and the active-run refusal
 * are proven at the store/route level (`thread/store.test.ts`,
 * `api/threads.test.ts`); this covers the UI half — the confirm names the
 * counts (criterion 16) and the row disappears from the list on success.
 */

// `coreBase()` (`lib/ws.ts`) falls back to `location.origin` when this is unset — happy-dom's
// default document location serialises to the literal string "null" (an opaque origin, per the
// URL spec), which silently breaks every `pathMatches` lookup in `installApiMock` (matches
// Chat.test.tsx's own precedent for the same reason).
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const thread = { id: 'thread-1', agentId: 'agent-1', title: 'My thread', origin: 'chat', onApprovalRequired: 'pause', deviceScope: null, createdBy: null, createdAt: 0, updatedAt: 0 }

describe('ThreadList — delete affordance', () => {
  test('the confirm dialog names how many messages and runs will be deleted (criterion 16)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<ThreadList agentId="agent-1" threads={[thread as never]} activeThreadId={null} onNewThread={() => undefined} newThreadPending={false} />, {
      '/api/v1/threads/thread-1/delete-preview': { body: { counts: { messages: 4, runs: 2 } } },
    })
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    await user.click(await screen.findByText('Delete'))
    await waitFor(() => expect(screen.getByText(/This deletes 4 messages and 2 runs/)).toBeTruthy())
  })

  test('confirming calls DELETE and removes the row via onThreadDeleted', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    let deletedId: string | null = null
    let deleteCalled = false
    renderWithApi(
      <ThreadList
        agentId="agent-1"
        threads={[thread as never]}
        activeThreadId={null}
        onNewThread={() => undefined}
        newThreadPending={false}
        onThreadDeleted={(id) => (deletedId = id)}
      />,
      {
        '/api/v1/threads/thread-1/delete-preview': { body: { counts: { messages: 1, runs: 0 } } },
        '/api/v1/threads/thread-1': (req) => {
          if (req.method === 'DELETE') {
            deleteCalled = true
            return { body: { deleted: true, counts: { messages: 1, runs: 0 } } }
          }
          return { status: 404, body: {} }
        },
      },
    )
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    await user.click(await screen.findByText('Delete'))
    await waitFor(() => expect(screen.getByText(/This deletes/)).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteCalled).toBe(true))
    await waitFor(() => expect(deletedId).toBe('thread-1'))
  })

  test('a refused delete (active run) shows the failure and the thread stays listed', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    let deletedCalled = false
    renderWithApi(
      <ThreadList agentId="agent-1" threads={[thread as never]} activeThreadId={null} onNewThread={() => undefined} newThreadPending={false} onThreadDeleted={() => (deletedCalled = true)} />,
      {
        '/api/v1/threads/thread-1/delete-preview': { body: { counts: { messages: 1, runs: 1 } } },
        '/api/v1/threads/thread-1': { status: 409, body: { error: { code: 'E_THREAD_RUN_ACTIVE', message: 'thread thread-1 has an active run' } } },
      },
    )
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    await user.click(await screen.findByText('Delete'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByText('My thread')).toBeTruthy()) // still listed
    expect(deletedCalled).toBe(false)
  })
})
