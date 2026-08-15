import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { FarmSettingsSchema } from '@enkaku/protocol'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ScriptDetailPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const script = {
  id: 'script-1',
  name: 'checkout',
  version: '1.0.0',
  kind: 'script',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
}

function baseResponses(scriptResponse: { status?: number; body?: unknown }) {
  return {
    '/api/scripts/script-1': scriptResponse,
    '/api/scripts/checkout/versions': { body: { items: [] } },
    '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
  }
}

describe('ScriptDetailPage — smoke render', () => {
  test('loaded: shows the script name', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(<ScriptDetailPage />, baseResponses({ body: { script } }))
    await waitFor(() => expect(screen.getByText('checkout')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the script loads', () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(<ScriptDetailPage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed script fetch shows a named error with a retry', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(
      <ScriptDetailPage />,
      baseResponses({ status: 500, body: { error: { code: 'E_INTERNAL', message: 'script boom' } } }),
    )
    await waitFor(() => expect(screen.getByText('script boom')).toBeTruthy())
  })

  test('no id in the URL: shows a named message instead of crashing', () => {
    setSearchParams({})
    renderWithApi(<ScriptDetailPage />, {})
    expect(screen.getByText('The address is missing an id parameter.')).toBeTruthy()
  })
})

/**
 * A real, schema-defaulted `settings` body for `GET /api/settings` — the
 * same `FarmSettingsSchema.parse({...})` convention `app/jobs/detail/
 * page.test.tsx`'s own `settingsResponse` helper uses, so a required field
 * this fixture does not mention still resolves through its own default
 * rather than failing `SettingsResponseSchema.safeParse`.
 */
function settingsResponse(memory: { defaultMaxRssBytes?: number | null; maxRssBytes?: number | null }, maxTimeoutMs: number | null = null) {
  return {
    body: {
      settings: FarmSettingsSchema.parse({
        job: { maxTimeoutMs, memory: { defaultMaxRssBytes: memory.defaultMaxRssBytes ?? null, maxRssBytes: memory.maxRssBytes ?? null } },
      }),
      schema: {},
      deviceSchema: {},
    },
  }
}

/**
 * Plan 98 §3.9 item 3, §5 step 98.8 — the Runtime card's origin labels: the
 * SAME honesty requirement the video settings step shipped ("an operator who
 * sets a number and sees no effect must be able to see which layer won").
 */
describe('ScriptDetailPage — the Runtime card (plan 98 §3.9 item 3, §5 step 98.8)', () => {
  test('no runtime declared and no farm default: reads "built-in default" / "farm default", never "script"', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(
      <ScriptDetailPage />,
      { ...baseResponses({ body: { script } }), '/api/settings': settingsResponse({}) },
    )
    await waitFor(() => expect(screen.getByText('Runtime')).toBeTruthy())
    expect(screen.getByText('No limit')).toBeTruthy()
    // Timeout ALWAYS resolves to a real farm number (`job.defaultTimeoutMs`
    // has no "unset" state) — it alone reads "farm default"; memory/retries/
    // maxConcurrent/sdk have nothing declared anywhere and read "built-in
    // default" instead (`runtime-readout.ts`'s own `originFor`).
    expect(screen.getByText('farm default')).toBeTruthy()
    expect(screen.getAllByText('built-in default').length).toBe(4)
    expect(screen.queryByText('clamped to the farm ceiling')).toBeNull()
  })

  test('a script declaration under the farm ceiling reads "declared by the script"', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(
      <ScriptDetailPage />,
      {
        ...baseResponses({ body: { script: { ...script, runtime: { timeoutMs: 120_000, maxRssBytes: 268_435_456 } } } }),
        '/api/settings': settingsResponse({ maxRssBytes: 1_073_741_824 }, 600_000),
      },
    )
    await waitFor(() => expect(screen.getByText('Runtime')).toBeTruthy())
    expect(screen.getAllByText('declared by the script').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('256.0 MB')).toBeTruthy()
  })

  test('a script declaration OVER the farm ceiling reads "clamped to the farm ceiling" and names both numbers — a clamp is not a rejection', async () => {
    setSearchParams({ id: 'script-1' })
    renderWithApi(
      <ScriptDetailPage />,
      {
        ...baseResponses({ body: { script: { ...script, runtime: { timeoutMs: 600_000 } } } }),
        '/api/settings': settingsResponse({}, 60_000),
      },
    )
    await waitFor(() => expect(screen.getByText('Runtime')).toBeTruthy())
    expect(screen.getByText('clamped to the farm ceiling')).toBeTruthy()
    // The resolved (clamped) value shown is the CEILING, not the ask.
    expect(screen.getByText('1 min')).toBeTruthy()
    expect(screen.getByText(/the script asked for 10 min/)).toBeTruthy()
  })
})
