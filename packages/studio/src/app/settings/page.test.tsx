import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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

/**
 * Plan 88 §5 step 88.5's "Farm networks" editor (CIDR ranges, sweep policy)
 * lives under Settings → "Discovery & monitoring", while a separate tab
 * literally named "Network" exists and holds only the geo-verification
 * lookup (plan 55 §3.2) — an operator searching "Network" for IP-range
 * scanning found nothing related, confirmed in-browser this session
 * (`docs/plans/96-m61-hotfixes.md`). This is the fix: a cross-link.
 */
describe('SettingsPage — Network tab cross-links to Discovery & monitoring (plan 88 §5, plan 96 hotfix)', () => {
  test('explains where farm networks / IP-range scanning actually lives, with a working link', async () => {
    setSearchParams({ tab: 'network' })
    renderWithApi(<SettingsPage />, baseResponses())
    await waitFor(() => expect(screen.getByText(/Looking for IP-range scanning/)).toBeTruthy())
    const link = screen.getByRole('link', { name: 'Discovery & monitoring' })
    expect(link.getAttribute('href')).toBe('/settings?tab=discovery')
  })
})

/**
 * The Guest agent tab's fleet-wide summary and "Provision all" action (plan
 * 90 §3.8, §5 step 90.6) — `farmSections.ts`'s own comment on this section
 * reserved this exact spot for it.
 */
/**
 * Plan 91 §3.5, F24 — `AuditEntrySchema` gained `meta` in step 91.3, written
 * by `AuditLogger.record` since M7 but dropped by this table until now. The
 * `device.assist` row this plan writes is exactly what makes `meta.jobId`
 * worth reading here — "assisted which JOB", not just "which device".
 */
describe('SettingsPage — audit meta (plan 91 §3.5, F24)', () => {
  test('a row with meta gets an expand toggle; opening it shows the JSON', async () => {
    setSearchParams({ tab: 'audit' })
    renderWithApi(
      <SettingsPage />,
      baseResponses({
        '/api/auth/audit*': {
          body: {
            entries: [
              { id: 'a1', userId: 'user-1', action: 'device.assist', target: 'dev-1', meta: { jobId: 'job-1', primaryKind: 'job' }, at: 1000 },
            ],
          },
        },
      }),
    )
    await waitFor(() => expect(screen.getByText('device.assist')).toBeTruthy())
    const toggle = screen.getByRole('button', { name: 'Show details' })
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText(/"jobId": "job-1"/)).toBeTruthy())
  })

  test('a row with no meta gets no expand toggle at all', async () => {
    setSearchParams({ tab: 'audit' })
    renderWithApi(
      <SettingsPage />,
      baseResponses({
        '/api/auth/audit*': {
          body: { entries: [{ id: 'a2', userId: 'user-1', action: 'device.control', target: 'dev-1', meta: null, at: 1000 }] },
        },
      }),
    )
    await waitFor(() => expect(screen.getByText('device.control')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull()
  })
})

/**
 * Plan 92 §3.6, §3.9, §5 step 92.8 — the Video section reached through the
 * REAL page (`FARM_SECTION_DEFS`'s own `video` entry → `FarmForm`'s
 * `render` prop → `FarmVideoFields`), not the standalone component test in
 * `components/video/FarmVideoFields.test.tsx` — this is what proves the
 * wiring, not just the component in isolation.
 */
describe('SettingsPage — Video (plan 92 §3.6, §3.9, §5 step 92.8)', () => {
  test('renders both preset dropdowns, the projection line, and the Apply to live sessions action', async () => {
    setSearchParams({ tab: 'video' })
    renderWithApi(
      <SettingsPage />,
      baseResponses({
        '/api/adb/stats': {
          body: {
            global: { maxConcurrent: 4, auto: true, inFlight: 0, waiting: 0 },
            streams: { maxStreams: 8, maxStreamsPerDevice: 1, active: 0, perDevice: {} },
            idleSessions: [],
            devices: [],
            transport: { connections: 1, bufferedBytesMax: 0, bufferedBytesP95: 0, videoBytesPerSec: 0, controlReplyMsP50: 0, controlReplyMsP95: 0, watchdogReconnects: 0 },
            hostAdb: { running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 0 },
            adbHealth: { status: 'ok', versionRttMs: 1, lastCheckedAt: 0, window: { seconds: 60, execs: 0, timeouts: 0, timeoutRate: 0 }, wedged: [], stuckOffline: [], symptoms: [], restartAdvised: false },
            video: { controlStreams: 0, wallStreams: 0, buildsRunning: 0, buildQueueDepth: 0, maxConcurrentBuilds: 2, maxTiles: 25, maxTilesAuto: true, transport: 'loopback' },
          },
        },
      }),
    )
    await waitFor(() => expect(screen.getByText('Device page picture')).toBeTruthy())
    expect(screen.getByText('Wall tile picture')).toBeTruthy()
    // Plan 100 §3.4/step 100.8 revised the wall default (480px · 18fps ·
    // 1.1Mbit/s); step 100.3 made the bandwidth bound transport-aware —
    // before the live poll resolves the projection defaults to `loopback`
    // (this farm's own generous 200 Mbit/s `wall.bandwidthBps`), so
    // computeAutoTiles(1_100_000, { decodeTileCeiling: 24, bandwidthBps: 200_000_000 })
    // = min(24, floor(200_000_000 / 1_100_000)) = 24 — decode-bound, not
    // bandwidth-bound.
    expect(screen.getByText(/24 live tiles/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Apply to live sessions/ })).toBeTruthy()
  })
})

describe('SettingsPage — Guest agent (plan 90 §5 step 90.6)', () => {
  test('renders the fleet summary and a state breakdown from GET /api/guest-agent/summary', async () => {
    setSearchParams({ tab: 'guest-agent' })
    renderWithApi(
      <SettingsPage />,
      baseResponses({
        '/api/guest-agent/summary': {
          body: { total: 20, byState: { ready: 18, outdated: 2 }, byVersion: { '1.2.0': 18, '1.1.0': 2 } },
        },
      }),
    )
    await waitFor(() => expect(screen.getByText('18 of 20 devices on 1.2.0')).toBeTruthy())
    expect(screen.getByText('outdated')).toBeTruthy()
  })

  test('Provision all calls POST /api/guest-agent/provision and refreshes the summary', async () => {
    setSearchParams({ tab: 'guest-agent' })
    let provisioned = false
    const { apiMock } = renderWithApi(
      <SettingsPage />,
      baseResponses({
        '/api/guest-agent/summary': () => ({
          body: provisioned
            ? { total: 2, byState: { ready: 2 }, byVersion: { '1.2.0': 2 } }
            : { total: 2, byState: { ready: 1, failed: 1 }, byVersion: { '1.2.0': 1, unknown: 1 } },
        }),
        '/api/guest-agent/provision': () => {
          provisioned = true
          return { body: { total: 2, results: [{ deviceId: 'd1', state: 'ready', reason: null }, { deviceId: 'd2', state: 'ready', reason: null }] } }
        },
      }),
    )
    await waitFor(() => expect(screen.getByText('failed')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Provision all' }))
    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/guest-agent/provision')).toBe(true),
    )
    await waitFor(() => expect(screen.queryByText('failed')).toBeNull())
  })
})
