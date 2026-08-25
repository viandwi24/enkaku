import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
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

describe('AgentDetailPage — Tools section bulk selection (plan 83 §3.7, criteria 18-20)', () => {
  const twoCapsSameGroup = [
    { ...validCapability, id: 'device.tap' },
    { ...validCapability, id: 'device.swipe', description: 'Swipe the screen.' },
  ]

  test('"Select all" checks every tool in one click; the group header reflects it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: { capabilities: twoCapsSameGroup } }))
    await openToolsSection()
    await waitFor(() => expect(screen.getByText('device.tap')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Select all' }))
    const tapCheckbox = screen.getByText('device.tap').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    const swipeCheckbox = screen.getByText('device.swipe').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    await waitFor(() => expect(tapCheckbox.checked).toBe(true))
    expect(swipeCheckbox.checked).toBe(true)
    // The button becomes "Clear all" once everything is selected.
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy()
  })

  test('checking only ONE tool in a group renders the group header indeterminate (criterion 19)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: { capabilities: twoCapsSameGroup } }))
    await openToolsSection()
    await waitFor(() => expect(screen.getByText('device.tap')).toBeTruthy())

    const tapCheckbox = screen.getByText('device.tap').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    await user.click(tapCheckbox)

    const groupCheckbox = screen.getByRole('checkbox', { name: /Select all device tools/i }) as HTMLInputElement
    await waitFor(() => expect(groupCheckbox.indeterminate).toBe(true))
    expect(groupCheckbox.checked).toBe(false)
  })

  test('the group header checkbox selects the WHOLE group in one click (criterion 18)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, baseResponses({ body: { capabilities: twoCapsSameGroup } }))
    await openToolsSection()
    await waitFor(() => expect(screen.getByText('device.tap')).toBeTruthy())

    const groupCheckbox = screen.getByRole('checkbox', { name: /Select all device tools/i }) as HTMLInputElement
    await user.click(groupCheckbox)

    const tapCheckbox = screen.getByText('device.tap').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    const swipeCheckbox = screen.getByText('device.swipe').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    await waitFor(() => expect(tapCheckbox.checked).toBe(true))
    expect(swipeCheckbox.checked).toBe(true)
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

/**
 * Plan 124 §4.5, §4.4 Group D, step 124.4 — the device-grants list.
 *
 * This list is the WHOLE fleet and it decides which phones an agent may
 * touch, and it had neither a number nor a search box: on a rack of
 * identically modelled phones it was a scroll hunt through the same word
 * repeated, with no way to type-to-find. The last test here is the one that
 * matters most — a "Select all" scoped to a filter must MERGE into the
 * existing grants, never replace them, or filtering silently revokes access
 * to every phone the operator could not see.
 */
describe('AgentDetailPage — device grants: the number and the search box (plan 124 §4.5)', () => {
  const devices = [
    // Same label, different numbers — plan 124 §0's opening rack. Neither the
    // label nor the stableId contains the digit 7, so "typing 7 finds only #7"
    // cannot pass by substring accident.
    { id: 'device-1', label: 'Galaxy A15', stableId: 'R5CWAAAA', status: 'idle', tags: [], number: 7 },
    { id: 'device-2', label: 'Galaxy A15', stableId: 'R5CWBBBB', status: 'idle', tags: [], number: 12 },
  ]

  function withDevices(agent: Record<string, unknown> = {}) {
    return {
      ...baseResponses({ body: { capabilities: [] } }),
      '/api/agents/agent-1': { body: { agent: { ...baseAgent, ...agent } } },
      '/api/devices*': { body: { items: devices, nextCursor: null, total: 2 } },
    }
  }

  async function openAccessSection() {
    await waitFor(() => expect(screen.getByText('Test Agent')).toBeTruthy())
    const tab = await screen.findByRole('tab', { name: 'Access' })
    tab.click()
    await waitFor(() => expect(screen.getByLabelText('Search devices to grant')).toBeTruthy())
  }

  /** Scoped to the grants panel — `ContextPanel`'s rail lists the same devices. */
  function panel() {
    return within(screen.getByTestId('device-grants'))
  }

  function grantCheckbox(stableId: string): HTMLInputElement {
    return panel().getByText(stableId).closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
  }

  test('each row names its device with the number, so two identical labels are distinguishable (criterion 6)', async () => {
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, withDevices())
    await openAccessSection()
    expect(panel().getAllByText('Galaxy A15').length).toBe(2)
    expect(panel().getAllByText('#7').length).toBe(1)
    expect(panel().getAllByText('#12').length).toBe(1)
  })

  test('typing "7" filters to #7 alone and shows a live count (criterion 1)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, withDevices())
    await openAccessSection()

    await user.type(screen.getByLabelText('Search devices to grant'), '7')
    await waitFor(() => expect(panel().getAllByText('Galaxy A15').length).toBe(1))
    expect(panel().queryAllByText('#12').length).toBe(0)
    expect(panel().getByText('1 of 2')).toBeTruthy()
  })

  test('a filter that matches nothing says so, naming the query — never a blank box', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, withDevices())
    await openAccessSection()

    await user.type(screen.getByLabelText('Search devices to grant'), 'zzz')
    await waitFor(() => expect(panel().getByText(/No device matches/)).toBeTruthy())
    expect(panel().getByText(/2 enrolled/)).toBeTruthy()
  })

  test('the bulk button says WHICH devices it applies to once a filter is on (§4.5)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, withDevices())
    await openAccessSection()

    await user.type(screen.getByLabelText('Search devices to grant'), '7')
    await waitFor(() => expect(panel().getByRole('button', { name: 'Select these 1' })).toBeTruthy())
  })

  test('a scoped "Select all" MERGES — it never revokes a grant the filter hid', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    // #12 is already granted, and the filter below hides it. With the
    // `toggleAll` this button used to call, "Select all" would have REPLACED
    // the whole selection with the filtered ids and silently dropped it.
    renderWithApi(<AgentDetailPage />, withDevices({ deviceGrants: ['device-2'] }))
    await openAccessSection()

    await user.type(screen.getByLabelText('Search devices to grant'), '7')
    await waitFor(() => expect(panel().getByRole('button', { name: 'Select these 1' })).toBeTruthy())
    await user.click(panel().getByRole('button', { name: 'Select these 1' }))

    await user.clear(screen.getByLabelText('Search devices to grant'))
    await waitFor(() => expect(panel().getAllByText('Galaxy A15').length).toBe(2))
    expect(grantCheckbox('R5CWAAAA').checked).toBe(true)
    expect(grantCheckbox('R5CWBBBB').checked).toBe(true)
  })

  test('a scoped "Clear all" clears only the filtered devices', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, withDevices({ deviceGrants: ['device-1', 'device-2'] }))
    await openAccessSection()

    await user.type(screen.getByLabelText('Search devices to grant'), '7')
    await waitFor(() => expect(panel().getByRole('button', { name: 'Clear these 1' })).toBeTruthy())
    await user.click(panel().getByRole('button', { name: 'Clear these 1' }))

    await user.clear(screen.getByLabelText('Search devices to grant'))
    await waitFor(() => expect(panel().getAllByText('Galaxy A15').length).toBe(2))
    expect(grantCheckbox('R5CWAAAA').checked).toBe(false)
    expect(grantCheckbox('R5CWBBBB').checked).toBe(true)
  })

  test('a device with no number renders its bare label — no stray "#" (criterion 7)', async () => {
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, {
      ...withDevices(),
      '/api/devices*': { body: { items: [{ ...devices[0], number: null }], nextCursor: null, total: 1 } },
    })
    await openAccessSection()
    expect(panel().getAllByText('Galaxy A15').length).toBe(1)
    expect(panel().queryAllByText(/^#/).length).toBe(0)
  })
})

/**
 * Plan 124 §4.4 Group D, step 124.4 — `agent/ContextPanel.tsx`'s granted-device
 * rail, which has no colocated test of its own and is exercised here because
 * this page is its only mount point. The rail answers "which phones may this
 * agent touch"; capped at twelve rows, it is precisely the list a repeated
 * model name made unreadable.
 */
describe('AgentDetailPage — the context rail names devices with their numbers (ContextPanel)', () => {
  test('the rail renders the number too, so both surfaces agree', async () => {
    setSearchParams({ id: 'agent-1', tab: 'settings' })
    renderWithApi(<AgentDetailPage />, {
      ...baseResponses({ body: { capabilities: [] } }),
      '/api/devices*': {
        body: {
          items: [{ id: 'device-1', label: 'Galaxy A15', stableId: 'R5CWAAAA', status: 'idle', tags: [], number: 7 }],
          nextCursor: null,
          total: 1,
        },
      },
    })
    // The Access section is not open (the page defaults to Identity), so the
    // ONLY device name on screen is the rail's — which is exactly what makes
    // this an unambiguous test of `ContextPanel` rather than of the grants
    // list beside it.
    await waitFor(() => expect(screen.getAllByText('#7').length).toBe(1))
    expect(screen.getAllByText('Galaxy A15').length).toBe(1)
  })
})
