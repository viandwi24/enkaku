import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import type { Agent } from '@/lib/agents'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { AskAnAgentDialog } from './AskAnAgentDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: overrides.id ?? 'a1',
    slug: 'agent',
    name: 'Agent',
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
    ...overrides,
  }
}

/**
 * `AskAnAgentDialog` (plan 73 §3.5, §4.6, criterion 15) — the picker lists
 * only agents that MAY reach the device (plan 65 §3.5's grants, including
 * the empty-means-all rule) and are enabled; every other one is shown,
 * disabled, with the reason. "Offering an agent that will then refuse is
 * the 'precondition presented as an error' failure plan 59 was written to
 * remove."
 */
describe('AskAnAgentDialog — smoke render', () => {
  test('criterion 15: an unrestricted agent and one granted THIS device are selectable; a disabled agent and one granted only another device are not, each with a reason', async () => {
    const agents = [
      agent({ id: 'all', name: 'All-devices agent' }), // deviceGrants: [] — every device, including this one
      agent({ id: 'granted', name: 'Granted agent', deviceGrants: ['dev-1'] }),
      agent({ id: 'other', name: 'Other-device agent', deviceGrants: ['dev-2'] }),
      agent({ id: 'off', name: 'Disabled agent', enabled: false }),
    ]
    renderWithApi(
      <AskAnAgentDialog deviceId="dev-1" deviceLabel="Pixel 8" open={true} onOpenChange={() => undefined} />,
      { '/api/agents': { body: { agents } } },
    )

    await waitFor(() => expect(screen.getByText('All-devices agent')).toBeTruthy())
    const allBtn = screen.getByText('All-devices agent').closest('button') as HTMLButtonElement
    const grantedBtn = screen.getByText('Granted agent').closest('button') as HTMLButtonElement
    const otherBtn = screen.getByText('Other-device agent').closest('button') as HTMLButtonElement
    const offBtn = screen.getByText('Disabled agent').closest('button') as HTMLButtonElement

    expect(allBtn.disabled).toBe(false)
    expect(grantedBtn.disabled).toBe(false)
    expect(otherBtn.disabled).toBe(true)
    expect(offBtn.disabled).toBe(true)

    // Reasons are attached to the DOM even though they render inside a hover tooltip — proof the
    // component actually computed and passed one, not merely that the row looks disabled.
    expect(screen.getByText(/Other-device agent is not granted access to Pixel 8/)).toBeTruthy()
    expect(screen.getByText(/This agent is disabled/)).toBeTruthy()
  })

  test('the Start button is disabled until an agent is picked', async () => {
    renderWithApi(
      <AskAnAgentDialog deviceId="dev-1" deviceLabel="Pixel 8" open={true} onOpenChange={() => undefined} />,
      { '/api/agents': { body: { agents: [agent({ id: 'a1', name: 'Triage bot' })] } } },
    )
    await waitFor(() => expect(screen.getByText('Triage bot')).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Start conversation' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('no agents yet shows the empty state, not a blank list', async () => {
    renderWithApi(
      <AskAnAgentDialog deviceId="dev-1" deviceLabel="Pixel 8" open={true} onOpenChange={() => undefined} />,
      { '/api/agents': { body: { agents: [] } } },
    )
    await waitFor(() => expect(screen.getByText('No agents yet')).toBeTruthy())
  })
})


  /**
   * Plan 124 §4.4, step 124.3 — `deviceLabel` stays a plain `string` prop and
   * the caller composes it with `formatDeviceName()`. What this pins is the
   * other half of that contract: the value is rendered VERBATIM at every
   * mention, so a composed name never arrives twice (`#7 #7 Galaxy A15`),
   * which is exactly the failure plan 124 §10's note on `MirrorMember`
   * records for the popup's own member list.
   */
describe('AskAnAgentDialog — the device name arrives composed (plan 124 §4.4)', () => {
  test('the title, the scope sentence and the prompt placeholder all name the device verbatim', async () => {
    renderWithApi(
      <AskAnAgentDialog deviceId="dev-1" deviceLabel="#7 Galaxy A15" open={true} onOpenChange={() => undefined} />,
      { '/api/agents': { body: { agents: [] } } },
    )
    await waitFor(() => expect(screen.getByText('Ask an agent about #7 Galaxy A15')).toBeTruthy())
    expect(screen.getByText(/can touch #7 Galaxy A15 and no other phone/)).toBeTruthy()
    expect(screen.getByPlaceholderText(/What should it check on #7 Galaxy A15\?/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('#7 #7')
  })
})
