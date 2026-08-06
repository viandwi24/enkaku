import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import AgentDetailPage from './page'

/**
 * Plan 72 §7 — the Tools-section regression pin. Before plan 72,
 * `GET /api/v1/cap` returned a bare array while this page asked for
 * `{capabilities: [...]}`; `b.capabilities` was `undefined` on every load
 * and the Tools tab crashed. `ListCapabilitiesResponseSchema` (from
 * `@enkaku/protocol`) now rejects that bare-array shape instead of letting
 * it through as `undefined` — the case below asserts the page shows a
 * visible, named error rather than crashing or silently rendering nothing.
 * Reverting `packages/core/src/api/cap.ts`'s envelope (§4.2) must make this
 * test fail (criterion 9) — verified manually, see the task report.
 */

afterEach(cleanup)

// happy-dom's default `location` is `about:blank` (`origin` is the literal
// string `"null"`), so `coreBase()` (`lib/ws.ts`) falls through to it and
// every fetched path would arrive prefixed with that literal `"null"`
// rather than a real origin `installApiMock`'s path-matching can strip. A
// concrete origin makes the mocked paths behave exactly as they do against
// a real `http://localhost:7700`.
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

const baseAgent = {
  id: 'agent-1',
  slug: 'agent-1',
  name: 'Test Agent',
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

const validCapability = {
  id: 'device.tap',
  description: 'Tap the screen at a coordinate.',
  input: {},
  output: {},
  permission: 'device.control',
  lease: 'device',
  deadline: 5000,
  effect: 'write',
}

function baseResponses(capResponse: { status?: number; body?: unknown }) {
  return {
    '/api/agents/agent-1': { body: { agent: baseAgent } },
    '/api/v1/threads*': { body: { threads: [] } },
    '/api/settings': { body: { settings: {}, schema: {}, deviceSchema: {} } },
    '/api/connectors': { body: { connectors: [] } },
    '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/v1/cap': capResponse,
  }
}

async function openToolsSection() {
  // Settings tab, Tools section — the agent load first, then the section click.
  await waitFor(() => expect(screen.getByText('Test Agent')).toBeTruthy())
  const toolsTab = await screen.findByRole('tab', { name: 'Tools' })
  toolsTab.click()
}

describe('AgentDetailPage — Tools section (plan 72 regression pin)', () => {
  test('a BARE ARRAY from /api/v1/cap (the pre-fix shape) shows a visible, named error — not a crash, not silence', async () => {
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: [validCapability] }))
    await openToolsSection()
    await waitFor(() => expect(screen.getByText(/could not be understood|did not understand|E_BAD_RESPONSE/i)).toBeTruthy())
  })

  test('a valid {capabilities: [...]} response renders the capability list', async () => {
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: { capabilities: [validCapability] } }))
    await openToolsSection()
    await waitFor(() => expect(screen.getByText('device.tap')).toBeTruthy())
    expect(screen.getByText('Tap the screen at a coordinate.')).toBeTruthy()
  })

  test('an empty capabilities array renders without throwing', async () => {
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: { capabilities: [] } }))
    await openToolsSection()
    // Nothing to assert beyond "did not throw" — an empty list has no content of its own.
    await waitFor(() => expect(screen.getByRole('tabpanel')).toBeTruthy())
  })
})

describe('AgentDetailPage — smoke render', () => {
  test('loaded: shows the agent name once every fetch resolves', async () => {
    setSearchParams({ id: 'agent-1' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: { capabilities: [] } }))
    await waitFor(() => expect(screen.getByText('Test Agent')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the agent loads', () => {
    setSearchParams({ id: 'agent-1' })
    renderWithApi(<AgentDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed agent fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'agent-1' })
    renderWithApi(<AgentDetailPage />, {
      ...baseResponses({ body: { capabilities: [] } }),
      '/api/agents/agent-1': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
    })
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<AgentDetailPage />, {})
    expect(screen.getByText('No agent id given.')).toBeTruthy()
  })
})
