import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { FarmSettingsSchema, toJsonSchema } from '@enkaku/protocol'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import SettingsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

// The real farm-defaults JSON Schema (`z.toJsonSchema`) — the same thing
// `GET /api/settings` sends, not an empty placeholder. `FarmForm` narrows
// this to the active section's own keys, so an empty `{}` schema would leave
// `SchemaForm` rendering an undefined field definition; generating it for
// real is cheap and avoids that failure mode entirely.
const settingsSchema = toJsonSchema(FarmSettingsSchema)
const farmSettings = FarmSettingsSchema.parse({})

function baseResponses(extra: Record<string, unknown> = {}) {
  return {
    '/api/settings': { body: { settings: farmSettings, schema: settingsSchema, deviceSchema: {} } },
    '/api/connectors': { body: { connectors: [] } },
    ...extra,
  }
}

describe('SettingsPage — smoke render', () => {
  test('loaded: renders the section nav and the default section content', async () => {
    renderWithApi(<SettingsPage />, baseResponses())
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy())
    // Plan 73 §3.4 — grouped now: "Defaults" appears twice (Devices' own, and AI Agents'), told
    // apart only by the group heading above each run, exactly as the plan's own diagram shows.
    expect(screen.getAllByRole('tab', { name: 'Defaults' })).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'Connectors' })).toBeTruthy()
    expect(screen.getByText('Devices')).toBeTruthy()
    expect(screen.getByText('AI Agents')).toBeTruthy()
    expect(screen.getByText('Farm')).toBeTruthy()
    // The default section ('defaults', device settings) has finished loading once its form fields exist.
    await waitFor(() => expect(document.querySelector('form')).toBeTruthy())
  })

  test('loaded: the Connectors section shows connector data once selected', async () => {
    setSearchParams({ tab: 'connectors' })
    renderWithApi(
      <SettingsPage />,
      baseResponses({
        '/api/connectors': { body: { connectors: [{ id: 'c1', name: 'anthropic-main', kind: 'anthropic', baseUrl: null, configured: true, hint: 'sk-…abcd', status: 'ok', statusMessage: null, checkedAt: null, createdAt: 0 }] } },
      }),
    )
    await waitFor(() => expect(screen.getByText('anthropic-main')).toBeTruthy())
  })

  test('loaded: AI Agents → Defaults renders agentDefaults from its own schema (criterion 13)', async () => {
    setSearchParams({ tab: 'ai-defaults' })
    renderWithApi(<SettingsPage />, baseResponses())
    // A field pulled straight from `AgentDefaultsSchema`'s own `.meta({ title })` (plan 65) — proof
    // this section renders from the schema rather than a hand-written form that could omit a field.
    await waitFor(() => expect(screen.getByText('Default model')).toBeTruthy())
    expect(screen.getByText('Max steps')).toBeTruthy()
    expect(screen.getByDisplayValue('claude-opus-5')).toBeTruthy()
  })

  test('loading: shows a busy skeleton before the default section loads', () => {
    setSearchParams({})
    renderWithApi(<SettingsPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/settings fetch shows a named error', async () => {
    setSearchParams({})
    renderWithApi(<SettingsPage />, {
      '/api/settings': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'settings boom' } } },
    })
    await waitFor(() => expect(screen.getByText('settings boom')).toBeTruthy())
  })
})
