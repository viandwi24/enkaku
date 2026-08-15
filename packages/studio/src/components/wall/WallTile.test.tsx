import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import '@/lib/test/nav'
import { mockRouter } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `WallTile` now calls `useRouter()` (plan 91 §5 step 91.8, F13 — the
 * click/double-click disambiguation below) — `@/lib/test/nav` has to be
 * imported, for its `mock.module` side effect, before `WallTile` itself is
 * first evaluated, hence the dynamic import after it (same pattern
 * `Wall.test.tsx`, the sibling file, already uses for its own `mock.module`
 * calls).
 */
const { WallTile } = await import('./WallTile')

afterEach(() => {
  cleanup()
  mockRouter.push.mockClear()
})

/**
 * `live={false}` on an eligible (non-offline, non-quarantined) device takes
 * the "Show live" branch rather than mounting `LiveView` — deliberately, so
 * this file never has to stand up a WebCodecs/WS video decoder to test the
 * chrome around the picture (the same reason `Wall.test.tsx` mocks
 * `WallTile` out entirely for ITS OWN tests: `LiveView` is a different
 * component's concern).
 */
const device: DeviceInfo = {
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
}

/** The guest-agent alert chip (plan 90 §5 step 90.6, fixes F10) — same quiet-by-default rule `DeviceCard.test.tsx` asserts, on the Wall's own tile. */
describe('WallTile — the guest-agent alert chip (plan 90 §5 step 90.6, fixes F10)', () => {
  test('no chip for a device that predates the field (reads as absent)', () => {
    const { queryByText } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(queryByText(/Agent /)).toBeNull()
  })

  test('no chip for ready', () => {
    const { queryByText } = renderWithApi(
      <WallTile device={{ ...device, agent: 'ready' }} live={false} onShowLive={() => undefined} />,
    )
    expect(queryByText(/Agent /)).toBeNull()
  })

  test('a chip for failed', () => {
    const { getByText } = renderWithApi(
      <WallTile device={{ ...device, agent: 'failed' }} live={false} onShowLive={() => undefined} />,
    )
    expect(getByText('Agent failed')).toBeTruthy()
  })

  test('a chip for outdated', () => {
    const { getByText } = renderWithApi(
      <WallTile device={{ ...device, agent: 'outdated' }} live={false} onShowLive={() => undefined} />,
    )
    expect(getByText('Agent outdated')).toBeTruthy()
  })
})

/** `assistedBy` on the Wall (plan 91 §3.4 item 4, §4.4, F25) — same guard `DeviceCard.test.tsx` proves, on the Wall's own tile. */
describe('WallTile — assistedBy (plan 91 §3.4 item 4, §4.4, F25)', () => {
  test('a device that predates the field shows no assist badge', () => {
    const { queryByTitle } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(queryByTitle(/Assisting/)).toBeNull()
  })

  test('a held device being assisted shows both the holder badge and the assist badge', () => {
    const heldDevice: DeviceInfo = {
      ...device,
      status: 'manual',
      heldBy: { kind: 'user', id: 'u2', label: 'Bob', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
      assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }],
    }
    const { getByTitle } = renderWithApi(<WallTile device={heldDevice} live={false} onShowLive={() => undefined} />)
    expect(getByTitle('Controlled by Bob')).toBeTruthy()
    expect(getByTitle('Assisting — Alice')).toBeTruthy()
  })

  /**
   * Plan 91 §3.4 item 4 gap 3: `WallTile`'s own root element is a
   * `next/link`, and `HolderBadge` used to render a `job`/`agent` holder as
   * its own NESTED `<Link>` — invalid HTML (an `<a>` inside an `<a>`), which
   * no prior `WallTile` test ever exercised because the one above uses a
   * `user`-kind holder specifically to sidestep it. `HolderBadge` now takes
   * `asLink={false}` here, so a job holder renders as a plain `<span>`
   * instead — this proves that directly, with a REAL job/agent holder on the
   * Wall for the first time, rather than continuing to avoid the case.
   */
  test('a job holder renders as a plain span, not a nested Link (invalid HTML)', () => {
    const jobHeldDevice: DeviceInfo = {
      ...device,
      status: 'busy',
      heldBy: { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
    }
    const { getByTitle, container } = renderWithApi(
      <WallTile device={jobHeldDevice} live={false} onShowLive={() => undefined} />,
    )
    const badge = getByTitle('Running checkout@1.4.2')
    expect(badge.tagName).toBe('SPAN')
    // No nested <a>: the tile's own root Link is the only anchor on the page.
    expect(container.querySelectorAll('a').length).toBe(1)
  })

  test('an agent holder also renders as a plain span, not a nested Link', () => {
    const agentHeldDevice: DeviceInfo = {
      ...device,
      status: 'manual',
      heldBy: { kind: 'agent', id: 'agent-1', label: 'triage-bot', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    }
    const { getByTitle, container } = renderWithApi(
      <WallTile device={agentHeldDevice} live={false} onShowLive={() => undefined} />,
    )
    const badge = getByTitle('Driven by triage-bot')
    expect(badge.tagName).toBe('SPAN')
    expect(container.querySelectorAll('a').length).toBe(1)
  })
})

/**
 * Group selection (plan 91 §3.11/§5 step 91.8, F11/F12) — the same
 * `selectable`/`selected`/`onToggleSelect` shape `DeviceCard.test.tsx`
 * already covers, proven here on the Wall's own tile.
 */
describe('WallTile — group selection (plan 91 §5 step 91.8, F11/F12)', () => {
  test('no checkbox at all when not selectable', () => {
    const { queryByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(queryByRole('checkbox')).toBeNull()
  })

  test('unselected by default, toggles on click, and does not navigate', () => {
    let selected = false
    const onToggleSelect = () => {
      selected = true
    }
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} selectable selected={selected} onToggleSelect={onToggleSelect} />,
    )
    const checkbox = getByRole('checkbox', { name: 'Select moto g06 for a batch action' }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(selected).toBe(true)
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('a selected tile carries the accent outline', () => {
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} selectable selected onToggleSelect={() => {}} />,
    )
    const tile = getByRole('link')
    expect(tile.className).toContain('border-accent')
    expect(tile.className).toContain('ring-accent')
    expect((getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })
})

/**
 * Double-click to focus, and single click still navigates (plan 91 §3.11/§5
 * step 91.8, F13) — the pair this step's own brief calls out as protecting
 * existing product behaviour: adding the double-click must not silently
 * break the single click every other tile in the workspace still relies on.
 */
describe('WallTile — click vs double-click (plan 91 §3.11/§5 step 91.8, F13)', () => {
  test('a single click still navigates to the device page', async () => {
    const { getByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    fireEvent.click(getByRole('link'))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/device?id=dev-1'))
  })

  test('a genuine double-click calls onFocus instead of navigating', async () => {
    const user = userEvent.setup()
    let focused = false
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onFocus={() => (focused = true)} />,
    )
    // `userEvent.dblClick` fires the REAL sequence (click, click, dblclick) a
    // browser would, unlike `fireEvent.doubleClick`, which fires only the
    // `dblclick` event — this is the one test that actually exercises the
    // click-vs-double-click race the component's own header comment
    // describes, not merely the two handlers in isolation.
    await user.dblClick(getByRole('link'))
    expect(focused).toBe(true)
    // Long enough to catch a navigation the double-click failed to cancel.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('with no onFocus at all, a double-click is inert rather than throwing', async () => {
    const user = userEvent.setup()
    const { getByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    await user.dblClick(getByRole('link'))
    // Still navigates once, from the (uncancelled) first click's own timer.
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/device?id=dev-1'))
  })
})

/** The "Controlling here" placeholder for the focused tile (plan 91 §3.11/§5 step 91.8). */
describe('WallTile — the focused placeholder (plan 91 §3.11/§5 step 91.8)', () => {
  test('a live, focused tile shows the placeholder instead of LiveView, and stays a single link', () => {
    const { getByText, getByRole, queryByText } = renderWithApi(
      <WallTile device={device} live onShowLive={() => undefined} focused />,
    )
    expect(getByText('Controlling here')).toBeTruthy()
    expect(queryByText('Show live')).toBeNull()
    // Still exactly one anchor — the placeholder is not a second link.
    expect(getByRole('link')).toBeTruthy()
  })

  test('an unfocused tile never shows the placeholder', () => {
    // `live={false}` — same reason the file header gives for every other
    // test here: sidesteps mounting the real `LiveView` (a WebCodecs/WS
    // video decoder), which is not this test's concern.
    const { queryByText } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(queryByText('Controlling here')).toBeNull()
  })
})

const busyDevice: DeviceInfo = { ...device, status: 'busy' }

const runningJob = {
  jobId: 'job-1',
  deviceId: 'dev-1',
  scriptId: 'wf-1',
  scriptName: 'my-pipeline',
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
} satisfies JobInfo

/**
 * The caption's live node counter (plan 99 §4.9, §4.11, step 99.10) —
 * "workflow · node 2/4". `runningJob`'s declared type (`JobInfo`, from
 * `@enkaku/protocol`) carries no `node` field at all; it only ever arrives
 * on a job a live `job.status` WS push has touched (this file's own
 * `liveNode`/its module doc explains why it is read defensively rather than
 * declared on a wider prop type). Cast at the test boundary, matching
 * `JobsList.test.tsx`'s own precedent for the identical situation.
 */
describe('WallTile — the caption\'s live node counter (plan 99 §4.9, §4.11, step 99.10)', () => {
  test('a busy device with no node info shows the script name alone', () => {
    const { getByText, queryByText } = renderWithApi(
      <WallTile device={busyDevice} runningJob={runningJob} live={false} onShowLive={() => undefined} />,
    )
    expect(getByText('my-pipeline')).toBeTruthy()
    expect(queryByText(/node \d\/\d/)).toBeNull()
  })

  test('a running workflow node appends "node 2/4" to the caption', () => {
    const withNode = {
      ...runningJob,
      node: { id: 'search1', seq: 1, total: 4, kind: 'script', script: 'tiktok/search@1.0.0', status: 'running' },
    } as unknown as JobInfo
    const { getByText } = renderWithApi(
      <WallTile device={busyDevice} runningJob={withNode} live={false} onShowLive={() => undefined} />,
    )
    expect(getByText('my-pipeline · node 2/4')).toBeTruthy()
  })
})

const asleepDevice: DeviceInfo = { ...device, readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 } }

/**
 * The screen-off placeholder (Plan 92 §3.2 rule 1, §3.4, §4.7, fixes F12):
 * looking at the wall must never wake a phone nobody asked to wake, so an
 * asleep device NEVER mounts `LiveView` — checked here with `live` (a
 * device could end up in the caller's live set before the caller itself
 * excludes asleep devices from it, e.g. before Plan 92's later live-set
 * policy step lands), not just `live={false}`, precisely because that is
 * the case the placeholder exists to guard.
 */
describe('WallTile — the screen-off placeholder for asleep devices (plan 92 §3.2 rule 1, §4.7, fixes F12)', () => {
  test('an asleep device shows "Screen off" and never mounts LiveView, even when live={true}', () => {
    const { getByText, queryByLabelText } = renderWithApi(<WallTile device={asleepDevice} live onShowLive={() => undefined} />)
    expect(getByText('Screen off')).toBeTruthy()
    // `LiveView` renders a canvas labelled "Device screen" — its absence
    // here is the proof no decoder (and so no wake-triggering session) was
    // ever started for this tile.
    expect(queryByLabelText('Device screen')).toBeNull()
  })

  test('an asleep device still shows "Screen off" when live={false} too', () => {
    const { getByText } = renderWithApi(<WallTile device={asleepDevice} live={false} onShowLive={() => undefined} />)
    expect(getByText('Screen off')).toBeTruthy()
  })

  test('the Wake action on an asleep tile is shown persistently, not hover-revealed', () => {
    const { getByRole } = renderWithApi(<WallTile device={asleepDevice} live={false} onShowLive={() => undefined} />)
    const wake = getByRole('button', { name: 'Wake' })
    // Persistent (plan 48 §3.3 rule 3, kept for device conditions by plan 92
    // §3.4): the overlay wrapper carries `opacity-100`, not the hover-reveal
    // `opacity-0` a live or budgeted tile's own overlay uses.
    const wrapper = wake.closest('.pointer-events-auto.opacity-100')
    expect(wrapper).toBeTruthy()
  })
})

/**
 * The quiet budgeted state (Plan 92 §3.4, §4.7): a tile outside
 * `wall.maxTiles` is eligible and awake but simply not streaming right now
 * — a wall-policy state, not a fact about the phone, so its "Show live"
 * glyph is hover/focus-revealed like a live tile's own overlay rather than
 * shown as a persistent button. A farm where most tiles are budgeted must
 * not read as a wall of alarms (§3.4's own words).
 */
describe('WallTile — the quiet budgeted state (plan 92 §3.4, §4.7)', () => {
  test('an eligible, awake, non-live ("budgeted") tile shows "Show live" hover-revealed, not persistently', () => {
    const { getByText } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const label = getByText('Show live')
    expect(label.className).toContain('opacity-0')
    expect(label.className).toContain('group-hover:opacity-100')
  })

  test('clicking the budgeted placeholder calls onShowLive and does not navigate', () => {
    let shown = false
    const { getByText } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => (shown = true)} />,
    )
    fireEvent.click(getByText('Show live'))
    expect(shown).toBe(true)
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('the bottom Wake/Sleep overlay on a budgeted tile is also hover-revealed, not persistent (matches a live tile)', () => {
    const { getByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const sleep = getByRole('button', { name: 'Sleep' })
    const wrapper = sleep.closest('.opacity-0')
    expect(wrapper).toBeTruthy()
  })
})

/**
 * The tile layout for the fields plans 88 and 89 add (plan 92 §4.8): line 1
 * becomes number · label · connection glyph, the tile becomes a container
 * query context, and the holder chip moves off the header and onto the
 * picture. `tile-identity.test.ts` covers `tileIdentityOf` itself in
 * isolation; these tests cover what `WallTile` DOES with it.
 */
describe('WallTile — line 1: number · label · connection glyph (plan 89 §3.3, plan 92 §4.8)', () => {
  test('a device with no number (an explicitly released reservation) renders a dash', () => {
    const { container } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    // Selected by its own fixed-width class rather than `getByText('—')`:
    // `TileChips` renders the SAME dash glyph for a missing battery/
    // temperature reading (`device.battery` is null on this fixture), so
    // more than one dash is on the tile at once.
    const numberSlot = container.querySelector('.w-8')
    expect(numberSlot?.textContent).toBe('—')
    // A fixed-width slot, not merely absent text (§4.8): the number occupies
    // the SAME space whether it is one, two, or three digits, so a tile's
    // layout never shifts as a fleet grows.
    expect(numberSlot?.className).toContain('readout')
  })

  test('the number renders as `#42`, never bare `42`', () => {
    const numberedDevice = { ...device, number: 42 }
    const { container } = renderWithApi(<WallTile device={numberedDevice} live={false} onShowLive={() => undefined} />)
    expect(container.querySelector('.w-8')?.textContent).toBe('#42')
  })

  test('the connection glyph carries the same tooltip `ConnectionBadge` would show — a USB device by default (no `connection` field on this fixture)', () => {
    const { getByTitle } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(getByTitle('Connected by cable to this computer')).toBeTruthy()
  })

  test('a Wi-Fi device shows the Wi-Fi tooltip with its address, never a text badge', () => {
    const wifiDevice: DeviceInfo = {
      ...device,
      // `port: null` — `connectionTooltip` (`ConnectionBadge.tsx`) folds a
      // present port into the address as `host:port`; this test wants the
      // plain address for a simpler assertion, which is the tooltip's own
      // established shape for a device with no separately-tracked port.
      connection: { kind: 'tcp', medium: 'wireless', mediumSource: 'declared', address: '10.0.0.5', port: null, networkLabel: null },
    }
    const { getByTitle, queryByText } = renderWithApi(<WallTile device={wifiDevice} live={false} onShowLive={() => undefined} />)
    expect(getByTitle('On the network over Wi-Fi · 10.0.0.5')).toBeTruthy()
    // The IP itself is deliberately NOT printed on the tile (§4.8) — it is
    // the glyph's tooltip/accessible name, searchable and filterable
    // elsewhere (`page.tsx`) instead of spending permanent tile space.
    expect(queryByText('10.0.0.5')).toBeNull()
  })

  test('the tile establishes a container query context (`@container`) for the chip row\'s drop order', () => {
    const { getByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(getByRole('link').className).toContain('@container')
  })
})

/**
 * The height-stability clause (plan 92 §4.8's own verifiable result): a
 * tile's height must be IDENTICAL whether or not the device is held. There
 * is no real CSS layout engine under happy-dom (`getBoundingClientRect`
 * always reads zero), so the mechanism that guarantees it is asserted
 * directly instead of a pixel measurement: the header block's own DOM
 * structure — the only part of the tile with a fixed, content-driven height
 * — has the SAME number of children whether or not `heldBy`/`assistedBy` is
 * present, because the holder chip now renders inside the picture
 * container (an absolutely positioned overlay, which does not participate
 * in the picture's own `aspect-[9/16]` sizing) rather than as a third line
 * in the header.
 */
describe('WallTile — height stability: the holder no longer changes the header (plan 92 §4.8, fixes F31)', () => {
  test('the header block has the same number of children with vs without a holder', () => {
    const heldDevice: DeviceInfo = {
      ...device,
      status: 'manual',
      heldBy: { kind: 'user', id: 'u2', label: 'Bob', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    }
    const plain = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const held = renderWithApi(<WallTile device={heldDevice} live={false} onShowLive={() => undefined} />)
    const plainHeader = plain.container.querySelector('a')?.children[0]
    const heldHeader = held.container.querySelector('a')?.children[0]
    expect(plainHeader).toBeTruthy()
    expect(heldHeader).toBeTruthy()
    expect(heldHeader?.children.length).toBe(plainHeader?.children.length)
  })

  test('the holder badge itself renders inside the picture container, not the header', () => {
    const heldDevice: DeviceInfo = {
      ...device,
      status: 'manual',
      heldBy: { kind: 'user', id: 'u2', label: 'Bob', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    }
    const { container, getByTitle } = renderWithApi(<WallTile device={heldDevice} live={false} onShowLive={() => undefined} />)
    const root = container.querySelector('a')
    const header = root?.children[0]
    const picture = root?.children[1]
    const badge = getByTitle('Controlled by Bob')
    expect(header?.contains(badge)).toBe(false)
    expect(picture?.contains(badge)).toBe(true)
  })

  test('with no holder or assist at all, the picture container renders no holder-overlay wrapper', () => {
    const { container } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(container.textContent).not.toContain('Controlled by')
    expect(container.textContent).not.toContain('Assisting')
  })
})
