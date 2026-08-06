import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import AgentRunsPage from './page'

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

describe('AgentRunsPage — smoke render', () => {
  test('loaded: shows the agent name and an empty runs state', async () => {
    setSearchParams({ agent: 'agent-1' })
    renderWithApi(<AgentRunsPage />, {
      '/api/agents/agent-1': { body: { agent } },
      '/api/v1/threads*': { body: { threads: [] } },
    })
    await waitFor(() => expect(screen.getByText('Runs — Triage bot')).toBeTruthy())
    expect(screen.getByText('No runs yet')).toBeTruthy()
  })

  test('loading: shows a busy skeleton before the run history loads', () => {
    setSearchParams({ agent: 'agent-1' })
    renderWithApi(<AgentRunsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed thread fetch shows a named error', async () => {
    setSearchParams({ agent: 'agent-1' })
    renderWithApi(<AgentRunsPage />, {
      '/api/agents/agent-1': { body: { agent } },
      '/api/v1/threads*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'runs boom' } } },
    })
    await waitFor(() => expect(screen.getByText('runs boom')).toBeTruthy())
  })

  test('no agent in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<AgentRunsPage />, {})
    expect(screen.getByText('No agent specified.')).toBeTruthy()
  })
})
