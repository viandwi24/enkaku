import { afterEach, describe, expect, mock, test } from 'bun:test'
import { useEffect } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import '@/lib/test/nav'
import { mockRouter } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The picture itself, stubbed. Plan 125 §4.3 gave this file its first tests
 * about WHETHER `LiveView` is mounted and — the point of the whole step —
 * whether it stays the SAME instance across a readiness change, and neither
 * question can be asked of a component that stands up a real WebCodecs
 * decoder over a live WS stream. The stub keeps the one handle the older
 * tests here already assert against (`aria-label="Device screen"`, which is
 * the real component's own canvas label), and adds a mount counter: a
 * remount is exactly the defect being fixed, so it has to be observable and
 * not merely presumed from the picture still being on screen.
 *
 * `mock.module` has to run before `WallTile` is first evaluated, hence the
 * dynamic import below — the same ordering `@/lib/test/nav` above needs for
 * `useRouter` (plan 91 §5 step 91.8, F13), and the same pattern
 * `Wall.test.tsx` uses for its own mocks.
 */
const liveViewMounts: string[] = []
/**
 * Every `markLiveViewIntent` call this tile makes (plan 125 §4.7, step
 * 125.11) — the click→first-paint mark. Recorded rather than executed for the
 * same reason the component itself is stubbed: the real one writes into a
 * module-level map inside `LiveView.tsx`, and this file's whole point is to
 * test the tile without standing up the video component.
 */
const intentMarks: string[] = []
mock.module('@/components/LiveView', () => ({
  LiveView: ({ deviceId }: { deviceId: string }) => {
    useEffect(() => {
      liveViewMounts.push(deviceId)
    }, [deviceId])
    return <canvas aria-label="Device screen" />
  },
  markLiveViewIntent: (deviceId: string) => intentMarks.push(deviceId),
}))

const { WallTile } = await import('./WallTile')

afterEach(() => {
  cleanup()
  mockRouter.push.mockClear()
  liveViewMounts.length = 0
  intentMarks.length = 0
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

/**
 * Plan 101 §5 step 101.7 — `AgentAlertChip` left the tile entirely (the
 * owner's requirement 3: no status text or chips in the tile panel at all).
 * The signal it used to carry did not vanish with it: it folds into
 * `.status-rail`'s own colour instead, via `data-agent-alert`, so a device
 * casting a perfectly good picture with a genuinely broken agent still does
 * not read as healthy. Same quiet-by-default rule `AgentAlertChip.tsx` (and
 * `DeviceCard.test.tsx`) assert — ready/absent/provisioning/unsupported stay
 * quiet, only failed/outdated tint the rail — proven here against the rail's
 * own attribute rather than chip text, because there is no chip left to find.
 */
describe('WallTile — the guest-agent alert folded into the status rail (plan 101 §5 step 101.7)', () => {
  test('no rail tint for a device that predates the field (reads as absent)', () => {
    const { container } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(container.querySelector('.status-rail')?.getAttribute('data-agent-alert')).toBeNull()
  })

  test('no rail tint for ready', () => {
    const { container } = renderWithApi(
      <WallTile device={{ ...device, agent: 'ready' }} live={false} onShowLive={() => undefined} />,
    )
    expect(container.querySelector('.status-rail')?.getAttribute('data-agent-alert')).toBeNull()
  })

  test('the rail carries data-agent-alert="failed" for a failed agent', () => {
    const { container } = renderWithApi(
      <WallTile device={{ ...device, agent: 'failed' }} live={false} onShowLive={() => undefined} />,
    )
    expect(container.querySelector('.status-rail')?.getAttribute('data-agent-alert')).toBe('failed')
  })

  test('the rail carries data-agent-alert="outdated" for an outdated agent', () => {
    const { container } = renderWithApi(
      <WallTile device={{ ...device, agent: 'outdated' }} live={false} onShowLive={() => undefined} />,
    )
    expect(container.querySelector('.status-rail')?.getAttribute('data-agent-alert')).toBe('outdated')
  })

  /**
   * The rail's two loudest existing colours (offline/quarantined) already
   * say "something is wrong here," and there is nothing an operator can do
   * about a device's agent while it is not even connected — so a failed/
   * outdated agent does not override those two conditions.
   */
  test('no rail tint for a failed agent on an offline device — the device condition already dominates', () => {
    const { container } = renderWithApi(
      <WallTile device={{ ...device, status: 'offline', agent: 'failed' }} live={false} onShowLive={() => undefined} />,
    )
    expect(container.querySelector('.status-rail')?.getAttribute('data-agent-alert')).toBeNull()
  })

  test('no rail tint for a failed agent on a quarantined device — same reason', () => {
    const { container } = renderWithApi(
      <WallTile device={{ ...device, status: 'quarantined', agent: 'failed' }} live={false} onShowLive={() => undefined} />,
    )
    expect(container.querySelector('.status-rail')?.getAttribute('data-agent-alert')).toBeNull()
  })
})

/**
 * `.status-rail` itself (plan 101 §5 step 101.7's own "the one thing to
 * keep" — the tile's now-only ambient status signal, since the header/chips
 * that used to say the same thing in words are gone). Mirrors the same
 * `data-status`/`data-live` contract `DeviceCard.test.tsx` and
 * `DeviceTile.test.tsx` already prove for their own rails, newly true here.
 */
describe('WallTile — the status rail (plan 101 §5 step 101.7, docs/design.md\'s "signature element")', () => {
  test('carries data-status matching the device, and only pulses (data-live) while busy', () => {
    const { container } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const rail = container.querySelector('.status-rail')
    expect(rail).toBeTruthy()
    expect(rail?.getAttribute('data-status')).toBe('idle')
    expect(rail?.getAttribute('data-live')).toBe('false')
  })

  test('a busy device pulses', () => {
    const { container } = renderWithApi(<WallTile device={{ ...device, status: 'busy' }} live={false} onShowLive={() => undefined} />)
    const rail = container.querySelector('.status-rail')
    expect(rail?.getAttribute('data-status')).toBe('busy')
    expect(rail?.getAttribute('data-live')).toBe('true')
  })

  test('a quarantined device\'s rail says so even though the tile carries no status TEXT anywhere', () => {
    const quarantinedDevice = { ...device, status: 'quarantined' as const }
    const { container, queryByText } = renderWithApi(<WallTile device={quarantinedDevice} live={false} onShowLive={() => undefined} />)
    expect(container.querySelector('.status-rail')?.getAttribute('data-status')).toBe('quarantined')
    // "Quarantined" DOES appear (the picture's own placeholder, requirement
    // 3's "only when the cast is empty") — this asserts the rail is a SEPARATE
    // signal from that text, not a replacement for it.
    expect(queryByText('Quarantined')).toBeTruthy()
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
      // Plan 105 §3.2 — a fresh `expiresAt` (just touched) so this reads
      // "Assisting", not "May assist" (`HolderBadge`'s activity split).
      assistedBy: [{ kind: 'user', id: 'u1', label: 'Alice', runId: null, takeable: false, acquiredAt: 0, expiresAt: Math.floor(Date.now() / 1000) + 300 }],
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
 * Group selection (plan 91 §3.11/§5 step 91.8, F11/F12) — rebuilt in plan
 * 101 §5 step 101.7 (folded in mid-step, 2026-08-16) around a click on the
 * tile itself instead of a checkbox (`refs/ui`'s own model: a click selects,
 * a double-click opens remote control). No checkbox exists anywhere on this
 * component any more, matched by `DeviceCard.test.tsx`'s own equivalent
 * rewrite.
 */
describe('WallTile — click-to-toggle selection (plan 91 §5 step 91.8, F11/F12; rebuilt plan 101 §5 step 101.7)', () => {
  test('no checkbox anywhere on the tile', () => {
    const { queryByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onToggleSelect={() => {}} />,
    )
    expect(queryByRole('checkbox')).toBeNull()
  })

  test('a click toggles selection instead of navigating, once the double-click window elapses', async () => {
    let selected = false
    const onToggleSelect = () => {
      selected = true
    }
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onToggleSelect={onToggleSelect} />,
    )
    fireEvent.click(getByRole('link'))
    await waitFor(() => expect(selected).toBe(true))
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('with no onToggleSelect at all, a click falls back to navigating (never a silent no-op)', async () => {
    const { getByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    fireEvent.click(getByRole('link'))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/device?id=dev-1'))
  })

  test('a selected tile carries the accent outline', () => {
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} selected onToggleSelect={() => {}} />,
    )
    const tile = getByRole('link')
    expect(tile.className).toContain('border-accent')
    expect(tile.className).toContain('ring-accent')
  })

  test('a modified click (ctrl/cmd/middle) is left alone — the browser\'s own "open in a new tab", never a toggle', () => {
    let toggled = false
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onToggleSelect={() => (toggled = true)} />,
    )
    fireEvent.click(getByRole('link'), { metaKey: true })
    expect(toggled).toBe(false)
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

  /**
   * Click → first paint (plan 125 §4.7, §5 step 125.11). The double-click IS
   * the start of the measurement, so it has to be marked here — nothing
   * downstream (`app/page.tsx`'s `?focus=`, `DevicePopup`, `LiveView`) knows
   * when the operator clicked. The number itself is `LiveView`'s to compute
   * and render; this file only proves the mark is taken, once, at the click.
   */
  test('a double-click marks the click→first-paint start for this device', async () => {
    const user = userEvent.setup()
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onFocus={() => undefined} />,
    )
    await user.dblClick(getByRole('link'))
    expect(intentMarks).toEqual(['dev-1'])
  })

  test('a single click marks nothing — selecting a tile is not asking for its picture', async () => {
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onToggleSelect={() => undefined} />,
    )
    fireEvent.click(getByRole('link'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(intentMarks.length).toBe(0)
  })

  test('a modified double-click (the browser\'s own "open in a new tab") marks nothing either', async () => {
    const user = userEvent.setup()
    const { getByRole } = renderWithApi(
      <WallTile device={device} live={false} onShowLive={() => undefined} onFocus={() => undefined} />,
    )
    await user.keyboard('{Meta>}')
    await user.dblClick(getByRole('link'))
    await user.keyboard('{/Meta}')
    expect(intentMarks.length).toBe(0)
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

/**
 * `number: 4` (plan 124 §3.1, `docs/design.md` "Naming a device") — the Wake
 * button added by plan 125 §3.5 names its device in the `aria-label`, and a
 * fixture with no number would let the tests below pass against a name that
 * identifies nothing on a rack of identical phones.
 */
const asleepDevice: DeviceInfo = { ...device, number: 4, readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: 0 } }

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

  /**
   * Plan 101 §5 step 101.8 removed the persistent `ReadinessControl`
   * (Wake/Sleep) overlay from every tile face, and **plan 125 §3.5/§4.3
   * brings back exactly half of it**: a compact Wake INSIDE the screen-off
   * placeholder, where there is no picture for it to compete with. 101.8's
   * actual rule — a tile showing a picture carries no chrome but the number,
   * the name and the rail — is untouched, and the test below pins that half
   * so the reversal cannot creep back onto a live tile.
   *
   * The field report (plan 125 §0.1 report 1): *"I have to double-click each
   * device to make it wake up … Do I really have to trigger a wake-up one by
   * one? That takes forever."* Plan 92 §8 had already claimed this
   * affordance existed — *"The tiles are explicitly 'Screen off' with a
   * working Wake"* — which 101.8 silently made false.
   */
  test('an asleep tile offers a compact Wake, named with the device (plan 125 §3.5)', () => {
    const { getByRole } = renderWithApi(<WallTile device={asleepDevice} live={false} onShowLive={() => undefined} />)
    // `docs/design.md`'s "Naming a device" rule reaches `aria-label`s too —
    // a rack of identical `SM-F721U1` needs the number to identify anything.
    expect(getByRole('button', { name: 'Wake #4 moto g06' })).toBeTruthy()
  })

  test('the Wake button PUTs the readiness the context menu and the selection bar already use', async () => {
    const { getByRole, apiMock } = renderWithApi(
      <WallTile device={asleepDevice} live={false} onShowLive={() => undefined} />,
      { '/api/devices/*/readiness': { body: { readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 } } } },
    )
    fireEvent.click(getByRole('button', { name: 'Wake #4 moto g06' }))
    await waitFor(() => expect(apiMock.calls.length).toBe(1))
    expect(apiMock.calls[0]?.method).toBe('PUT')
    expect(apiMock.calls[0]?.path).toBe('/api/devices/dev-1/readiness')
    expect(apiMock.calls[0]?.body).toMatchObject({ desired: 'awake' })
  })

  /**
   * The tile's root is a `next/link` and a plain click toggles selection
   * (plan 101 §5 step 101.7) — a Wake that also selected the tile, or
   * navigated to the device page, would be the same defect the budgeted
   * "Show live" button already guards against.
   */
  test('waking does not also toggle selection or navigate', async () => {
    let toggled = 0
    const { getByRole, apiMock } = renderWithApi(
      <WallTile device={asleepDevice} live={false} onShowLive={() => undefined} onToggleSelect={() => (toggled += 1)} />,
      { '/api/devices/*/readiness': { body: { readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 } } } },
    )
    fireEvent.click(getByRole('button', { name: 'Wake #4 moto g06' }))
    await waitFor(() => expect(apiMock.calls.length).toBe(1))
    expect(toggled).toBe(0)
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  /** 101.8's surviving half: a tile that is SHOWING something carries no readiness chrome. */
  test('no Wake or Sleep button on a live tile — 101.8s rule holds wherever there is a picture', () => {
    const { queryAllByRole } = renderWithApi(<WallTile device={device} live onShowLive={() => undefined} />)
    expect(queryAllByRole('button').length).toBe(0)
  })
})

/**
 * **Plan 125 §0.5, §3.5, §4.3 — the branch reorder, and report 1's own
 * defect.** A display error closes the session entry even with live
 * subscribers (`packages/session/src/manager.ts`'s `onDisplayError`), the
 * core broadcasts `stream.ended`, readiness reconciles the device down to
 * `asleep`, and — before this step — the `asleep` branch replaced the
 * picture with an inert "Screen off" rectangle. `LiveView`'s own "Stream
 * stopped … Try again" overlay existed the whole time; nobody ever saw it,
 * because the component holding it was unmounted in the same commit.
 *
 * These tests assert the two halves of the fix that actually matter, and
 * neither of them is "the picture is on screen":
 *
 *  1. the picture SURVIVES the flip to `asleep` **as the same instance** —
 *     a remount would restart the stream and throw away the very `stopped`
 *     state that carries the retry;
 *  2. a latched error may only ever KEEP a picture, never CREATE one — or a
 *     wall tile would start a session on a sleeping phone just by being
 *     looked at, which is plan 92 F11/F12 reintroduced.
 */
describe('WallTile — a dead stream keeps its retry instead of going dark (plan 125 §4.3)', () => {
  test('a stream error keeps the SAME LiveView mounted when the device flips to asleep', () => {
    const { rerender, queryAllByLabelText, queryAllByText } = renderWithApi(
      <WallTile device={device} live onShowLive={() => undefined} />,
    )
    expect(liveViewMounts.length).toBe(1)

    // Exactly what the core does after a display error: `stream.ended`
    // arrives (latched by `Wall.tsx`, handed down here) and the device's own
    // `readiness.actual` reconciles to `asleep`, dropping it out of the live
    // set in the same update.
    rerender(<WallTile device={asleepDevice} live={false} streamError="display error" onShowLive={() => undefined} />)

    // Counts, never nodes: a failing `expect(node).toBeNull()` inside a
    // retrying matcher serialises a whole happy-dom element.
    expect(queryAllByLabelText('Device screen').length).toBe(1)
    expect(queryAllByText('Screen off').length).toBe(0)
    // The whole point: one mount, not two. A second entry here would mean
    // `LiveView` was torn down and rebuilt — a fresh `stream.start` on a
    // sleeping phone, and no retry overlay to show for it.
    expect(liveViewMounts.length).toBe(1)
  })

  test('a stream error on a tile that was NOT showing a picture never mounts one', () => {
    // Budgeted (awake, outside `wall.maxTiles`) — the tile has no decoder,
    // and a `stream.ended` broadcast for this device (someone else's popup
    // session dying, say) must not give it one.
    const { queryAllByLabelText, queryAllByText } = renderWithApi(
      <WallTile device={device} live={false} streamError="display error" onShowLive={() => undefined} />,
    )
    expect(liveViewMounts.length).toBe(0)
    expect(queryAllByLabelText('Device screen').length).toBe(0)
    expect(queryAllByText('Show live').length).toBe(1)
  })

  test('an asleep tile with a stale error latched, but no picture ever mounted, still shows Screen off and its Wake', () => {
    const { queryAllByLabelText, getByRole } = renderWithApi(
      <WallTile device={asleepDevice} live={false} streamError="display error" onShowLive={() => undefined} />,
    )
    expect(queryAllByLabelText('Device screen').length).toBe(0)
    expect(getByRole('button', { name: 'Wake #4 moto g06' })).toBeTruthy()
  })

  /** offline/quarantined are facts about the phone and still outrank a dead stream — "Offline" is the truer and more actionable statement, and it is what `Wall.tsx` clears the latch on. */
  test('offline still wins over a latched stream error', () => {
    const { queryAllByLabelText, queryAllByText } = renderWithApi(
      <WallTile device={{ ...device, status: 'offline' }} live streamError="display error" onShowLive={() => undefined} />,
    )
    expect(queryAllByText('Offline').length).toBe(1)
    expect(queryAllByLabelText('Device screen').length).toBe(0)
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

  /** Plan 101 §5 step 101.8 — no Sleep button on a budgeted tile either; see the asleep-tile test above for where it went. */
  test('no Sleep button on a budgeted tile', () => {
    const { queryByRole } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(queryByRole('button', { name: 'Sleep' })).toBeNull()
  })
})

/**
 * Plan 101 §5 step 101.7 — the tile shows the screencast and almost nothing
 * else. The connection glyph and the battery/temperature/readiness/status
 * chip row (plan 88/89/92 §4.8) left the tile and stay gone; the name
 * floats over the picture instead of sitting in a header line above it.
 * **The per-device number was owner-reversed back onto the tile,
 * 2026-08-19** — stacked on its own line directly above the name, not
 * step 101.7's old inline "beside the label" shape. `tile-identity.test.ts`
 * still covers `tileIdentityOf` itself (`DeviceCard` reads it); these tests
 * cover what `WallTile` does with the number and the name directly.
 */
describe('WallTile — the screencast plus the number and name (plan 101 §5 step 101.7, reversed for the number 2026-08-19)', () => {
  test('the number floats above the name, `#N` — never a bare or zero-padded digit', () => {
    const numberedDevice = { ...device, number: 42 }
    const { getByText } = renderWithApi(<WallTile device={numberedDevice} live={false} onShowLive={() => undefined} />)
    expect(getByText('#42')).toBeTruthy()
  })

  test('a device with no number reservation yet shows no number — never a fake `#0`', () => {
    const unnumberedDevice = { ...device, number: null }
    const { queryByText } = renderWithApi(<WallTile device={unnumberedDevice} live={false} onShowLive={() => undefined} />)
    expect(queryByText(/^#/)).toBeNull()
  })

  test('no connection-glyph tooltip anywhere on the tile', () => {
    const { queryByTitle } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(queryByTitle('Connected by cable to this computer')).toBeNull()
  })

  test('the name floats over the picture, horizontally centred', () => {
    const { getByText } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const name = getByText('moto g06')
    expect(name.className).toContain('text-center')
    expect(name.className).toContain('top-2')
  })

  test('the name sits inside the aspect-ratio picture, not in a separate header above it', () => {
    const { getByText, container } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const name = getByText('moto g06')
    const picture = container.querySelector('.aspect-\\[9\\/16\\]')
    expect(picture).toBeTruthy()
    expect(picture?.contains(name)).toBe(true)
  })
})

/**
 * The height-stability clause (plan 92 §4.8's own verifiable result, still
 * true after plan 101 §5 step 101.7 deleted the header entirely): a tile's
 * height must be IDENTICAL whether or not the device is held. There is no
 * real CSS layout engine under happy-dom (`getBoundingClientRect` always
 * reads zero), so the mechanism that guarantees it is asserted directly
 * instead of a pixel measurement — with the header gone, the root `Link` has
 * exactly two children now (the status rail, then the picture) regardless of
 * `heldBy`/`assistedBy`, because the holder chip renders as an absolutely
 * positioned overlay INSIDE the picture, never as a sibling that could add a
 * third root child and change the tile's own box height.
 */
describe('WallTile — height stability: no header left to grow (plan 92 §4.8 fixes F31, plan 101 §5 step 101.7)', () => {
  test('the root Link has the same two children (rail, picture) with vs without a holder', () => {
    const heldDevice: DeviceInfo = {
      ...device,
      status: 'manual',
      heldBy: { kind: 'user', id: 'u2', label: 'Bob', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    }
    const plain = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    const held = renderWithApi(<WallTile device={heldDevice} live={false} onShowLive={() => undefined} />)
    const plainRoot = plain.container.querySelector('a')
    const heldRoot = held.container.querySelector('a')
    expect(plainRoot?.children.length).toBe(2)
    expect(heldRoot?.children.length).toBe(plainRoot?.children.length)
  })

  test('the holder badge itself renders inside the picture container, not as a sibling of the rail', () => {
    const heldDevice: DeviceInfo = {
      ...device,
      status: 'manual',
      heldBy: { kind: 'user', id: 'u2', label: 'Bob', runId: null, takeable: true, acquiredAt: 0, expiresAt: null },
    }
    const { container, getByTitle } = renderWithApi(<WallTile device={heldDevice} live={false} onShowLive={() => undefined} />)
    const root = container.querySelector('a')
    const rail = root?.children[0]
    const picture = root?.children[1]
    const badge = getByTitle('Controlled by Bob')
    expect(rail?.contains(badge)).toBe(false)
    expect(picture?.contains(badge)).toBe(true)
  })

  test('with no holder or assist at all, the picture container renders no holder-overlay wrapper', () => {
    const { container } = renderWithApi(<WallTile device={device} live={false} onShowLive={() => undefined} />)
    expect(container.textContent).not.toContain('Controlled by')
    expect(container.textContent).not.toContain('Assisting')
  })
})

/**
 * Plan 125 §3.6, criterion 5 — `observed` is what the phone actually
 * reported; `actual` is bookkeeping. They disagree routinely (a lit panel
 * with no session open reads `asleep`), and only the disagreement is worth
 * showing. `unknown` is deliberately silent: it means no probe succeeded,
 * and rendering it beside "Screen off" would read as confirmation of the one
 * thing nobody checked.
 */
describe('WallTile — readiness.observed (plan 125 §3.6)', () => {
  function asleepWith(observed: { state: 'on' | 'off' | 'unknown'; reason: string | null } | null): DeviceInfo {
    return {
      ...asleepDevice,
      readiness: { ...asleepDevice.readiness, observed: observed ? { ...observed, observedAt: 0 } : null },
    }
  }

  test('says "Screen reported on" only when the probe disagrees with the bookkeeping', () => {
    const { queryAllByText } = renderWithApi(<WallTile onShowLive={() => undefined} live={false} device={asleepWith({ state: 'on', reason: null })} />)
    expect(queryAllByText('Screen off').length).toBe(1)
    expect(queryAllByText('Screen reported on').length).toBe(1)
  })

  test('stays silent when the probe agrees, and when it could not run at all', () => {
    const agreed = renderWithApi(<WallTile onShowLive={() => undefined} live={false} device={asleepWith({ state: 'off', reason: null })} />)
    expect(agreed.queryAllByText('Screen reported on').length).toBe(0)
    agreed.unmount()

    // `unknown` must never be dressed up as either state.
    const unknown = renderWithApi(<WallTile onShowLive={() => undefined} live={false} device={asleepWith({ state: 'unknown', reason: 'probe failed' })} />)
    expect(unknown.queryAllByText('Screen reported on').length).toBe(0)
    expect(unknown.queryAllByText('Screen off').length).toBe(1)
  })

  test('a device with no observation at all renders exactly as it did before the field existed', () => {
    const { queryAllByText } = renderWithApi(<WallTile onShowLive={() => undefined} live={false} device={asleepWith(null)} />)
    expect(queryAllByText('Screen off').length).toBe(1)
    expect(queryAllByText('Screen reported on').length).toBe(0)
  })
})
