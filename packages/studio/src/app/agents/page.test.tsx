import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import AgentsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const agent = {
  id: 'agent-1',
  slug: 'agent-1',
  name: 'Triage bot',
  description: null,
  colour: null,
  enabled: true,
  connectorId: null,
  model: null,
  systemPrompt: null,
  settings: {},
  tools: [],
  requiresApproval: [],
  deviceGrants: [],
  workspaceScope: { read: [], write: [] },
  permissions: [],
  wakeOnMessage: 'on-child-result',
  ownerId: null,
  createdAt: 0,
  updatedAt: 0,
}

describe('AgentsPage — smoke render', () => {
  test('loaded: shows the agent list', async () => {
    renderWithApi(<AgentsPage />, {
      '/api/agents': { body: { agents: [agent] } },
      '/api/v1/threads*': { body: { threads: [] } },
    })
    await waitFor(() => expect(screen.getByText('Triage bot')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<AgentsPage />, { '/api/agents': { body: { agents: [] } } })
    await waitFor(() => expect(screen.getByText('No agents yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the list loads', () => {
    renderWithApi(<AgentsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/agents fetch shows a named error', async () => {
    renderWithApi(<AgentsPage />, {
      '/api/agents': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'agents boom' } } },
    })
    await waitFor(() => expect(screen.getByText('agents boom')).toBeTruthy())
  })
})

/**
 * Plan 73 §3.3, §4.3, criterion 10, 17 — delete belongs on the LIST, where a
 * person looks for it, not only behind first opening the agent. This is the
 * render test for the row menu and the delete confirmation naming what goes
 * with the agent.
 */
describe('AgentsPage — row actions (plan 73 §3.3)', () => {
  test('criterion 10: the row menu offers Open, Duplicate, and Delete', async () => {
    const user = userEvent.setup()
    renderWithApi(<AgentsPage />, {
      '/api/agents': { body: { agents: [agent] } },
      '/api/v1/threads*': { body: { threads: [] } },
    })
    await waitFor(() => expect(screen.getByText('Triage bot')).toBeTruthy())
    // Radix's `DropdownMenuTrigger` opens on `pointerdown`, not a bare `click` — `user-event`
    // dispatches the full pointer sequence a real browser would, which `fireEvent.click` alone does
    // not (this is what silently left the menu never open the first time this test was written).
    await user.click(screen.getByRole('button', { name: 'More actions for Triage bot' }))
    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy()
  })

  test('criterion 10: Delete… names the threads and runs that go with the agent', async () => {
    const user = userEvent.setup()
    const message = (id: string, threadId: string, runId: string) => ({
      id, threadId, runId, seq: 1, role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0,
    })
    const run = (id: string, threadId: string) => ({
      id, threadId, status: 'succeeded', stopReason: 'done', errorClass: null, error: null, steps: 1,
      usage: null, startedAt: 0, finishedAt: 1, parentRunId: null, rootRunId: id, depth: 1, awaited: false, deviceGrantsOverride: null,
    })
    renderWithApi(<AgentsPage />, {
      // More specific patterns FIRST — `installApiMock` resolves the first key whose pattern
      // matches (in declaration order), and `/api/v1/threads*`'s trailing wildcard would otherwise
      // also swallow `/api/v1/threads/t1/messages`, silently handing back a thread LIST where a
      // MESSAGE list was expected (a schema mismatch `fetchRecentRuns` treats as "no runs here" —
      // this is what a `runs: 0` in an earlier version of this test's own dialog actually meant).
      '/api/v1/threads/t1/messages*': { body: { messages: [message('m1', 't1', 'r1')] } },
      '/api/v1/threads/t2/messages*': { body: { messages: [message('m2', 't2', 'r2')] } },
      '/api/v1/runs/r1': { body: { run: run('r1', 't1') } },
      '/api/v1/runs/r2': { body: { run: run('r2', 't2') } },
      '/api/agents': { body: { agents: [agent] } },
      '/api/v1/threads*': { body: { threads: [{ id: 't1', agentId: 'agent-1', title: null, origin: 'chat', onApprovalRequired: 'pause', deviceScope: null, createdBy: null, createdAt: 0, updatedAt: 0 }, { id: 't2', agentId: 'agent-1', title: null, origin: 'chat', onApprovalRequired: 'pause', deviceScope: null, createdBy: null, createdAt: 0, updatedAt: 0 }] } },
    })
    await waitFor(() => expect(screen.getByText('Triage bot')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'More actions for Triage bot' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    await waitFor(() => expect(screen.getByText(/This removes 2 conversations and 2 runs/)).toBeTruthy())
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy()
  })
})
