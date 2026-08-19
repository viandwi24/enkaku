import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { AuthContext, type AuthState } from '@/lib/auth'
import { readLocalPrefs, writeSessionPrefs } from '@/lib/prefs'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'
import { defaultFarmSettings, type DeviceInfo } from '@enkaku/protocol'

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
 * Plan 101 §5 step 101.7 (folded in mid-step, 2026-08-16) — no more
 * checkbox: a click on a device's own `[data-device-id]` wrapper toggles
 * selection directly. Clicking the WRAPPER itself (not the label link or any
 * other interactive descendant inside `DeviceCard`) is what guarantees the
 * click actually toggles rather than bailing (`toggleDeviceOnClick`'s own
 * doc comment, `app/page.tsx`) — the same reason `screen.getByText(label)`
 * is walked UP to its `[data-device-id]` ancestor rather than clicked
 * directly (the label is inside `DeviceCard`'s own link).
 */
function clickDevice(label: string): void {
  const wrapper = screen.getByText(label).closest('[data-device-id]')
  if (!wrapper) throw new Error(`No [data-device-id] wrapper found for "${label}"`)
  fireEvent.click(wrapper)
}

/** Reads `DeviceCard`'s own selected styling (`border-accent`) off the `[data-device-id]` wrapper's first child — there is no checkbox to read `.checked` off any more. */
function isDeviceSelected(container: HTMLElement, id: string): boolean {
  const wrapper = container.querySelector(`[data-device-id="${id}"]`)
  const card = wrapper?.firstElementChild
  return !!card?.className.includes('border-accent')
}

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

  /**
   * Plan 101 §5 step 101.8 (owner-specified, 2026-08-16): the connection
   * filter moved from an always-visible dropdown in the filter row into the
   * "Filters" popover (alongside readiness and group-by) — opening it first
   * is what makes the `combobox` findable at all now, since Radix unmounts
   * `PopoverContent` while closed.
   */
  async function openFiltersPopover() {
    fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
    await screen.findByRole('combobox', { name: 'Filter by connection' })
  }

  test('"On the network" keeps every non-USB device and drops the USB one', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('usb phone')).toBeTruthy())
    expect(screen.getByText('otg phone')).toBeTruthy()
    expect(screen.getByText('wifi phone')).toBeTruthy()

    await openFiltersPopover()
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by connection' }))
    fireEvent.click(await screen.findByRole('option', { name: 'On the network' }))

    await waitFor(() => expect(screen.queryByText('usb phone')).toBeNull())
    expect(screen.getByText('otg phone')).toBeTruthy()
    expect(screen.getByText('wifi phone')).toBeTruthy()
  })

  test('"OTG" narrows to exactly the wired-network device, not the Wi-Fi one', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('otg phone')).toBeTruthy())

    await openFiltersPopover()
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
        // Plan 105 §3.2 — a fresh `expiresAt` (just touched, matching what
        // a real `assist.changed` broadcast always carries) so this reads
        // "Assisting", not "May assist" (`HolderBadge`'s activity split).
        assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: Math.floor(Date.now() / 1000) + 300 }],
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
        // Plan 105 §3.2 — a fresh `expiresAt` (just touched, matching what
        // a real `assist.changed` broadcast always carries) so this reads
        // "Assisting", not "May assist" (`HolderBadge`'s activity split).
        assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: Math.floor(Date.now() / 1000) + 300 }],
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
        // Plan 105 §3.2 — a fresh `expiresAt` (just touched, matching what
        // a real `assist.changed` broadcast always carries) so this reads
        // "Assisting", not "May assist" (`HolderBadge`'s activity split).
        assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: Math.floor(Date.now() / 1000) + 300 }],
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

  // These tests select via a click on `DeviceCard`'s own wrapper (List),
  // then some switch to Wall by hand — they are about the List<->Wall
  // wiring, not about which view opens by default (plan 92 §9 Q1's own test
  // lives below in its own describe block), so this pins the starting view.
  beforeEach(() => setSearchParams({ view: 'list' }))

  test('selection survives a view switch (List -> Wall -> List) — the hand-rolled Set is gone, one array backs both', async () => {
    const { container } = renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    clickDevice('moto g06')
    await waitFor(() => expect(isDeviceSelected(container, 'dev-1')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByTestId('tile-dev-1').dataset.selected).toBe('true'))
    expect(screen.getByTestId('tile-dev-2').dataset.selected).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(isDeviceSelected(container, 'dev-1')).toBe(true)
  })

  test('the cursor badge names the live selected count', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByText(/selected$/)).toBeNull()

    clickDevice('moto g06')
    clickDevice('pixel 8')
    fireEvent.mouseMove(window, { clientX: 50, clientY: 60 })

    await waitFor(() => expect(screen.getByText('2 selected')).toBeTruthy())
  })

  test('"Select all" selects every filtered device (tri-state, plan 91 §5 step 91.8, F12)', async () => {
    const { container } = renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))

    expect(isDeviceSelected(container, 'dev-1')).toBe(true)
    expect(isDeviceSelected(container, 'dev-2')).toBe(true)
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
 * Drag-box select and the right-click context menu (plan 101 §3.9, §5 step
 * 101.5, G15). `WallTile` stays mocked (see the file header) — these tests
 * are about `app/page.tsx`'s OWN wiring: does a drag write into the exact
 * same `selectedIds` the checkbox does, does right-click reuse the
 * toolbar's own actions, does it work the same on both views. The drag
 * rectangle's own intersection MATH is proven directly by
 * `useDragSelect.test.ts` — there is no real CSS layout engine under
 * happy-dom (`getBoundingClientRect` always reads a zero rect, the same
 * limitation `WallTile.test.tsx` already documents and works around), so
 * every `data-device-id` wrapper here gets its rect assigned by hand before
 * a drag is simulated over it.
 */
describe('Dashboard — drag-box select and the context menu (plan 101 §3.9, §5 step 101.5, G15)', () => {
  const deviceB = { ...device, id: 'dev-2', label: 'pixel 8' }
  // Plan 103 §5 step 103.10 — the context menu now renders `SidePanel`
  // (panel 3), which fetches the RIGHT-CLICKED device's own detail
  // (`/api/devices/:id`, `DeviceDetailResponseSchema` — extra engine-name
  // fields beyond the fleet list's own `DeviceInfo`) the same way
  // `DevicePopup` already does; the old item-list menu never made this
  // call at all.
  const deviceDetail = { ...device, transport: 'adb-usb', display: 'scrcpy', liveDisplay: null, input: 'adb-input', inspection: 'ui-server', settings: null, nodeId: null }
  const deviceBDetail = { ...deviceB, transport: 'adb-usb', display: 'scrcpy', liveDisplay: null, input: 'adb-input', inspection: 'ui-server', settings: null, nodeId: null }
  const responses = {
    ...baseResponses,
    '/api/devices?*': { body: { items: [device, deviceB], nextCursor: null, total: 2 } },
    '/api/devices/dev-1': { body: { device: deviceDetail } },
    '/api/devices/dev-2': { body: { device: deviceBDetail } },
  }

  // Pinned to List for the drag tests below, the same reason the Wall
  // selection describe block above pins it — these are about the List<->grid
  // wiring, not about which view opens by default.
  beforeEach(() => setSearchParams({ view: 'list' }))

  function stubRects(container: HTMLElement) {
    const a = container.querySelector('[data-device-id="dev-1"]') as HTMLElement
    const b = container.querySelector('[data-device-id="dev-2"]') as HTMLElement
    a.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => undefined }) as DOMRect
    b.getBoundingClientRect = () => ({ left: 200, top: 0, right: 300, bottom: 100, width: 100, height: 100, x: 200, y: 0, toJSON: () => undefined }) as DOMRect
  }

  test('dragging a rectangle over both cards selects exactly them — the same set clicking both individually would produce (this step\'s own acceptance criterion)', async () => {
    const { container } = renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    stubRects(container)
    const grid = screen.getByTestId('device-grid')

    fireEvent.mouseDown(grid, { clientX: -10, clientY: -10, button: 0 })
    fireEvent.mouseMove(window, { clientX: 310, clientY: 110 })
    fireEvent.mouseUp(window)

    await waitFor(() => expect(isDeviceSelected(container, 'dev-1')).toBe(true))
    expect(isDeviceSelected(container, 'dev-2')).toBe(true)
  })

  test('a rectangle covering only one card selects only that one', async () => {
    const { container } = renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    stubRects(container)
    const grid = screen.getByTestId('device-grid')

    fireEvent.mouseDown(grid, { clientX: -10, clientY: -10, button: 0 })
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 })
    fireEvent.mouseUp(window)

    await waitFor(() => expect(isDeviceSelected(container, 'dev-1')).toBe(true))
    expect(isDeviceSelected(container, 'dev-2')).toBe(false)
  })

  /**
   * Plan 101 §5 step 101.7 (folded in mid-step) removed "select mode"
   * entirely — a drag (or a plain click) always selects now, so there is no
   * mode left to auto-enter. This just re-proves the drag itself still
   * works with no button pressed first, which used to be the interesting
   * part of this test before "Select devices" existed to press.
   */
  test('a drag selects immediately — no button to press first', async () => {
    const { container } = renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Select devices' })).toBeNull()
    stubRects(container)
    const grid = screen.getByTestId('device-grid')

    fireEvent.mouseDown(grid, { clientX: -10, clientY: -10, button: 0 })
    fireEvent.mouseMove(window, { clientX: 50, clientY: 50 })
    fireEvent.mouseUp(window)

    await waitFor(() => expect(isDeviceSelected(container, 'dev-1')).toBe(true))
  })

  test('a mousedown that starts ON a card does not begin a rectangle — a plain click on the card still toggles it normally', async () => {
    const { container } = renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    const card = container.querySelector('[data-device-id="dev-1"]') as HTMLElement

    fireEvent.mouseDown(card)
    fireEvent.click(card)

    expect(isDeviceSelected(container, 'dev-1')).toBe(true)
    // No rectangle ever appeared (a drag starting on a card is a no-op, per
    // `useDragSelect.ts`'s own bail) — the OTHER device was never touched.
    expect(isDeviceSelected(container, 'dev-2')).toBe(false)
  })

  test('right-click a device NOT currently selected replaces the selection with just it, and the menu names it', async () => {
    // Plan 103 §5 step 103.10 — the menu now reuses `ActionsList`'s Row/
    // Tooltip pieces (a disabled row, e.g. Disconnect on a USB device,
    // renders inside a Radix `Tooltip`), which requires an ancestor
    // `TooltipProvider` the same way `ActionsList.test.tsx`/`DevicePopup.
    // test.tsx` already supply one — `app/layout.tsx` provides it for real
    // in production; this file's own `<Dashboard />` render never needed
    // one before because nothing in its tree mounted a Tooltip until now.
    const { container } = renderWithApi(
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>,
      responses,
    )
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.contextMenu(screen.getByText('moto g06'))

    // Plan 103 §5 step 103.10 — the menu is now panel 3 itself (`role="region"`,
    // a header naming the device, `SidePanel`'s Actions tab), not the old
    // `role="menu"` item list. The header starts as the bare device id
    // (before its own `/api/devices/dev-1` fetch resolves) and becomes the
    // label once it does — `findByRole` polls until it matches, which is
    // the async proof that this fetch actually happened.
    const menu = await screen.findByRole('region', { name: 'Device actions — moto g06' })
    expect(menu).toBeTruthy()
    await waitFor(() => expect(isDeviceSelected(container, 'dev-1')).toBe(true))
    expect(isDeviceSelected(container, 'dev-2')).toBe(false)
  })

  test('right-click a device already part of a multi-selection keeps the WHOLE selection, and the menu names the count', async () => {
    const { container } = renderWithApi(
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>,
      responses,
    )
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    clickDevice('moto g06')
    clickDevice('pixel 8')

    fireEvent.contextMenu(screen.getByText('moto g06'))

    // "N devices selected" is computed from `selectedIds` directly (plan
    // 103 §5 step 103.10) — unlike the single-device label above, it does
    // NOT wait on the device detail fetch, so it is correct immediately.
    const menu = await screen.findByRole('region', { name: 'Device actions — 2 devices selected' })
    expect(menu).toBeTruthy()
    expect(isDeviceSelected(container, 'dev-1')).toBe(true)
    expect(isDeviceSelected(container, 'dev-2')).toBe(true)
  })

  test('the context menu\'s "Adb command" opens the SAME single-device terminal the popup\'s own row opens — not a navigation (plan 103 §5 step 103.10)', async () => {
    renderWithApi(
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>,
      responses,
    )
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    fireEvent.contextMenu(screen.getByText('moto g06'))
    const menu = await screen.findByRole('region', { name: 'Device actions — moto g06' })
    // "Run command…" was the old item list's own wording for this row
    // (`router.push` straight to `/console`); the merged action list words
    // it once, like the popup's own "Adb command" row, and opens
    // `AdbCommandDialog` in place instead of navigating away from the Wall.
    fireEvent.click(within(menu).getByRole('button', { name: 'Adb command' }))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText('No commands run yet')).toBeTruthy())
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('right-click also opens the menu on the Wall — same component, same reused actions', async () => {
    renderWithApi(
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>,
      responses,
    )
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByTestId('tile-dev-1')).toBeTruthy())

    fireEvent.contextMenu(screen.getByTestId('tile-dev-1'))

    expect(await screen.findByRole('region', { name: 'Device actions — moto g06' })).toBeTruthy()
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
 * and a pick persists in `localStorage` (checked via `readLocalPrefs`
 * directly rather than a second storage-key literal). Default bumped from
 * Medium to Large by plan 101 §5 step 101.8 (owner-specified, 2026-08-16) —
 * see `lib/prefs.ts`'s own comment on why.
 */
describe('Dashboard — Tile size control (plan 92 §3.11, §4.9, step 92.5; default bumped by plan 101 §5 step 101.8)', () => {
  test('absent on List, present on Wall, defaults to Large, and picking Medium writes localStorage', async () => {
    setSearchParams({ view: 'list' })
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByRole('group', { name: 'Tile size' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Wall' }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Tile size' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Large tiles' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Medium tiles' }))
    expect(screen.getByRole('button', { name: 'Medium tiles' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Large tiles' }).getAttribute('aria-pressed')).toBe('false')
    expect(readLocalPrefs().tileSize).toBe('m')
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

    clickDevice('moto g06')
    clickDevice('pixel 8')

    const link = screen.getByText('Run command…').closest('a')
    expect(link?.getAttribute('href')).toBe('/console?deviceIds=dev-1,dev-2')
  })

  test('"Push file…" opens BulkTransferDialog in push mode, naming the selection', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    clickDevice('moto g06')
    fireEvent.click(screen.getByRole('button', { name: 'Push file…' }))

    await waitFor(() => expect(screen.getByText('Push file to 1 device')).toBeTruthy())
  })

  test('"Pull file…" opens BulkTransferDialog in pull mode', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    clickDevice('moto g06')
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

    clickDevice('moto g06')
    clickDevice('pixel 8')
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
        body: { changed: [{ stableId: 'ZP2222RMBS', from: 3, to: 1 }], released: [], relabelled: 1, failed: [] },
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
 * "Move to network…" (plan 88 §5 step 88.5's own bulk sibling; plan 96
 * hotfix — the direct answer to "kalau di panda kan dipermudah kaya ke
 * halaman devices sudah ada menunya", a menu reachable from the Devices
 * page itself rather than buried in a per-device popup). Defaulted from the
 * CURRENT farm-wide selection when one exists, or every eligible
 * (USB-connected) device otherwise — never every device unconditionally,
 * since a device already on the network has nowhere left to move to.
 */
describe('Dashboard — Move to network… (plan 88 §5, plan 96 hotfix)', () => {
  const deviceB = {
    ...device,
    id: 'dev-2',
    label: 'pixel 8',
    connection: { kind: 'tcp', medium: 'wired', mediumSource: 'network', address: '10.0.0.9', port: 5555, networkLabel: null },
  }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [device, deviceB], nextCursor: null, total: 2 } } }

  test('with no selection, defaults to every eligible USB device — a device already on the network is excluded', async () => {
    const user = userEvent.setup()
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'More fleet actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to network…' }))

    // Only `device` (usb) is eligible by default — `deviceB` (tcp) is left out.
    await waitFor(() => expect(screen.getByText('Move 1 device to the network')).toBeTruthy())
  })

  test('with a live selection, the dialog opens pre-filled with it — even a device already on the network', async () => {
    setSearchParams({ view: 'list' })
    const user = userEvent.setup()
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    clickDevice('moto g06')
    clickDevice('pixel 8')

    await user.click(screen.getByRole('button', { name: 'More fleet actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to network…' }))

    // The selection is the default AS PICKED — the dialog's own eligibility
    // check (not this pre-fill) is what later skips `deviceB` with a reason.
    await waitFor(() => expect(screen.getByText('Move 2 devices to the network')).toBeTruthy())
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

    clickDevice('moto g06')
    clickDevice('pixel 8')
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

    clickDevice('moto g06')
    fireEvent.click(screen.getByRole('button', { name: 'Apply labels' }))

    await waitFor(() => expect(screen.getByText('0 ok · 1 failed · 0 skipped (1/1)')).toBeTruthy())
    expect(screen.getByText('device_not_found: no such device')).toBeTruthy()
  })
})

/**
 * Plan 101 §5 step 101.7, requirement 6 — the four-tile stat strip
 * (`2 total`, `0 ready`, …) is gone; the same `filter` state it used to
 * drive moves into a `Select` beside the other filters, with the counts
 * folded into each option's own label so "how many are ready" is still one
 * glance away.
 */
describe('Dashboard — the status filter replaces the stat strip (plan 101 §5 step 101.7, requirement 6)', () => {
  const readyDevice = { ...device, id: 'dev-1', label: 'ready phone', status: 'idle' }
  const busyDevice = { ...device, id: 'dev-2', label: 'busy phone', status: 'busy' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [readyDevice, busyDevice], nextCursor: null, total: 2 } } }

  beforeEach(() => setSearchParams({ view: 'list' }))

  test('no stat-strip tiles render — no "Total"/"Ready"/"Needs attention" buttons', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('ready phone')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Total$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Needs attention/ })).toBeNull()
  })

  test('the status Select narrows the list the same way the old "Ready" tile did', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('busy phone')).toBeTruthy())

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by status' }))
    fireEvent.click(await screen.findByRole('option', { name: /^Ready/ }))

    await waitFor(() => expect(screen.queryByText('busy phone')).toBeNull())
    expect(screen.getByText('ready phone')).toBeTruthy()
  })

  test('each option carries the same count the old stat tile showed', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('ready phone')).toBeTruthy())

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by status' }))
    expect(await screen.findByRole('option', { name: 'Ready (1)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'In use (1)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'All devices (2)' })).toBeTruthy()
  })
})

/**
 * Plan 101 §5 step 101.7, requirement 4 — client-side pagination over the
 * already-fetched `filtered` set (the plan's own §0 decision: keeps live WS
 * updates and selection semantics exactly as they were, the far smaller
 * change against server-side keyset paging). `pageDevices` feeds List and
 * Wall identically when ungrouped, so these are exercised on List, where
 * `DeviceCard` renders for real (Wall's own tile is mocked at the top of
 * this file for unrelated reasons).
 */
describe('Dashboard — pagination (plan 101 §5 step 101.7, requirement 4)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...device, id: `dev-${i + 1}`, label: `device ${i + 1}` }))
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: many, nextCursor: null, total: 30 } } }

  beforeEach(() => setSearchParams({ view: 'list' }))

  test('defaults to 24 per page, shows the range, and Prev starts disabled', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('device 1')).toBeTruthy())

    expect(screen.getByText('Showing 1–24 of 30 devices')).toBeTruthy()
    expect(screen.queryByText('device 25')).toBeNull()
    expect(screen.getByRole('button', { name: 'Prev' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
  })

  test('Next reveals the remaining devices and then disables itself', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('device 1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => expect(screen.getByText('device 25')).toBeTruthy())
    expect(screen.queryByText('device 1')).toBeNull()
    expect(screen.getByText('Showing 25–30 of 30 devices')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Prev' }).hasAttribute('disabled')).toBe(false)
  })

  test('changing the page size resets to page 1 and persists to localStorage (plan 101 §5 step 101.7)', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('device 1')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByText('device 25')).toBeTruthy())

    fireEvent.click(screen.getByRole('combobox', { name: 'Devices per page' }))
    fireEvent.click(await screen.findByRole('option', { name: '12' }))

    await waitFor(() => expect(screen.getByText('Showing 1–12 of 30 devices')).toBeTruthy())
    expect(readLocalPrefs().pageSize).toBe(12)
  })

  /**
   * The requirement this whole hook exists to satisfy: an operator who
   * selects devices, pages forward, and presses a bulk action must act on
   * every one selected — not just whatever is currently rendered.
   */
  test('a selection made on page 1 survives paging to page 2 (`selectedIds` is not page-scoped)', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('device 1')).toBeTruthy())

    clickDevice('device 1')
    clickDevice('device 2')
    expect(screen.getByText('2 devices selected')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByText('device 25')).toBeTruthy())
    expect(screen.getByText('2 devices selected')).toBeTruthy()
  })

  test('grouping suspends pagination — every match renders and no page controls appear', async () => {
    setSearchParams({ view: 'list', group: 'status' })
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('device 1')).toBeTruthy())

    expect(screen.getByText('device 30')).toBeTruthy()
    expect(screen.queryByText(/^Showing \d/)).toBeNull()
  })
})

/**
 * Plan 101 §5 step 101.7, requirement 5 — the selection action bar floats
 * (bottom-centre, `position: fixed`) instead of sitting inline in the
 * page's own flow, the way it did before this step.
 */
describe('Dashboard — the selection action bar floats (plan 101 §5 step 101.7, requirement 5)', () => {
  const deviceB = { ...device, id: 'dev-2', label: 'pixel 8' }
  const responses = { ...baseResponses, '/api/devices?*': { body: { items: [device, deviceB], nextCursor: null, total: 2 } } }

  beforeEach(() => setSearchParams({ view: 'list' }))

  test('absent with nothing selected, and fixed-positioned once something is', async () => {
    renderWithApi(<Dashboard />, responses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())
    expect(screen.queryByText(/device.? selected$/)).toBeNull()

    clickDevice('moto g06')

    const label = screen.getByText('1 device selected')
    const bar = label.closest('.fixed')
    expect(bar).toBeTruthy()
    expect(bar?.className).toContain('bottom-6')
  })
})

/**
 * Plan 101 §5 step 101.8 (owner-specified, 2026-08-16) — the header row
 * consolidated to match `refs/ui`'s own `data-screen-label="Devices"`
 * header: ONE title pill (`Devices` + the farm-wide count, merged via
 * `PageHeader`'s new `titlePill` prop), Search/Cluster/Status pills beside
 * it, and everything else (List/Wall, tile size, Select all, Discovered)
 * moved down into the filter row, with the less-used filters
 * (readiness/connection/group-by) behind one "Filters" popover.
 */
describe('Dashboard — the title pill and consolidated header (plan 101 §5 step 101.8)', () => {
  test('the title pill carries both "Devices" and the total farm count as one object', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    const heading = screen.getByRole('heading', { name: 'Devices' })
    const pill = heading.closest('.rounded-full')
    expect(pill).toBeTruthy()
    expect(pill?.textContent).toContain('1')
  })

  test('Cluster and Status pills sit in the header, always mounted — no popover to open first', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    expect(screen.getByRole('combobox', { name: 'Filter by cluster' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeTruthy()
  })

  test('readiness, connection, and group-by are reachable through the "Filters" popover, not mounted until it opens', async () => {
    renderWithApi(<Dashboard />, baseResponses)
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    expect(screen.queryByRole('combobox', { name: 'Filter by readiness' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Filter by connection' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))

    expect(await screen.findByRole('combobox', { name: 'Filter by readiness' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Filter by connection' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy()
  })

  test('picking a readiness filter through the popover still narrows the list (the filter itself still works after moving)', async () => {
    const asleepDevice = { ...device, id: 'dev-2', label: 'asleep phone', readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 } }
    renderWithApi(<Dashboard />, { ...baseResponses, '/api/devices?*': { body: { items: [device, asleepDevice], nextCursor: null, total: 2 } } })
    await waitFor(() => expect(screen.getByText('asleep phone')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.click(await screen.findByRole('combobox', { name: 'Filter by readiness' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Asleep' }))

    await waitFor(() => expect(screen.queryByText('moto g06')).toBeNull())
    expect(screen.getByText('asleep phone')).toBeTruthy()
  })
})

/**
 * "Scan network" (plan 88 §5 — superseding step 88.12's disabled-with-a-
 * navigate-away-tooltip shortcut with a real, self-contained modal, the
 * owner's own request after seeing that fallback live). The menu item ALWAYS
 * opens `ScanNetworkDialog`, never disabled, never a `router.push`.
 * `ScanNetworkDialog.test.tsx` covers the dialog's own save/edit/"Scan all"
 * behaviour in depth; this file covers only the Devices-page wiring: the
 * item always opens the dialog regardless of configured networks, and a
 * successful scan inside it refetches the fleet and the tray here.
 */
describe('Dashboard — Scan network (plan 88 §5)', () => {
  function settingsWithNetworks(networks: Array<{ cidr: string; label: string; medium: 'wired' | 'wireless'; scan: boolean }>) {
    const base = defaultFarmSettings()
    return { settings: { ...base, discovery: { ...base.discovery, networks } }, schema: {}, deviceSchema: {} }
  }

  test('no networks configured: the menu item still opens the dialog — never disabled, never a router.push', async () => {
    const user = userEvent.setup()
    renderWithApi(<Dashboard />, { ...baseResponses, '/api/settings': { body: settingsWithNetworks([]) } })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'More fleet actions' }))
    const item = await screen.findByRole('menuitem', { name: 'Scan network' })
    expect(item.getAttribute('aria-disabled')).toBeNull()

    await user.click(item)
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Scan network' })).toBeTruthy())
    // The dialog's own empty state is where "no networks configured" now
    // lives — with an "Add range" affordance right there, not a dead-end
    // tooltip and not a navigation.
    await waitFor(() => expect(screen.getByText('No ranges yet')).toBeTruthy())
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('a configured, scannable network: the item opens the dialog pre-loaded with it, ready for "Scan all"', async () => {
    const user = userEvent.setup()
    renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/settings': { body: settingsWithNetworks([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
    })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'More fleet actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Scan network' }))

    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())
    expect((screen.getByLabelText('Range 1 start IP') as HTMLInputElement).value).toBe('10.20.0.0')
    expect(screen.getByRole('button', { name: 'Scan all' })).toBeTruthy()
  })

  test('a successful "Scan all" inside the dialog refetches the fleet and the tray', async () => {
    const user = userEvent.setup()
    const { apiMock } = renderWithApi(<Dashboard />, {
      ...baseResponses,
      '/api/settings': { body: settingsWithNetworks([{ cidr: '10.20.0.0/24', label: 'Chassis A', medium: 'wired', scan: true }]) },
      '/api/devices/scan': {
        body: {
          networks: [{ cidr: '10.20.0.0/24', label: 'Chassis A', addresses: 256, port: 5555 }],
          scanned: 254,
          skipped: 0,
          answered: 1,
          connected: 1,
          identified: 1,
          adopted: [],
          discovered: ['SER9'],
          conflicts: [],
          durationMs: 900,
        },
      },
    })
    await waitFor(() => expect(screen.getByText('moto g06')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'More fleet actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Scan network' }))
    await waitFor(() => expect(screen.getByLabelText('Range 1 start IP')).toBeTruthy())

    const devicesCallsBefore = apiMock.calls.filter((c) => c.path.startsWith('/api/devices?')).length
    await user.click(screen.getByRole('button', { name: 'Scan all' }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/devices/scan')).toBe(true))
    // The fleet list is refetched after a successful scan, the same
    // belt-and-suspenders refetch every other fleet-menu action here does
    // alongside its WS-driven update (`renumberFleet` above is the
    // precedent this mirrors) — `ScanNetworkDialog`'s own `onScanned` is
    // this page's `onNetworkScanned`.
    await waitFor(() => expect(apiMock.calls.filter((c) => c.path.startsWith('/api/devices?')).length).toBeGreaterThan(devicesCallsBefore))
  })
})
