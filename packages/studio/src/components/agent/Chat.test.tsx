import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

/**
 * `Chat` (plan 78 §4.2) replaces `Transcript` — the same three render
 * states Plan 72's infrastructure requires (criterion 10): loaded, loading,
 * error. Unlike `Transcript`, `Chat` never touches `/ws` directly (no
 * `@/lib/ws` mock needed) — its ONLY network calls before a message is ever
 * sent are plain `api()` GETs (`renderWithApi`'s stub already covers
 * those); `useChat`'s own `fetch` transport is only reached once
 * `sendMessage` is actually called, which none of these smoke renders do.
 *
 * The ported `PromptInputButton` (attach) renders a `<Tooltip>` relying on
 * the app-wide `<TooltipProvider>` from `app/layout.tsx` — absent here
 * since these tests mount `Chat` in isolation (the SAME need
 * `jobs/page.test.tsx` already documents), so it is supplied locally.
 */

const { Chat } = await import('./Chat')

function Wrapped(props: { threadId: string }) {
  return (
    <TooltipProvider>
      <Chat threadId={props.threadId} />
    </TooltipProvider>
  )
}

afterEach(cleanup)

const userMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  runId: null,
  seq: 1,
  role: 'user',
  content: [{ type: 'text', text: 'Hello agent' }],
  createdAt: 0,
}

const settingsBody = { settings: { agentDefaults: { connectorId: null, model: 'test-model', settings: { effort: 'medium' }, compactAtRatio: 0.8 } } }
const noCommands = { body: { commands: [] } }

describe('Chat — smoke render', () => {
  test('loaded: renders history messages', async () => {
    renderWithApi(<Wrapped threadId="thread-1" />, {
      '/api/v1/threads/thread-1/messages*': { body: { messages: [userMessage] } },
      '/api/settings': { body: settingsBody },
      '/api/v1/agent-commands': noCommands,
    })
    await waitFor(() => expect(screen.getByText('Hello agent')).toBeTruthy())
  })

  test('loaded: no messages shows the empty state', async () => {
    renderWithApi(<Wrapped threadId="thread-1" />, {
      '/api/v1/threads/thread-1/messages*': { body: { messages: [] } },
      '/api/settings': { body: settingsBody },
      '/api/v1/agent-commands': noCommands,
    })
    await waitFor(() => expect(screen.getByText('Nothing here yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before history loads', () => {
    renderWithApi(<Wrapped threadId="thread-1" />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed history fetch shows a named error', async () => {
    renderWithApi(<Wrapped threadId="thread-1" />, {
      '/api/v1/threads/thread-1/messages*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'chat history boom' } } },
      '/api/settings': { body: settingsBody },
      '/api/v1/agent-commands': noCommands,
    })
    await waitFor(() => expect(screen.getByText('chat history boom')).toBeTruthy())
  })

  test('the composer (ported prompt-input) renders alongside the conversation', async () => {
    renderWithApi(<Wrapped threadId="thread-1" />, {
      '/api/v1/threads/thread-1/messages*': { body: { messages: [] } },
      '/api/settings': { body: settingsBody },
      '/api/v1/agent-commands': noCommands,
    })
    await waitFor(() => expect(screen.getByPlaceholderText('Message the agent… (/ for commands)')).toBeTruthy())
  })

  test('slash commands (plan 78 §3.6): typing "/" shows the assembled list, filtered live, and selecting one completes the text', async () => {
    renderWithApi(<Wrapped threadId="thread-1" />, {
      '/api/v1/threads/thread-1/messages*': { body: { messages: [] } },
      '/api/settings': { body: settingsBody },
      '/api/v1/agent-commands': { body: { commands: [{ name: 'compact', description: 'summarize the conversation' }, { name: 'reset', description: 'start fresh' }] } },
    })
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const textarea = await screen.findByPlaceholderText('Message the agent… (/ for commands)')
    await user.type(textarea, '/comp')
    await waitFor(() => expect(screen.getByText('summarize the conversation')).toBeTruthy())
    expect(screen.queryByText('start fresh')).toBeNull() // filtered out by the "comp" prefix
    await user.click(screen.getByText('summarize the conversation'))
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('/compact '))
  })
})
