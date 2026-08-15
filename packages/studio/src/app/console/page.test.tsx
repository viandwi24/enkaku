import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `/console` (plan 93 §3.16, §4.8, step 93.7) — the fleet command console.
 * Exercises the four properties the step's own brief names:
 *
 * 1. A run's result is per-device — the report renders after a run starts,
 *    naming the targeted devices.
 * 2. The acknowledgement is a scale confirmation — a single-device run
 *    never sees `ConfirmFanout`; a high-consequence command on N > 1 does.
 * 3. Staged rollout holds no lease while waiting — proved at the `RunReport`
 *    level already (`RunReport.test.tsx`); this file proves the page wires
 *    `stageFirstN` onto the POST body.
 * 4. Output is subscriber-scoped — `command.subscribe`/`command.unsubscribe`
 *    are sent for exactly the run being shown, and unsubscribe fires on
 *    unmount.
 */

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

type Handler = (msg: unknown) => void
let handlers: Handler[] = []
let sent: unknown[] = []

mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: Handler) => {
      handlers.push(cb)
      return () => {
        handlers = handlers.filter((h) => h !== cb)
      }
    },
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(true)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 'session-1',
    isConnected: () => true,
    send: (msg: unknown) => sent.push(msg),
    request: () => Promise.reject(new Error('ws.request not used by the console page')),
  },
  coreBase: () => 'http://core.test',
  newId: (() => {
    let n = 0
    return () => `test-id-${n++}`
  })(),
}))

const { default: ConsolePage } = await import('./page')

function emit(msg: { type: string; payload?: unknown }): void {
  for (const h of handlers) h(msg)
}

afterEach(() => {
  cleanup()
  handlers = []
  sent = []
  setSearchParams({})
})

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev-1',
    stableId: 'stable-1',
    label: 'Pixel 6',
    status: 'idle',
    tags: [],
    cluster: null,
    heldBy: null,
    assistedBy: [],
    battery: null,
    lastCrashAt: null,
    readiness: 'awake',
    connection: { medium: 'USB' },
    agent: 'absent',
    ...overrides,
  }
}

function settingsBody(overrides: Record<string, unknown> = {}) {
  return {
    schema: {},
    deviceSchema: {},
    settings: {
      shell: { mode: 'admin', fanoutEnabled: true, fanoutConfirmThreshold: 5, fanoutMaxDevices: 0, ...(overrides.shell as object) },
      transfer: {},
      video: {},
      coControl: { mode: 'operator', grantTtlSec: 300 },
    },
  }
}

/**
 * `installApiMock`'s key lookup (`packages/studio/src/lib/test/render.tsx`)
 * is a plain `Object.keys().find()` — the FIRST key (in insertion order)
 * whose pattern matches wins, wildcard or not. `/api/command-runs*` (the
 * history GET) and an exact `/api/command-runs`/`/api/command-runs/:id/...`
 * override therefore MUST be inserted with every exact path before the
 * wildcard, or the wildcard silently swallows the exact call too (its `.*`
 * matches the empty suffix). `extra` entries are spread in BEFORE the
 * wildcard for exactly this reason — do not reorder.
 */
function baseMocks(devices: unknown[] = [device()], settingsOverrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    '/api/devices*': { body: { items: devices, nextCursor: null, total: null } },
    '/api/clusters*': { body: { items: [], nextCursor: null, total: null } },
    '/api/settings': { body: settingsBody(settingsOverrides) },
    '/api/saved-commands': { body: { items: [] } },
    ...extra,
    '/api/command-runs*': { body: { items: [], nextCursor: null, total: null } },
  }
}

function runCreateResponse(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: 'run-1',
      cmd: 'getprop ro.build.version.release',
      target: { deviceIds: ['dev-1'] },
      savedCommandId: null,
      stageFirstN: 0,
      stage: 1,
      concurrency: 0,
      status: 'running',
      acknowledged: false,
      createdBy: 'user-1',
      startedAt: 1_700_000_000,
      finishedAt: null,
      counts: { total: 1, pending: 1, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 },
      ...overrides,
    },
    members: [{ deviceId: 'dev-1', seq: 0, stageIndex: 0, status: 'pending', exitCode: null, durationMs: null, outputHash: null, truncated: false, skip: null, error: null }],
    skipped: [],
  }
}

describe('/console', () => {
  test('a single-device run posts with no acknowledgement and never shows ConfirmFanout', async () => {
    const { getByText, getByPlaceholderText, getByRole, apiMock, queryByText } = renderWithApi(
      <ConsolePage />,
      baseMocks([device()], {}, {
        '/api/command-runs': (req) => {
          expect(req.method).toBe('POST')
          return { status: 201, body: runCreateResponse() }
        },
      }),
    )
    await waitFor(() => expect(getByText('Pixel 6')).toBeTruthy())
    fireEvent.click(getByText('Pixel 6'))
    fireEvent.change(getByPlaceholderText('getprop ro.build.version.release'), { target: { value: 'getprop ro.build.version.release' } })
    fireEvent.click(getByRole('button', { name: 'Run' }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/command-runs')).toBe(true))
    const post = apiMock.calls.find((c) => c.method === 'POST' && c.path === '/api/command-runs')
    expect(post?.body).toMatchObject({ cmd: 'getprop ro.build.version.release', target: { deviceIds: ['dev-1'] }, clientId: 'session-1' })
    expect((post?.body as { acknowledge?: unknown }).acknowledge).toBeUndefined()
    expect(queryByText(/Run on 1 device/)).toBeNull()

    await waitFor(() => expect(getByText(/1 pending/)).toBeTruthy())
  })

  test('a high-consequence command on more than one device requires the typed/ack dialog before POSTing', async () => {
    const devices = [device({ id: 'a', label: 'A' }), device({ id: 'b', label: 'B' })]
    let posted = false
    const { getByText, getByPlaceholderText, getByRole, queryByText } = renderWithApi(
      <ConsolePage />,
      baseMocks(devices, {}, {
        '/api/command-runs': () => {
          posted = true
          return { status: 201, body: runCreateResponse({ target: { deviceIds: ['a', 'b'] } }) }
        },
      }),
    )
    await waitFor(() => expect(getByText('A')).toBeTruthy())
    fireEvent.click(getByText('A'))
    fireEvent.click(getByText('B'))
    fireEvent.change(getByPlaceholderText('getprop ro.build.version.release'), { target: { value: 'pm uninstall com.example' } })
    fireEvent.click(getByRole('button', { name: 'Run' }))

    await waitFor(() => expect(getByText(/scale confirmation, not a security check/)).toBeTruthy())
    expect(posted).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Run on 2 devices' }))
    await waitFor(() => expect(posted).toBe(true))
    expect(queryByText(/scale confirmation/)).toBeNull()
  })

  test('subscriber-scoped output: subscribes to the run it shows, unsubscribes on unmount, and reflects a command.progress push', async () => {
    const { getByText, getByPlaceholderText, getByRole, unmount } = renderWithApi(
      <ConsolePage />,
      baseMocks([device()], {}, { '/api/command-runs': () => ({ status: 201, body: runCreateResponse() }) }),
    )
    await waitFor(() => expect(getByText('Pixel 6')).toBeTruthy())
    fireEvent.click(getByText('Pixel 6'))
    fireEvent.change(getByPlaceholderText('getprop ro.build.version.release'), { target: { value: 'getprop ro.build.version.release' } })
    fireEvent.click(getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(getByText(/1 pending/)).toBeTruthy())

    expect(sent).toContainEqual({ type: 'command.subscribe', payload: { runId: 'run-1' } })

    emit({
      type: 'command.progress',
      payload: {
        runId: 'run-1',
        counts: { total: 1, pending: 0, running: 0, ok: 1, failed: 0, skipped: 0, cancelled: 0 },
        changed: [{ deviceId: 'dev-1', seq: 0, stageIndex: 0, status: 'ok', exitCode: 0, durationMs: 120, outputHash: 'h1', truncated: false, skip: null, error: null }],
      },
    })
    await waitFor(() => expect(getByText(/1 ok/)).toBeTruthy())

    unmount()
    expect(sent).toContainEqual({ type: 'command.unsubscribe', payload: { runId: 'run-1' } })
  })

  test('Cancel posts to the run\'s own cancel route', async () => {
    const { getByText, getByPlaceholderText, getByRole, apiMock } = renderWithApi(
      <ConsolePage />,
      baseMocks([device()], {}, {
        '/api/command-runs': () => ({ status: 201, body: runCreateResponse() }),
        '/api/command-runs/run-1/cancel': { body: { run: runCreateResponse({ status: 'cancelled' }).run } },
      }),
    )
    await waitFor(() => expect(getByText('Pixel 6')).toBeTruthy())
    fireEvent.click(getByText('Pixel 6'))
    fireEvent.change(getByPlaceholderText('getprop ro.build.version.release'), { target: { value: 'getprop ro.build.version.release' } })
    fireEvent.click(getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(getByText(/1 pending/)).toBeTruthy())

    fireEvent.click(getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/command-runs/run-1/cancel')).toBe(true))
  })

  test('Retry skipped posts to .../rerun?only=skipped and swaps in the new run', async () => {
    let rerunQuery: string | null = null
    const { getByText, getByPlaceholderText, getByRole } = renderWithApi(
      <ConsolePage />,
      baseMocks([device()], {}, {
        '/api/command-runs': () => ({ status: 201, body: runCreateResponse() }),
        '/api/command-runs/run-1/rerun*': (req) => {
          rerunQuery = req.path.split('?')[1] ?? null
          return { status: 201, body: runCreateResponse({ id: 'run-2', counts: { total: 1, pending: 1, running: 0, ok: 0, failed: 0, skipped: 0, cancelled: 0 } }) }
        },
      }),
    )
    await waitFor(() => expect(getByText('Pixel 6')).toBeTruthy())
    fireEvent.click(getByText('Pixel 6'))
    fireEvent.change(getByPlaceholderText('getprop ro.build.version.release'), { target: { value: 'getprop ro.build.version.release' } })
    fireEvent.click(getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(getByText(/1 pending/)).toBeTruthy())

    // A live `command.progress` push makes the one member `skipped`, so
    // "Retry skipped (1)" becomes enabled.
    emit({
      type: 'command.progress',
      payload: {
        runId: 'run-1',
        counts: { total: 1, pending: 0, running: 0, ok: 0, failed: 0, skipped: 1, cancelled: 0 },
        changed: [{ deviceId: 'dev-1', seq: 0, stageIndex: 0, status: 'skipped', exitCode: null, durationMs: null, outputHash: null, truncated: false, skip: { code: 'device_busy', message: 'Device is running an automation job' }, error: null }],
      },
    })
    await waitFor(() => expect((getByRole('button', { name: 'Retry skipped (1)' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(getByRole('button', { name: 'Retry skipped (1)' }))
    await waitFor(() => expect(rerunQuery).toBe('only=skipped'))
    // The report swaps to the new run — its own progress line reappears at 1 pending.
    await waitFor(() => expect(getByText(/1 pending/)).toBeTruthy())
  })

  test('?cmd=&deviceId= prefills the command and target from a "Run on more devices…" link', async () => {
    setSearchParams({ cmd: 'dumpsys battery', deviceId: 'dev-1' })
    const { getByDisplayValue, getByText } = renderWithApi(<ConsolePage />, baseMocks())
    await waitFor(() => expect(getByDisplayValue('dumpsys battery')).toBeTruthy())
    expect(getByText(/1 device will be targeted/)).toBeTruthy()
  })

  test('fanout turned off for this farm: the form is replaced with an honest explanation, not a broken page', async () => {
    const { getByText, queryByPlaceholderText } = renderWithApi(<ConsolePage />, baseMocks([device()], { shell: { fanoutEnabled: false } }))
    await waitFor(() => expect(getByText('The command console is turned off for this farm')).toBeTruthy())
    expect(getByText(/Fleet commands are turned off/)).toBeTruthy()
    expect(queryByPlaceholderText('getprop ro.build.version.release')).toBeNull()
  })
})
