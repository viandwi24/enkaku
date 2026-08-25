import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { ActionSpecSchema, ViewSpecSchema, type ActionSpec, type ViewSpec } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ViewRenderer } from './ViewRenderer'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * Plan 108 §4.3, §5 step 108.7, criterion 8 — the tier-A renderer against the
 * plan's OWN worked example (the TikTok Accounts view), so the vocabulary is
 * exercised the way a real plugin writes it rather than through a fixture
 * shaped to whatever the renderer happens to do.
 *
 * Fixtures go through `ViewSpecSchema.parse` on purpose: a `ViewSpec` reaches
 * this component with every default already applied (`width`, `rows`,
 * `includeMissing`, `selectable`, ...), so a test that hand-built the object
 * would be testing a shape the component can never actually receive.
 */

function view(spec: unknown): ViewSpec {
  return ViewSpecSchema.parse(spec)
}

function action(spec: unknown): ActionSpec {
  return ActionSpecSchema.parse(spec)
}

const ACCOUNTS_VIEW = view({
  title: 'TikTok accounts',
  description: 'Which accounts are signed in on each device.',
  data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: true },
  table: {
    rowKey: 'username',
    selectable: true,
    columns: [
      { field: '$device.label', header: 'Device' },
      { field: 'username', header: 'Account' },
      { field: 'position', header: 'Slot', width: 'narrow' },
      { field: 'current', header: 'Signed in', schema: { type: 'boolean' }, width: 'narrow' },
      { field: '$entry.updatedAt', header: 'Last synced', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
    ],
  },
  toolbar: ['sync'],
  rowActions: ['switchTo'],
  empty: { title: 'No accounts read yet', hint: 'Run “Sync accounts” to read the switch-account sheet on each device.' },
})

const ACTIONS: Record<string, ActionSpec> = {
  sync: action({ kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker' }),
  switchTo: action({
    kind: 'job',
    label: 'Switch to this account',
    script: 'tiktok/switch-account@latest',
    device: 'row',
    params: { target: { $row: 'username' } },
    confirm: 'Switch this device to the selected account?',
  }),
}

function entry(value: unknown, updatedAt = 1_700_000_000) {
  return { key: 'accounts', value, secret: false, hint: null, version: 3, expiresAt: null, updatedAt }
}

const SCAN_PATH = '/api/plugins/tiktok/data/scan*'

const TWO_DEVICES = {
  items: [
    {
      deviceId: 'dev-1',
      stableId: 'SER1',
      label: 'Pixel 7',
      status: 'online',
      clusterId: null,
      number: 12,
      entry: entry({ accounts: [{ username: 'alice', position: 1, current: true }, { username: 'bob', position: 2, current: false }] }),
    },
    { deviceId: 'dev-2', stableId: 'SER2', label: 'Pixel 4a', status: 'offline', clusterId: null, number: null, entry: null },
  ],
  nextCursor: null,
}

describe('ViewRenderer — the four states every fetching screen owes', () => {
  test('loaded: Studio’s own table, one row per element of itemsAt', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.getByText('bob')).toBeTruthy()
    // Header cells come from the declared columns, in declaration order.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Device', 'Account', 'Slot', 'Signed in', 'Last synced', 'Actions'])
  })

  test('loading: a busy skeleton before the rows arrive', () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('empty: the VIEW’s own copy, not a generic sentence', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: { items: [], nextCursor: null } } })
    await waitFor(() => expect(screen.getByText('No accounts read yet')).toBeTruthy())
    expect(screen.getByText(/Run “Sync accounts”/)).toBeTruthy()
  })

  test('error: the failure is named, with a retry', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, {
      [SCAN_PATH]: { status: 500, body: { error: { code: 'E_INTERNAL', message: 'scan boom' } } },
    })
    await waitFor(() => expect(screen.getByText('scan boom')).toBeTruthy())
    expect(screen.getByText('Try again')).toBeTruthy()
  })
})

describe('ViewRenderer — rows: "items" flattening', () => {
  test('a device with two elements becomes two rows; a device with none still shows, because includeMissing is on', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    // 1 header row + 2 rows for Pixel 7 + 1 "never synced" row for Pixel 4a.
    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.getByText('Pixel 4a')).toBeTruthy()
  })

  test('includeMissing: false drops the device that has never stored the key', async () => {
    const noMissing = view({ ...ACCOUNTS_VIEW, data: { kind: 'kv.scan', key: 'accounts', rows: 'items', itemsAt: 'accounts', includeMissing: false } })
    renderWithApi(<ViewRenderer plugin="tiktok" view={noMissing} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.queryByText('Pixel 4a')).toBeNull()
  })

  test('rows: "entry" is one row per device, whatever the entry holds', async () => {
    const perEntry = view({
      title: 'Sync state',
      data: { kind: 'kv.scan', key: 'accounts' },
      table: { rowKey: '$device.stableId', columns: [{ field: '$device.label', header: 'Device' }, { field: 'readAt', header: 'Read at' }] },
    })
    renderWithApi(<ViewRenderer plugin="tiktok" view={perEntry} actions={{}} />, {
      [SCAN_PATH]: {
        body: {
          items: [
            { deviceId: 'dev-1', stableId: 'SER1', label: 'Pixel 7', status: 'online', clusterId: null, number: 12, entry: entry({ readAt: 'yesterday' }) },
            { deviceId: 'dev-2', stableId: 'SER2', label: 'Pixel 4a', status: 'offline', clusterId: null, number: null, entry: null },
          ],
          nextCursor: null,
        },
      },
    })
    await waitFor(() => expect(screen.getByText('yesterday')).toBeTruthy())
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })
})

describe('ViewRenderer — $device and $entry columns read the row’s CONTEXT, not its value', () => {
  test('$device.label shows the device even though the stored value never mentions it', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getAllByText('Pixel 7')).toHaveLength(2))
  })

  test('$entry.updatedAt renders through the timestamp kind, and a device with no entry reads as an em dash', async () => {
    const fresh = Math.floor(Date.now() / 1000) - 120
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, {
      [SCAN_PATH]: {
        body: {
          items: [
            { ...TWO_DEVICES.items[0], entry: entry({ accounts: [{ username: 'alice', position: 1, current: true }] }, fresh) },
            TWO_DEVICES.items[1],
          ],
          nextCursor: null,
        },
      },
    })
    await waitFor(() => expect(screen.getByText('2m ago')).toBeTruthy())
    // Pixel 4a has no entry at all — every column but `$device.*` is empty.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  /**
   * The three-column device identity an operator reads a row by (plan 108 §3.6, extended): the id
   * they can match to a phone, the number printed on it, and the name. The number is the one that
   * is legitimately absent — a device with no reservation must render the SAME em dash every other
   * empty cell renders, never the string `undefined`, which is what an operator would otherwise be
   * asked to interpret.
   */
  test('$device.number renders the number, and an em dash — never “undefined” — for a device with none', async () => {
    const identity = view({
      title: 'Devices',
      data: { kind: 'kv.scan', key: 'accounts' },
      table: {
        rowKey: '$device.stableId',
        columns: [
          { field: '$device.stableId', header: 'Device ID' },
          { field: '$device.number', header: 'Device #', width: 'narrow' },
          { field: '$device.label', header: 'Device' },
        ],
      },
    })
    renderWithApi(<ViewRenderer plugin="tiktok" view={identity} actions={{}} />, { [SCAN_PATH]: { body: TWO_DEVICES } })

    await waitFor(() => expect(screen.getByText('SER1')).toBeTruthy())
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Device ID', 'Device #', 'Device'])
    expect(screen.getByText('12')).toBeTruthy()
    // SER2 has no allocated number: the cell is the em dash, and the word `undefined` appears nowhere.
    expect(screen.getByText('SER2')).toBeTruthy()
    expect(screen.getAllByText('—')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('undefined')
  })

  test('a $-prefixed field naming neither context is empty, never a silent read of the value', async () => {
    const typo = view({
      title: 'Typo',
      data: { kind: 'kv.scan', key: 'accounts' },
      table: { rowKey: '$device.stableId', columns: [{ field: '$devcie.label', header: 'Device' }] },
    })
    renderWithApi(<ViewRenderer plugin="tiktok" view={typo} actions={{}} />, {
      [SCAN_PATH]: { body: { items: [{ deviceId: 'dev-1', stableId: 'SER1', label: 'Pixel 7', status: 'online', clusterId: null, number: 12, entry: null }], nextCursor: null } },
    })
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
    expect(screen.queryByText('Pixel 7')).toBeNull()
  })
})

describe('ViewRenderer — selection', () => {
  test('selectable draws a checkbox per row plus a select-all, and reports rows AND devices', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())

    const boxes = document.querySelectorAll('input[type="checkbox"]')
    // 1 select-all + 3 rows.
    expect(boxes).toHaveLength(4)

    fireEvent.click(screen.getByLabelText('Select alice'))
    await waitFor(() => expect(screen.getByText(/1 row selected/)).toBeTruthy())
    expect(screen.getByText(/1 device/)).toBeTruthy()

    // Two rows on ONE device is still one device — the count an action runs on.
    fireEvent.click(screen.getByLabelText('Select bob'))
    await waitFor(() => expect(screen.getByText(/2 rows selected/)).toBeTruthy())
    expect(screen.getByText(/· 1 device$/)).toBeTruthy()
  })

  test('select-all covers every row, and clicking it again clears', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Select every row'))
    await waitFor(() => expect(screen.getByText(/3 rows selected/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Select every row'))
    await waitFor(() => expect(screen.queryByText(/rows selected/)).toBeNull())
  })

  test('a non-selectable table draws no checkbox at all', async () => {
    const plain = view({ ...ACCOUNTS_VIEW, table: { ...ACCOUNTS_VIEW.table, selectable: false }, toolbar: [], rowActions: [] })
    renderWithApi(<ViewRenderer plugin="tiktok" view={plain} actions={{}} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })
})

/**
 * Plan 124 §4.5, step 124.8 — the table filter.
 *
 * Two things are being pinned here and they matter in different ways. The
 * first is ordinary: it filters, it counts, and it finds a device by number,
 * label or stableId whether or not the author declared a column for them. The
 * second is the one the plan singles out — **the empty state must say the
 * filter ran over the rows already LOADED**, because a plugin table is a page
 * of a keyset scan and "nothing matches" would be a claim about the plugin's
 * stored data that this component cannot make.
 */
describe('ViewRenderer — the table filter (plan 124 §4.5)', () => {
  /** One device per row, `rows: 'entry'`, so N devices is exactly N rows. */
  const FLEET_VIEW = view({
    title: 'Accounts',
    data: { kind: 'kv.scan', key: 'accounts', rows: 'entry', includeMissing: true },
    table: { rowKey: '$device.label', selectable: true, columns: [{ field: '$device.label', header: 'Device' }] },
    // A toolbar action, only because the "N rows selected" readout lives in the
    // toolbar row — without one there is no place for the count to render.
    toolbar: ['sync'],
  })

  function fleet(count: number) {
    return {
      items: Array.from({ length: count }, (_, i) => ({
        deviceId: `dev-${i + 1}`,
        stableId: `SER${i + 1}`,
        label: 'SM-F721U1',
        status: 'online',
        clusterId: null,
        number: i + 1,
        entry: null,
      })),
      nextCursor: null,
    }
  }

  test('a small table gets no filter box at all — below ten rows it is noise (§3.3)', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.queryAllByLabelText('Filter rows').length).toBe(0)
  })

  test('above ten rows the box appears, with a live N of M count', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={FLEET_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: fleet(12) } })
    await waitFor(() => expect(screen.getAllByText('SM-F721U1').length).toBe(12))
    expect(screen.getByText('12 of 12 rows')).toBeTruthy()

    // The device number is searchable even though no column declares it, and
    // `7` finds `#7` — the whole point of the plan (§1 goal 3, criterion 1).
    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: '#7' } })
    await waitFor(() => expect(screen.getByText('1 of 12 rows')).toBeTruthy())
    expect(screen.getAllByText('SM-F721U1').length).toBe(1)

    // The stableId matches too, as a substring.
    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: 'ser1' } })
    await waitFor(() => expect(screen.getByText('4 of 12 rows')).toBeTruthy())
  })

  test('no match says it searched the rows LOADED, never that the plugin has nothing', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={FLEET_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: fleet(12) } })
    await waitFor(() => expect(screen.getByText('12 of 12 rows')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: 'nothing-like-this' } })
    await waitFor(() => expect(screen.getByText('No match in the rows loaded')).toBeTruthy())
    expect(screen.getByText(/already loaded/)).toBeTruthy()
    expect(screen.getByText(/does not ask/)).toBeTruthy()

    // The box survives its own empty result, or the filter could not be cleared.
    fireEvent.click(screen.getByText('Clear the filter'))
    await waitFor(() => expect(screen.getByText('12 of 12 rows')).toBeTruthy())
  })

  test('select-all covers the FILTERED set and says so, and a row the filter hides leaves the selection', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={FLEET_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: fleet(12) } })
    await waitFor(() => expect(screen.getByText('12 of 12 rows')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Select every row'))
    await waitFor(() => expect(screen.getByText(/12 rows selected/)).toBeTruthy())

    // Narrowing to one row drops the other eleven from the selection: an
    // action must never run on a device the operator has filtered away.
    fireEvent.change(screen.getByLabelText('Filter rows'), { target: { value: '#7' } })
    await waitFor(() => expect(screen.getByText(/1 row selected/)).toBeTruthy())
    expect(screen.queryAllByLabelText('Select every row').length).toBe(0)
    expect(screen.getAllByLabelText('Select every row the filter shows').length).toBe(1)
  })
})

describe('ViewRenderer — the toolbar and the row actions', () => {
  test('a toolbar button carries the action’s own label', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('Sync accounts')).toBeTruthy())
  })

  test('a row action is drawn once per row', async () => {
    renderWithApi(<ViewRenderer plugin="tiktok" view={ACCOUNTS_VIEW} actions={ACTIONS} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getAllByText('Switch to this account')).toHaveLength(3))
  })

  test('a selection-targeted batch is genuinely disabled with nothing selected, and says why', async () => {
    const selectionView = view({ ...ACCOUNTS_VIEW, toolbar: ['bulk'], rowActions: [] })
    const bulk = action({ kind: 'batch', label: 'Refresh selected', script: 'tiktok/list-accounts@latest', target: 'selection' })
    renderWithApi(<ViewRenderer plugin="tiktok" view={selectionView} actions={{ bulk }} />, { [SCAN_PATH]: { body: TWO_DEVICES } })
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())

    const button = screen.getByText('Refresh selected').closest('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('Select at least one row first')

    fireEvent.click(screen.getByLabelText('Select alice'))
    await waitFor(() => expect((screen.getByText('Refresh selected').closest('button') as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('ViewRenderer — kv.list', () => {
  test('a global list is one row per entry, with $entry.key available as a column', async () => {
    const catalogue = view({
      title: 'Catalogue',
      data: { kind: 'kv.list', scope: 'global', prefix: 'sound:' },
      table: { rowKey: '$entry.key', columns: [{ field: '$entry.key', header: 'Key' }, { field: 'title', header: 'Title' }] },
    })
    renderWithApi(<ViewRenderer plugin="tiktok" view={catalogue} actions={{}} />, {
      '/api/plugins/tiktok/data*': { body: { items: [{ ...entry({ title: 'Anthem' }), key: 'sound:1' }], nextCursor: null } },
    })
    await waitFor(() => expect(screen.getByText('sound:1')).toBeTruthy())
    expect(screen.getByText('Anthem')).toBeTruthy()
  })
})

describe('ViewRenderer — a view it cannot draw says so, rather than showing an empty table', () => {
  test('a view with no table names the plugin and says what is missing', async () => {
    // `validatePluginSurface` refuses this at verify (`plugin-surface.ts` —
    // a view needs a renderer), so this is the direct-caller path, not one an
    // operator reaches. Plan 111 §3.6 removed tier B, which used to be the
    // other way into this branch.
    const rendererless = view({ title: 'Custom' })
    renderWithApi(<ViewRenderer plugin="tiktok" view={rendererless} actions={{}} />, {})
    await waitFor(() => expect(screen.getByText(/declares this screen without both a data source and a table/)).toBeTruthy())
  })
})

/**
 * Plan 109 §4.6, step 109.6 — the `{ kind: 'handler' }` data source, and the
 * failed-service path that is the part operators actually meet.
 */
const HANDLER_VIEW = view({
  title: 'Bridge status',
  data: { kind: 'handler', name: 'status' },
  table: {
    rowKey: 'label',
    columns: [
      { field: '$device.label', header: 'Device' },
      { field: 'label', header: 'State' },
    ],
  },
})

const QUERY_PATH = '/api/plugins/bridge/query/status*'
const RESTART_PATH = '/api/plugins/bridge/runtime/restart'

/** The three refusals `service-routes.ts` raises for a service that is not serving. */
function outage(code: string, message: string) {
  return { status: 503, body: { error: { code, message } } }
}

describe('ViewRenderer — the { kind: "handler" } data source (plan 109 §4.6)', () => {
  test('rows from a query handler go through the SAME renderer a kv.scan uses, $device included', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: {
        body: {
          plugin: 'bridge',
          queryId: 'status',
          items: [
            { id: 'a', value: { label: 'listening' }, device: { id: 'dev-1', stableId: 'SER1', label: 'Pixel 7', status: 'online', clusterId: null, number: 12 } },
            { id: 'b', value: { label: 'idle' } },
          ],
          nextCursor: null,
        },
      },
    })
    await waitFor(() => expect(screen.getByText('listening')).toBeTruthy())
    // `$device.label` is a CONTEXT column: it renders from the handler's
    // `device` object, exactly as it renders from the core's join for a scan.
    expect(screen.getByText('Pixel 7')).toBeTruthy()
    expect(screen.getByText('idle')).toBeTruthy()
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  test('the view calls the QUERY route and no kv route', async () => {
    const { apiMock } = renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: { body: { plugin: 'bridge', queryId: 'status', items: [{ id: 'a', value: { label: 'listening' } }], nextCursor: null } },
    })
    await waitFor(() => expect(screen.getByText('listening')).toBeTruthy())
    expect(apiMock.calls.map((c) => c.path)).toEqual(['/api/plugins/bridge/query/status'])
  })
})

/**
 * Criterion 21. **Never an empty table, never an unresolved spinner.**
 *
 * Each state below carries the two controls plan 109 §9 Q15 asks of an absence
 * claim: control 1, the outage copy the operator is meant to read is really
 * there; control 2 — the one that matters — the SAME assertions would fail if
 * the view had rendered an empty table instead, which is proved by rendering
 * exactly that in `the control that makes the four assertions above worth
 * anything` and watching every one of them flip.
 */
describe('ViewRenderer — a view whose service is down (criterion 21)', () => {
  test('stopped: names the plugin, says the service is not running, and offers Restart', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: outage('E_PLUGIN_RUNTIME_NOT_RUNNING', 'plugin "bridge"\'s service is "stopped", so it is serving nothing.'),
    })
    await waitFor(() => expect(screen.getByText(/its service is not running/)).toBeTruthy())
    expect(screen.getByText(/“bridge”/)).toBeTruthy()
    expect(screen.getByText('Restart bridge')).toBeTruthy()
    // …and NOT the empty state, which would say the operator has no data.
    expect(screen.queryByText('Nothing stored yet')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  test('starting is NOT broken: Try again, and deliberately no Restart', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: outage('E_PLUGIN_RUNTIME_STARTING', 'plugin "bridge"\'s service is still starting'),
    })
    await waitFor(() => expect(screen.getByText(/still starting/)).toBeTruthy())
    expect(screen.getByText(/It is not broken/)).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
    // The distinction the host enforces (`E_PLUGIN_RUNTIME_STARTING` is its own
    // code) survives into the UI: you do not kick a service that is coming up.
    expect(screen.queryByText('Restart bridge')).toBeNull()
  })

  test('the error budget: says out loud that nothing will retry on its own', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: outage('E_PLUGIN_RUNTIME_DISABLED', 'disabled by the error budget — last error: boom'),
    })
    await waitFor(() => expect(screen.getByText(/will NOT retry on its own/)).toBeTruthy())
    // The verbatim last error is kept, not summarised away.
    expect(screen.getByText(/last error: boom/)).toBeTruthy()
    expect(screen.getByText('Restart bridge')).toBeTruthy()
  })

  test('a dev slot gets the server`s own actionable message and NO Restart, because restarting cannot help', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: {
        status: 409,
        body: { error: { code: 'E_PLUGIN_DEV_SLOT_NO_SERVICE', message: '"bridge" is running from a DEV SLOT… Publish and activate the plugin to run its service.' } },
      },
    })
    await waitFor(() => expect(screen.getByText(/Publish and activate/)).toBeTruthy())
    expect(screen.queryByText('Restart bridge')).toBeNull()
  })

  test('Restart posts to the runtime route and re-fetches the rows', async () => {
    let restarted = false
    const { apiMock } = renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: () =>
        restarted
          ? { body: { plugin: 'bridge', queryId: 'status', items: [{ id: 'a', value: { label: 'listening' } }], nextCursor: null } }
          : outage('E_PLUGIN_RUNTIME_NOT_RUNNING', 'plugin "bridge"\'s service is "stopped", so it is serving nothing.'),
      [RESTART_PATH]: () => {
        restarted = true
        return { body: { plugin: 'bridge', status: 'running' } }
      },
    })
    await waitFor(() => expect(screen.getByText('Restart bridge')).toBeTruthy())
    fireEvent.click(screen.getByText('Restart bridge'))
    await waitFor(() => expect(screen.getByText('listening')).toBeTruthy())
    expect(apiMock.calls.filter((c) => c.path === RESTART_PATH && c.method === 'POST')).toHaveLength(1)
  })

  test('an ordinary fetch failure is still an ordinary error — no Restart appears for something Restart cannot fix', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: { status: 502, body: { error: { code: 'E_PLUGIN_HANDLER_FAILED', message: 'plugin "bridge": query:status failed — boom' } } },
    })
    await waitFor(() => expect(screen.getByText(/query:status failed — boom/)).toBeTruthy())
    expect(screen.queryByText('Restart bridge')).toBeNull()
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  /**
   * **The control that makes the four assertions above worth anything.**
   *
   * "The view shows an error" proves very little on its own — a test that
   * asserted it would keep passing against a component that also rendered an
   * empty table, or that showed the error and then resolved into one. So here
   * the SAME view is given a handler that answers successfully with zero rows,
   * and every assertion the outage tests rely on is checked to FLIP: no outage
   * copy, no Restart, and the empty state present instead. If the failure path
   * ever silently degraded into "no rows", this test is what fails.
   */
  test('control: a handler that genuinely returns zero rows renders the EMPTY state, and none of the outage assertions hold', async () => {
    renderWithApi(<ViewRenderer plugin="bridge" view={HANDLER_VIEW} actions={{}} />, {
      [QUERY_PATH]: { body: { plugin: 'bridge', queryId: 'status', items: [], nextCursor: null } },
    })
    await waitFor(() => expect(screen.getByText('Nothing stored yet')).toBeTruthy())
    expect(screen.queryByText(/its service is not running/)).toBeNull()
    expect(screen.queryByText(/still starting/)).toBeNull()
    expect(screen.queryByText(/will NOT retry on its own/)).toBeNull()
    expect(screen.queryByText('Restart bridge')).toBeNull()
  })
})
