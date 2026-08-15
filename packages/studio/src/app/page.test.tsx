import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { AuthContext, type AuthState } from '@/lib/auth'
import { readLocalPrefs, writeSessionPrefs } from '@/lib/prefs'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { DeviceInfo } from '@enkaku/protocol'

/**
 * `WallTile` mounts `LiveView` (a WebCodecs video decoder over a live WS
 * stream) for every tile — not this file's concern, which is the DASHBOARD's
 * own wiring: does selection survive a view switch (plan 91 §5 step 91.8,
 * F11), does double-clicking a mocked tile push `?focus=` onto the URL. The
 * mock exposes just enough surface (data attributes plus two buttons) for
 * that, the same shape `Wall.test.tsx` already established for its own
 * wiring tests.
 */
mock.module('@/components/wall/WallTile', () => ({
  WallTile: ({
    device,
    selectable,
    selected,
    onToggleSelect,
    focused,
    onFocus,
  }: {
    device: DeviceInfo
    selectable?: boolean
    selected?: boolean
    onToggleSelect?: () => void
    focused?: boolean
    onFocus?: () => void
  }) => (
    <div data-testid={`tile-${device.id}`} data-selectable={String(!!selectable)} data-selected={String(!!selected)} data-focused={String(!!focused)}>
      {device.label}
      <button type="button" aria-label={`toggle-${device.id}`} onClick={onToggleSelect} />
      <button type="button" aria-label={`focus-${device.id}`} onClick={onFocus} />
    </div>
  ),
}))

/**
 * The fleet page (`app/page.tsx`) subscribes to `ws.on` on mount for live
 * device/job updates — no real `WebSocket` in `happy-dom`, so `@/lib/ws` is
 * replaced (also covers `coreBase()`, which every `fetch` on this page
 * reads through, directly or via `@/lib/api`'s helpers).
 *
 * `on`'s callback is captured into `wsListener` (rather than the plain
 * no-op the rest of this file used before) so the "assist.changed updates
 * live" tests below can push a broadcast at the page exactly like a real
 * `ws` message would arrive, without a real WebSocket or a refetch.
 */
let wsListener: ((m: { type: string; payload: unknown }) => void) | null = null
/**
 * Captured the same way `wsListener` above is, for the "reconnect resyncs
 * via `load()`" test below (plan 99 §4.9, §4.11, step 99.10) — there is no
 * WS snapshot replay (CLAUDE.md), so a message broadcast while this tab was
 * disconnected only ever reaches the page through this callback firing.
 */
let reconnectListener: (() => void) | null = null
mock.module('@/lib/ws', () => ({
  ws: {
    on: (cb: (m: { type: string; payload: unknown }) => void) => {
      wsListener = cb
      return () => {
        wsListener = null
      }
    },
    send: () => {},
    onReconnected: (cb: () => void) => {
      reconnectListener = cb
      return () => {
        reconnectListener = null
      }
    },
    getSessionId: () => null,
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

/** Delivers a fake `ws` message to whatever listener the page registered, wrapped in `act` (same pattern `DeviceLog.test.tsx` uses). */
function emit(msg: { type: string; payload: unknown }): void {
  act(() => {
    wsListener?.(msg)
  })
}

/** Fires the page's `ws.onReconnected` callback, as if the socket just came back. */
function emitReconnect(): void {
  act(() => {
    reconnectListener?.()
  })
}

const { default: Dashboard } = await import('./page')

/**
 * Plan 92 §3.10, §4.9 — `view` lives in `sessionStorage`, which happy-dom
 * registers once for the whole file (`packages/studio/happydom.ts`) and
 * does NOT reset between individual `test()`s the way `cleanup()` resets
 * the DOM or `mockRouter.replace.mockClear()` resets the router spy. Every
 * test in this file that does not care about the view default explicitly
 * (the large majority, unchanged by plan 92) still needs a clean slate, or
 * an earlier test picking List would silently change what a LATER test's
 * fresh `<Dashboard />` opens on. `localStorage` (tile size) is cleared for
 * the same reason.
 */
afterEach(() => {
  cleanup()
  mockRouter.replace.mockClear()
  sessionStorage.clear()
  localStorage.clear()
})

const device = {
  id: 'dev-1',
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
  androidVersion: '15',
  apiLevel: 35,
  screenW: 720,
  screenH: 1600,
  density: 280,
  status: 'idle',
  lastSeen: 1,
  battery: null,
  quarantineReason: null,
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  connection: { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null },
}

const baseResponses = {
  // `fetchAllPages` (`@/lib/api`) always appends `?limit=200[&cursor=...]` —
  // the wildcard has to start after the literal `?` so it does not also
  // swallow `/api/devices/discovered` below.
  '/api/devices?*': { body: { items: [device], nextCursor: null, total: 1 } },
  '/api/jobs*': { body: { items: [] } },
  '/api/clusters?*': { body: { items: [], nextCursor: null, total: 0 } },
  '/api/devices/discovered': { body: { discovered: [] } },
  // The Wall now renders by default (plan 92 §9 Q1) and fetches this on
  // mount for `wall.maxTiles` — mocked so that fetch never 404s across the
  // many tests below that render on the Wall incidentally rather than by
  // intent.
  '/api/settings': { body: { settings: { wall: { maxTiles: 8 } }, schema: {}, deviceSchema: {} } },
}

describe('Dashboard (fleet page)', () => {
  test('loaded: renders a card for each device', async () => {
    const { getByText } = renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
  })

  test('loading: shows the loading rows before the devices fetch resolves', () => {
    const { container } = renderWithApi(<Dashboard />, {}, { unmatched: 'pending' })
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed devices fetch shows a named error, not a blank page', async () => {
    // `fetchDevices` (`@/lib/api`, out of this plan's scope) throws a plain
    // `Error` on a non-OK response — not `api()`'s `{error:{code,message}}`
    // unwrapping — so that literal message is what the page's `ErrorState` shows.
    const { getByText } = renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/devices?*': { status: 500 },
    })
    await waitFor(() => expect(getByText('GET /api/devices → 500')).toBeTruthy())
  })
})

/**
 * The connection filter (plan 88 §3.1, §4.1, F5) — beside the existing
 * status/tag/cluster/readiness filters, same client-side mechanism (this
 * page never sends any of those to the server either; see the type's own
 * comment on `page.tsx`). `network` is the coarse "everything not on USB"
 * bucket; `otg`/`wifi`/`tcp` are the exact badge values.
 */
describe('Dashboard — connection filter', () => {
  const usbDevice = { ...device, id: 'dev-usb', label: 'usb phone' }
  const otgDevice = {
    ...device,
    id: 'dev-otg',
    label: 'otg phone',
    serial: '10.20.0.37:5555',
    connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.20.0.37', port: 5555, networkLabel: 'Chassis A' },
  }
  const wifiDevice = {
    ...device,
    id: 'dev-wifi',
    label: 'wifi phone',
    serial: '192.168.1.51:5555',
    connection: { kind: 'tcp', medium: 'wireless', mediumSource: 'declared', address: '192.168.1.51', port: 5555, networkLabel: null },
  }
  const responses = {
    ...baseResponses,
    '/api/devices?*': { body: { items: [usbDevice, otgDevice, wifiDevice], nextCursor: null, total: 3 } },
  }

  test('"On the network" keeps every non-USB device and drops the USB one', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('usb phone')).toBeTruthy())
    expect(screen.getByText('otg phone')).toBeTruthy()
    expect(screen.getByText('wifi phone')).toBeTruthy()

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by connection' }))
    fireEvent.click(await screen.findByRole('option', { name: 'On the network' }))

    await waitFor(() => expect(screen.queryByText('usb phone')).toBeNull())
    expect(screen.getByText('otg phone')).toBeTruthy()
    expect(screen.getByText('wifi phone')).toBeTruthy()
  })

  test('"OTG" narrows to exactly the wired-network device, not the Wi-Fi one', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('otg phone')).toBeTruthy())

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by connection' }))
    fireEvent.click(await screen.findByRole('option', { name: 'OTG' }))

    await waitFor(() => expect(screen.queryByText('wifi phone')).toBeNull())
    expect(screen.queryByText('usb phone')).toBeNull()
    expect(screen.getByText('otg phone')).toBeTruthy()
  })

  /**
   * The search box gains the address (plan 92 §4.8): an operator chasing a
   * connection problem usually has the IP in hand, not the label. USB has no
   * address at all (`null`), so it must never match a query typed for the
   * other two devices' — proving the search does not accidentally match on
   * something else.
   */
  test('searching an IP finds the device whose connection has it, and nothing else', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('wifi phone')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Search name or serial…'), { target: { value: '192.168.1.51' } })

    await waitFor(() => expect(screen.queryByText('usb phone')).toBeNull())
    expect(screen.queryByText('otg phone')).toBeNull()
    expect(screen.getByText('wifi phone')).toBeTruthy()
  })
})

/**
 * `device.quarantine` (`packages/core/src/auth/acl.ts`, admin-only) gates
 * `POST /:id/unquarantine` — wired here through `DeviceCard`'s
 * `canReleaseQuarantine` prop (see `DeviceCard.test.tsx` for that prop's own
 * unit tests). This is the integration point: does the dashboard actually
 * compute it from the signed-in user and pass it down.
 */
describe('Dashboard — "Return to queue" reflects device.quarantine (admin-only)', () => {
  const quarantined = { ...device, id: 'dev-2', label: 'quarantined phone', status: 'quarantined', quarantineReason: 'thermal:49.8C' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [quarantined], nextCursor: null, total: 1 } } }

  // Not what this describe block is about — the quarantine button lives on
  // `DeviceCard`, which only List renders. The Wall is the new default
  // (plan 92 §9 Q1), so this pins the view explicitly rather than relying
  // on it.
  beforeEach(() => setSearchParams({ view: 'list' }))

  function authValue(overrides: Partial<AuthState>): AuthState {
    return { user: null, authMode: 'server', setupNeeded: false, refresh: async () => {}, logout: async () => {}, ...overrides }
  }

  test('operator: the button is on screen but disabled', async () => {
    renderWithApi(
      <AuthContext.Provider value={authValue({ user: { id: 'u1', email: 'op@x.com', role: 'operator' } })}>
        <Dashboard />
      </AuthContext.Provider>,
      responses,
    )
    const button = (await waitFor(() => screen.getByRole('button', { name: /return to queue/i }))) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  test('admin: the button is enabled', async () => {
    renderWithApi(
      <AuthContext.Provider value={authValue({ user: { id: 'u1', email: 'admin@x.com', role: 'admin' } })}>
        <Dashboard />
      </AuthContext.Provider>,
      responses,
    )
    const button = (await waitFor(() => screen.getByRole('button', { name: /return to queue/i }))) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  test('local mode (implicit admin): unaffected', async () => {
    renderWithApi(
      <AuthContext.Provider value={authValue({ authMode: 'local', user: { id: 'local-admin', email: 'admin@localhost', role: 'admin' } })}>
        <Dashboard />
      </AuthContext.Provider>,
      responses,
    )
    const button = (await waitFor(() => screen.getByRole('button', { name: /return to queue/i }))) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})

/**
 * `assist.changed` (plan 91 §3.4 item 4, F25 — gap 1). Before this the
 * dashboard's `ws.on` handler had a `lease.changed` branch that patched
 * `heldBy` live but no equivalent for `assist.changed`, so a device being
 * assisted right now showed nothing on the Wall/list until the next full
 * `/api/devices` fetch. Same live-patch shape, proven the same way
 * `lease.changed` would be, via the captured `wsListener`.
 */
describe('Dashboard — assist.changed patches assistedBy live (plan 91 §3.4 item 4, F25, gap 1)', () => {
  // The badge asserted below is `DeviceCard`'s (List); `WallTile.test.tsx`
  // covers the same live-patch on the Wall directly. The Wall is now the
  // default view (plan 92 §9 Q1), so this pins List explicitly.
  beforeEach(() => setSearchParams({ view: 'list' }))

  test('a broadcast for this device adds the assist badge with no refetch', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByTitle(/Assisting/)).toBeNull()

    emit({
      type: 'assist.changed',
      payload: {
        deviceId: 'dev-1',
        assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }],
      },
    })

    await waitFor(() => expect(screen.getByTitle('Assisting — Alice')).toBeTruthy())
  })

  test('a broadcast for a different device is ignored', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    emit({
      type: 'assist.changed',
      payload: {
        deviceId: 'some-other-device',
        assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }],
      },
    })

    expect(screen.queryByTitle(/Assisting/)).toBeNull()
  })

  test('an empty assistedBy clears a previously-shown badge (grant released/expired)', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    emit({
      type: 'assist.changed',
      payload: {
        deviceId: 'dev-1',
        assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }],
      },
    })
    await waitFor(() => expect(screen.getByTitle('Assisting — Alice')).toBeTruthy())

    emit({ type: 'assist.changed', payload: { deviceId: 'dev-1', assistedBy: [] } })

    await waitFor(() => expect(screen.queryByTitle('Assisting — Alice')).toBeNull())
  })
})

/**
 * `job.status` live merge/removal (plan 99 §4.9, §4.11, step 99.10 — the gap
 * closed here). Before this fix, EVERY `job.status` push called `load()` (a
 * `GET /api/jobs?status=running` refetch validated against `JobInfoSchema`,
 * which has no `node` field) instead of trusting the pushed payload — this
 * proves the actual replacement state semantics the fix relies on, through
 * `DeviceCard`'s own "Running a job — view details" link (real, unmocked in
 * this file) rather than by inspecting `page.tsx`'s internal `jobs` array
 * directly, which is not exposed to a test. The link's `href` carries the
 * job id (`/jobs/detail?id=<jobId>`), which is what lets each assertion
 * below tell one job apart from another.
 */
describe('Dashboard — job.status live merge/removal (plan 99 §4.9, §4.11, step 99.10)', () => {
  // The "Running a job" link asserted below is `DeviceCard`'s (List) — the
  // Wall is now the default view (plan 92 §9 Q1), so this pins it explicitly.
  beforeEach(() => setSearchParams({ view: 'list' }))

  const deviceA = { ...device, id: 'dev-a', label: 'device A', status: 'busy' }
  const deviceB = { ...device, id: 'dev-b', label: 'device B', status: 'busy' }

  const baseJob = {
    scriptId: 'wf-1',
    scriptName: 'pipeline',
    scriptVersion: '1.0.0',
    status: 'running',
    error: null,
    priority: 0,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
    batchId: null,
    batchSeq: null,
    expiresAt: null,
    errorPhase: null,
    failureClass: null,
    triggeredByJobId: null,
    rootJobId: null,
    depth: 0,
    peakRssBytes: null,
    assistCount: 0,
  }

  function jobHrefs(): string[] {
    return screen
      .getAllByRole('link', { name: /Running a job/ })
      .map((el) => el.getAttribute('href'))
      .sort() as string[]
  }

  test('append on a new running job, replace an existing one in place (without disturbing a sibling device), and remove on a non-running push', async () => {
    renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/devices?*': { body: { items: [deviceA, deviceB], nextCursor: null, total: 2 } },
    })
    await waitFor(() => expect(screen.getByText('device A')).toBeTruthy())
    expect(screen.queryAllByRole('link', { name: /Running a job/ })).toHaveLength(0)

    // A push for a device with no prior job APPENDS it.
    emit({ type: 'job.status', payload: { ...baseJob, jobId: 'job-a', deviceId: 'dev-a', status: 'running' } })
    await waitFor(() => expect(jobHrefs()).toEqual(['/jobs/detail?id=job-a']))

    emit({ type: 'job.status', payload: { ...baseJob, jobId: 'job-b', deviceId: 'dev-b', status: 'running' } })
    await waitFor(() => expect(jobHrefs()).toEqual(['/jobs/detail?id=job-a', '/jobs/detail?id=job-b']))

    // A push for an EXISTING job (same jobId) REPLACES it in place: still
    // exactly two links, both unchanged, no third entry. If this had
    // regressed to the old `load()`-refetch behaviour, the static
    // `/api/jobs*` mock (`{items: []}`, from `baseResponses`) would
    // eventually wipe BOTH links — the `setTimeout` below gives that a
    // chance to happen before the final assertion.
    emit({ type: 'job.status', payload: { ...baseJob, jobId: 'job-a', deviceId: 'dev-a', status: 'running', scriptVersion: '2.0.0' } })
    await waitFor(() => expect(jobHrefs()).toEqual(['/jobs/detail?id=job-a', '/jobs/detail?id=job-b']))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(jobHrefs()).toEqual(['/jobs/detail?id=job-a', '/jobs/detail?id=job-b'])

    // A push whose status is no longer `running` REMOVES it — the sibling device's job is untouched.
    emit({ type: 'job.status', payload: { ...baseJob, jobId: 'job-a', deviceId: 'dev-a', status: 'success' } })
    await waitFor(() => expect(jobHrefs()).toEqual(['/jobs/detail?id=job-b']))
  })

  test('a reconnect re-fetches /api/jobs and replaces the live-merged state with the server\'s answer', async () => {
    let jobsFromServer: unknown[] = []
    renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/devices?*': { body: { items: [deviceA, deviceB], nextCursor: null, total: 2 } },
      '/api/jobs*': () => ({ body: { items: jobsFromServer } }),
    })
    await waitFor(() => expect(screen.getByText('device A')).toBeTruthy())

    // A live push the reconnect refetch below has no knowledge of yet.
    emit({ type: 'job.status', payload: { ...baseJob, jobId: 'job-b', deviceId: 'dev-b', status: 'running' } })
    await waitFor(() => expect(jobHrefs()).toEqual(['/jobs/detail?id=job-b']))

    // A job only the SERVER knows about (never pushed over the mocked `ws`)
    // — the only way it can appear is a real `GET /api/jobs` firing, which
    // is exactly what `ws.onReconnected` is wired to do (there is no WS
    // snapshot replay). `load()` REPLACES the whole list, so `job-b` above
    // (not present in this server response) is expected to disappear too.
    jobsFromServer = [{ ...baseJob, jobId: 'job-c', deviceId: 'dev-a', status: 'running' }]
    emitReconnect()

    await waitFor(() => expect(jobHrefs()).toEqual(['/jobs/detail?id=job-c']))
  })
})

/**
 * Selection on the Wall (plan 91 §3.11/§5 step 91.8, F11, F12): the owner's
 * own words — *"di device list bisa seleksi banyak device, mouse akan ada
 * indikator device yang terseleksi berapa"* — plus double-click setting
 * `?focus=`. `WallTile` is mocked (see the file header) so this file stays
 * about the DASHBOARD's own wiring, not `WallTile`'s click/double-click
 * disambiguation, which `WallTile.test.tsx` already covers directly
 * (including "a single click still navigates").
 */
describe('Dashboard — Wall selection, the cursor badge, and ?focus= (plan 91 §5 step 91.8, F11, F12, F13)', () => {
  const deviceB = { ...device, id: 'dev-2', label: 'pixel 8' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [device, deviceB], nextCursor: null, total: 2 } } }

  // These tests select via `DeviceCard`'s real checkbox (List), then some
  // switch to Wall by hand — they are about the List<->Wall wiring, not
  // about which view opens by default (plan 92 §9 Q1's own test lives
  // below in its own describe block), so this pins the starting view.
  beforeEach(() => setSearchParams({ view: 'list' }))

  test('selection survives a view switch (List -> Wall -> List) — the hand-rolled Set is gone, one array backs both', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))

    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByTestId('tile-dev-1').dataset.selected).toBe('true'))
    expect(screen.getByTestId('tile-dev-2').dataset.selected).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    const checkbox = (await screen.findByRole('checkbox', { name: /moto g06/i })) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  test('the cursor badge names the live selected count', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    expect(screen.queryByText(/selected$/)).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /pixel 8/i }))
    fireEvent.mouseMove(window, { clientX: 50, clientY: 60 })

    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy())
  })

  test('"Select all" selects every filtered device (tri-state, plan 91 §5 step 91.8, F12)', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))

    expect((screen.getByRole('checkbox', { name: /moto g06/i }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /pixel 8/i }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy()
  })

  test('double-clicking a wall tile sets ?focus= on the URL', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('focus-dev-1'))

    expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining('focus=dev-1'))
  })
})

/**
 * Step 92.5's own verifiable result, verbatim: a fresh tab (no `?view=`, no
 * session preference) opens on the Wall; picking List and reloading the
 * SAME tab opens List; a new tab (no shared `sessionStorage`) opens the
 * Wall again unconditionally; `?view=wall` in the URL wins regardless of
 * what the session preference says (plan 92 §3.10, §4.9, §9 Q1, decided
 * 2026-08-12 — there is no `wall.defaultView` farm setting anywhere in this
 * chain). `mockRouter.replace` never actually mutates the `params` the nav
 * mock hands back (`@/lib/test/nav`), so "reload the same tab" and "a new
 * tab" are both simulated by unmounting and rendering a fresh `<Dashboard
 * />` — the SAME `sessionStorage` object for "reload", a cleared one for
 * "new tab" — exactly mirroring what persists and what does not in a real
 * browser.
 */
describe('Dashboard — the Wall is the unconditional front door (plan 92 §3.10, §4.9, §9 Q1, step 92.5)', () => {
  test('a fresh tab, with no ?view= and no session preference, opens on the Wall', async () => {
    setSearchParams({})
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Wall' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false')
  })

  test('picking List, then reloading the SAME tab (sessionStorage persists), opens List again', async () => {
    setSearchParams({})
    const first = renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    await waitFor(() => expect(screen.queryByTestId('tile-dev-1')).toBeNull())
    first.unmount()

    // A reload does not add a `?view=` to the URL — only the tab's own
    // sessionStorage (unchanged since the click above) carries the choice
    // forward.
    setSearchParams({})
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByTestId('tile-dev-1')).toBeNull()
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('a new tab opens the Wall even after this "tab" already picked List', async () => {
    setSearchParams({})
    const first = renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    await waitFor(() => expect(screen.queryByTestId('tile-dev-1')).toBeNull())
    first.unmount()

    // A brand-new tab/window/session does not share sessionStorage with the
    // one that just picked List — simulated by clearing it, which is
    // exactly the real starting state of a new tab.
    sessionStorage.clear()
    setSearchParams({})
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Wall' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('?view=wall in the URL wins over a stored List preference', async () => {
    writeSessionPrefs({ view: 'list' })
    setSearchParams({ view: 'wall' })
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Wall' }).getAttribute('aria-pressed')).toBe('true')
  })
})

/**
 * The Tile size control (plan 92 §3.11, §4.9, step 92.5) — a wall control,
 * not a setting: absent on List (it has no effect there), present on Wall,
 * defaulting to Medium, and a pick persists in `localStorage` (checked via
 * `readLocalPrefs` directly rather than a second storage-key literal).
 */
describe('Dashboard — Tile size control (plan 92 §3.11, §4.9, step 92.5)', () => {
  test('absent on List, present on Wall, defaults to Medium, and picking Large writes localStorage', async () => {
    setSearchParams({ view: 'list' })
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByRole('group', { name: 'Tile size' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Tile size' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Medium tiles' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Large tiles' }))
    expect(screen.getByRole('button', { name: 'Large tiles' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Medium tiles' }).getAttribute('aria-pressed')).toBe('false')
    expect(readLocalPrefs().tileSize).toBe('l')
  })
})

/**
 * Plan 93 §3.16, §4.8, F15, step 93.11 — the three new selection-toolbar
 * actions beside the existing Install/Forget, and `wakeOrSleepSelected`'s
 * own report. F15 named `wakeOrSleepSelected` by name as one of three
 * inconsistent bulk patterns ("emits one anonymous summary toast that never
 * names a failing device") — these tests prove the fix: every refused
 * device is named, not just counted.
 */
describe('Dashboard — Run command / Push / Pull toolbar, and the wake/sleep report (plan 93 §5 step 93.11, F15, H3)', () => {
  const deviceB = { ...device, id: 'dev-2', label: 'pixel 8' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [device, deviceB], nextCursor: null, total: 2 } } }

  beforeEach(() => setSearchParams({ view: 'list' }))

  test('"Run command…" links to /console with every selected device', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /pixel 8/i }))

    const link = screen.getByText('Run command…').closest('a')
    expect(link?.getAttribute('href')).toBe('/console?deviceIds=dev-1,dev-2')
  })

  test('"Push file…" opens BulkTransferDialog in push mode, naming the selection', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Push file…' }))

    await waitFor(() => expect(screen.getByText('Push file to 1 device')).toBeTruthy())
  })

  test('"Pull file…" opens BulkTransferDialog in pull mode', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Pull file…' }))

    await waitFor(() => expect(screen.getByText('Pull file from 1 device')).toBeTruthy())
  })

  test('Wake selected: one refusal names the exact device and reason, never just a count', async () => {
    renderWithApi(<Dashboard />, {
      ...responses,
      '/api/devices/dev-1/readiness': { body: { readiness: device.readiness } },
      '/api/devices/dev-2/readiness': { status: 409, body: { error: { code: 'device_busy', message: 'a job is running on this device' } } },
    })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /pixel 8/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Wake selected' }))

    await waitFor(() => expect(screen.getByText('1 ok · 1 failed · 0 skipped (2/2)')).toBeTruthy())
    // "pixel 8" also appears on its own device card behind the dialog — the
    // point of this assertion is that it is reachable AT ALL from the
    // report, not that it is unique on the page (F15's whole ask).
    expect(screen.getAllByText('pixel 8').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('a job is running on this device')).toBeTruthy()
  })
})

/**
 * "Renumber fleet…" (plan 89 §3.2 point 5, §5 step 89.3) — the fleet-wide
 * compaction, reached from the overflow menu beside "Add device". There is
 * no dry-run endpoint, so the confirm dialog states what the action DOES
 * rather than a count it cannot honestly know yet; the actual count is
 * reported afterward.
 */
describe('Dashboard — Renumber fleet… (plan 89 §3.2 point 5, §5 step 89.3)', () => {
  test('confirming calls POST /api/devices/numbers/compact and refreshes the list', async () => {
    // Radix's `DropdownMenuTrigger` opens on `pointerdown`, not a bare
    // `click` (`app/agents/page.test.tsx`'s own established pattern) —
    // `user-event` handles that; `fireEvent.click` does not.
    const user = userEvent.setup()
    const { apiMock } = renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/devices/numbers/compact': {
        body: { changed: [{ stableId: 'ZP2222RMBS', from: 3, to: 1 }], relabelled: 1, failed: [] },
      },
    })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'More fleet actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Renumber fleet…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Renumber' }))

    await waitFor(() =>
      expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/devices/numbers/compact')).toBe(true),
    )
    // The list is reloaded after a successful compaction — the same devices
    // fetch fires again rather than trusting stale numbers on screen.
    expect(apiMock.calls.filter((c) => c.path.startsWith('/api/devices?')).length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * "Apply labels" (plan 89 §3.7 point 3, §5 step 89.8) — the multi-select
 * toolbar's fleet-wide switch-on. `POST /api/devices/labels/apply` answers
 * synchronously with a per-device report; the same outcome-first,
 * grouped-by-reason shape (docs/design.md) `InstallBatchDialog`/"Wake
 * selected" above already use — `partial`/`unavailable`/`stale`/`unknown`
 * outcomes group under `skipped`, carrying the labelling service's own
 * reason text, never rounded up into `ok`.
 */
describe('Dashboard — Apply labels (plan 89 §3.7 point 3, §5 step 89.8)', () => {
  const deviceB = { ...device, id: 'dev-2', label: 'pixel 8' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [device, deviceB], nextCursor: null, total: 2 } } }

  beforeEach(() => setSearchParams({ view: 'list' }))

  test('reports one applied and one partial, naming the reason — never flattened into a bare count', async () => {
    renderWithApi(<Dashboard />, {
      ...responses,
      '/api/devices/labels/apply': {
        body: {
          total: 2,
          results: [
            { deviceId: 'dev-1', state: { mode: 'wallpaper', state: 'applied', reason: null, fingerprint: 'f1', appliedAt: 1, originalCaptured: true, capturedLockScreen: null }, error: null },
            { deviceId: 'dev-2', state: { mode: 'wallpaper', state: 'partial', reason: 'only the home screen accepted the label', fingerprint: 'f2', appliedAt: 1, originalCaptured: true, capturedLockScreen: null }, error: null },
          ],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /pixel 8/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels' }))

    await waitFor(() => expect(screen.getByText('1 ok · 0 failed · 1 skipped (2/2)')).toBeTruthy())
    expect(screen.getByText('only the home screen accepted the label')).toBeTruthy()
    expect(screen.getAllByText('pixel 8').length).toBeGreaterThanOrEqual(2)
  })

  test('a thrown error (not a reported state) groups under failed, with the server error verbatim', async () => {
    renderWithApi(<Dashboard />, {
      ...responses,
      '/api/devices/labels/apply': {
        body: {
          total: 1,
          results: [{ deviceId: 'dev-1', state: null, error: 'device_not_found: no such device' }],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select devices' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /moto g06/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels' }))

    await waitFor(() => expect(screen.getByText('0 ok · 1 failed · 0 skipped (1/1)')).toBeTruthy())
    expect(screen.getByText('device_not_found: no such device')).toBeTruthy()
  })
})
