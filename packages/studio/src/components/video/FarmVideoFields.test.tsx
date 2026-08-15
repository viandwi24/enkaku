import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { FarmSettingsSchema, toJsonSchema } from '@enkaku/protocol'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { FarmVideoFields } from './FarmVideoFields'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'
afterEach(cleanup)

// The real farm-defaults JSON Schema, narrowed to the `video` key exactly
// the way `FarmForm`'s own `sectionSchema` does (`app/settings/page.tsx`) —
// not a hand-built stub, so a schema shape this test would silently miss
// diverging from is the same one the real page renders.
const fullSchema = toJsonSchema(FarmSettingsSchema) as JsonSchemaNode
const videoSectionSchema = narrowSchema(fullSchema, ['video'])
const farmSettings = FarmSettingsSchema.parse({}) as unknown as Record<string, unknown>

const statsBody = () => ({
  global: { maxConcurrent: 4, auto: true, inFlight: 0, waiting: 0 },
  streams: { maxStreams: 8, maxStreamsPerDevice: 1, active: 0, perDevice: {} },
  idleSessions: [],
  devices: [],
  transport: { connections: 1, bufferedBytesMax: 0, bufferedBytesP95: 0, videoBytesPerSec: 100_000, controlReplyMsP50: 0, controlReplyMsP95: 0, watchdogReconnects: 0 },
  hostAdb: { running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 0 },
  adbHealth: { status: 'ok', versionRttMs: 1, lastCheckedAt: 0, window: { seconds: 60, execs: 0, timeouts: 0, timeoutRate: 0 }, wedged: [], stuckOffline: [], symptoms: [], restartAdvised: false },
  video: { controlStreams: 1, wallStreams: 12, buildsRunning: 0, buildQueueDepth: 0, maxConcurrentBuilds: 2, maxTiles: 25, maxTilesAuto: true, transport: 'loopback' },
})

/** A minimal stand-in for `FarmForm`'s own `draft`/`onChange`/`dirty` state, so this file exercises the real component against real (controlled) draft edits rather than a static snapshot. */
function Harness({ initial = farmSettings }: { initial?: Record<string, unknown> }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(initial)
  return (
    <FarmVideoFields
      schema={videoSectionSchema}
      draft={draft}
      onChange={(v) => setDraft(v as Record<string, unknown>)}
      onSubmit={() => {}}
      onReset={() => setDraft(initial)}
      busy={false}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
    />
  )
}

describe('FarmVideoFields (plan 92 §3.6, §3.9, §5 step 92.8)', () => {
  test('both preset dropdowns are always visible; the six number fields stay collapsed until Advanced is opened', () => {
    renderWithApi(<Harness />, { '/api/adb/stats': () => ({ body: statsBody() }) })
    expect(screen.getByText('Device page picture')).toBeTruthy()
    expect(screen.getByText('Wall tile picture')).toBeTruthy()
    expect(screen.queryByText('Device page size (px)')).toBeNull()
    expect(screen.queryByText('Wall tile bitrate')).toBeNull()
  })

  test('opening Advanced reveals all six number fields, with today\'s pinned defaults', () => {
    renderWithApi(<Harness />, { '/api/adb/stats': () => ({ body: statsBody() }) })
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(screen.getByText('Device page size (px)')).toBeTruthy()
    expect(screen.getByDisplayValue('1600')).toBeTruthy()
    expect(screen.getByDisplayValue('1100000')).toBeTruthy() // wallBitRate — plan 100 step 100.8 revised default (was 900000, before that 800000)
  })

  test('the readout names "preset" for an untouched farm, and the projection line matches the plan 100 §3.4/§4.1/step 100.8 default (24 tiles ≈ 26.4 Mbit/s, decode-bound on loopback — step 100.3)', () => {
    renderWithApi(<Harness />, { '/api/adb/stats': () => ({ body: statsBody() }) })
    expect(screen.getAllByText(/Sharp preset/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Balanced preset/).length).toBeGreaterThan(0)
    // Plan 100 step 100.3: before the live `/api/adb/stats` poll resolves,
    // the projection defaults to `loopback` (this farm's own generous
    // `wall.bandwidthBps`, 200 Mbit/s) rather than the old WAN-only 20
    // Mbit/s constant — computeAutoTiles(1_100_000, { decodeTileCeiling: 24,
    // bandwidthBps: 200_000_000 }) = min(24, floor(200_000_000/1_100_000)) =
    // min(24, 181) = 24 — the decode ceiling binds, not bandwidth.
    expect(screen.getByText(/24 live tiles/)).toBeTruthy()
    expect(screen.getByText(/26\.4 Mbit\/s/)).toBeTruthy()
    expect(screen.getByText(/decode-bound, loopback/)).toBeTruthy()
  })

  test('a customized number reads "customized" in the readout, and the projection moves with it', () => {
    const customized = { ...farmSettings, video: { ...(farmSettings.video as Record<string, unknown>), wallBitRate: 1_500_000 } }
    renderWithApi(<Harness initial={customized} />, { '/api/adb/stats': () => ({ body: statsBody() }) })
    expect(screen.getAllByText('customized').length).toBeGreaterThan(0)
    // Plan 100 step 100.3: computeAutoTiles(1_500_000, { decodeTileCeiling: 24,
    // bandwidthBps: 200_000_000 }) = min(24, floor(200_000_000/1_500_000)) =
    // min(24, 133) = 24 — still decode-bound, unlike the pre-100.3 WAN-only
    // constant's 13.
    expect(screen.getByText(/24 live tiles/)).toBeTruthy()
  })

  test('Reset to preset restores the six number fields to the selected preset\'s own numbers', () => {
    const customized = {
      ...farmSettings,
      video: { ...(farmSettings.video as Record<string, unknown>), controlMaxSize: 1920, wallBitRate: 1_500_000 },
    }
    renderWithApi(<Harness initial={customized} />, { '/api/adb/stats': () => ({ body: statsBody() }) })
    // Already open: a customized farm pre-opens Advanced on mount, so an
    // operator who changed something sees it immediately, without a click.
    expect(screen.getByDisplayValue('1920')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset to preset' }))
    expect(screen.queryByDisplayValue('1920')).toBeNull()
    expect(screen.getByDisplayValue('1600')).toBeTruthy()
    expect(screen.getByDisplayValue('1100000')).toBeTruthy()
  })

  test('Apply to live sessions POSTs /api/video/reprofile and resolves the skipped devices\' labels (plan 92 §3.8, this step\'s own "name the skipped devices")', async () => {
    const { apiMock } = renderWithApi(<Harness />, {
      '/api/adb/stats': () => ({ body: statsBody() }),
      '/api/video/reprofile': { body: { restarted: ['d1'], skippedBusy: ['d2'], unchanged: 3 } },
      '/api/devices/refs*': { body: { refs: { d2: { id: 'd2', label: 'moto g06 — rack 1', stableId: 'ZP2222', deleted: false } } } },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply to live sessions/ }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/video/reprofile')).toBe(true))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path.startsWith('/api/devices/refs'))).toBe(true))
    const refsCall = apiMock.calls.find((c) => c.path.startsWith('/api/devices/refs'))
    expect(refsCall?.path).toContain('d2')
  })

  test('Apply to live sessions does not fetch device refs when nothing was skipped', async () => {
    const { apiMock } = renderWithApi(<Harness />, {
      '/api/adb/stats': () => ({ body: statsBody() }),
      '/api/video/reprofile': { body: { restarted: ['d1', 'd2'], skippedBusy: [], unchanged: 0 } },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply to live sessions/ }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/video/reprofile')).toBe(true))
    expect(apiMock.calls.some((c) => c.path.startsWith('/api/devices/refs'))).toBe(false)
  })

  test('the measured block polls /api/adb/stats and shows the actually-applied live-tile budget, plus its transport classification (plan 100 §3.1, §4.1, step 100.3)', async () => {
    const { container } = renderWithApi(<Harness />, { '/api/adb/stats': () => ({ body: statsBody() }) })
    await waitFor(() => expect(container.textContent).toContain('12 wall'))
    expect(container.textContent).toContain('(auto — loopback)')
  })
})
