import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import type { ComponentProps } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
// `WallTile` (rendered for real below, for the decoder-count test) calls
// `useRouter()` — needs `next/navigation` replaced before it is first
// evaluated, the same requirement `WallTile.test.tsx` documents for itself.
// `ActionsList`'s own "Open full device page" `next/link` needs it too.
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'

/**
 * `DevicePopup` (plan 91 §3.11, §5 step 91.9; evolved by plan 103 §4.1, §5
 * step 103.2/103.3 — this file replaces `wall/FocusOverlay.test.tsx`, moved
 * rather than duplicated per §4.3 "replace, never version"). `LiveView` (a
 * WebCodecs/WS video decoder) is mocked here for the SAME reason
 * `ScreenCard.test.tsx`/`WallTile.test.tsx` mock it out of their own tests:
 * standing up a real decoder is not needed to prove the rail around it, and
 * it lets this file also prove the ONE resource property the plan's own
 * brief calls "invisible in a screenshot" — how many `LiveView` instances
 * actually mount — by counting stub renders instead of guessing from the
 * DOM. `HardwareRail` (which renders `RotationQuickAction`) and
 * `AssistDialog` are NOT mocked (same precedent `app/device/page.test.tsx`
 * sets for both): they are real, already-tested components this step only
 * had to reuse or extend.
 */
let liveViewMounts: {
  deviceId: string
  inputEnabled: boolean
  rail: boolean | undefined
  mirror: { groupId: string; solo: boolean; onResult?: (r: unknown) => void } | undefined
  provisioning: { componentId: string; label: string; startedAt: number } | null | undefined
}[] = []
/**
 * One entry per `LiveView` INSTANCE, as opposed to `liveViewMounts` above,
 * which the stub appends to on every render and which is therefore a record
 * of the PROPS each render was given, not a count of decoders.
 *
 * The distinction stopped being academic with plan 125 step 125.10: the popup
 * now renders `<LiveView>` from its very first render instead of waiting for
 * `GET /api/devices/:id`, so the same instance is rendered several times
 * before the popup's chrome settles. The decoder-count test below asserts the
 * plan-103 property *"8 streams, not 9"*, which is about instances, and a
 * render tally can no longer stand in for it.
 */
let liveViewInstances: string[] = []
let intentMarks: { deviceId: string; opts?: { onlyIfAbsent?: boolean } }[] = []
mock.module('@/components/LiveView', () => ({
  LiveView: (props: {
    deviceId: string
    inputEnabled?: boolean
    rail?: boolean
    mirror?: { groupId: string; solo: boolean; onResult?: (r: unknown) => void }
    provisioning?: { componentId: string; label: string; startedAt: number } | null
  }) => {
    liveViewMounts.push({
      deviceId: props.deviceId,
      inputEnabled: Boolean(props.inputEnabled),
      rail: props.rail,
      mirror: props.mirror,
      provisioning: props.provisioning,
    })
    // One push per mounted instance — see `liveViewInstances` above for why
    // this is kept separate from the per-render `liveViewMounts` tally.
    useEffect(() => {
      liveViewInstances.push(props.deviceId)
    }, [])
    return <div data-testid={`live-view-${props.deviceId}`} />
  },
  /**
   * Plan 125 §4.7, step 125.11 — the click→first-paint mark, recorded rather
   * than executed (the real one writes a module-level map inside
   * `LiveView.tsx`, which is stubbed out here entirely). `opts` is captured
   * because `onlyIfAbsent` is the whole reason this call site exists in a
   * form different from `WallTile`'s: a popup opened BY a tile double-click
   * must not overwrite that tile's earlier, truer timestamp.
   */
  markLiveViewIntent: (deviceId: string, opts?: { onlyIfAbsent?: boolean }) => intentMarks.push({ deviceId, opts }),
}))

let wsRequestImpl: (msg: { type: string; payload?: unknown }) => Promise<unknown> = () =>
  Promise.reject(new Error('ws not available in test'))
const wsSendCalls: { type: string; payload?: unknown }[] = []
// A SET of listeners, not a single slot — matching the real `ws.on`'s own
// multi-subscriber contract (`lib/ws.ts`). `SidePanel`'s Record tab (plan
// 103 §5, closing step 103.11's audit row 3) added a SECOND caller of
// `ws.on` beside `DevicePopup`'s own (`useRecording`'s effect) — a
// single-slot mock silently dropped `DevicePopup`'s own listener the moment
// `SidePanel` mounted and registered its own, which is exactly the "second
// caller quietly breaks the first" defect class this repo keeps re-finding.
const wsListeners = new Set<(m: { type: string; payload: unknown }) => void>()
mock.module('@/lib/ws', () => ({
  // `AssistDialog.tsx` imports this for an `instanceof` check in its own catch branch.
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  ws: {
    on: (cb: (m: { type: string; payload: unknown }) => void) => {
      wsListeners.add(cb)
      return () => {
        wsListeners.delete(cb)
      }
    },
    send: (msg: { type: string; payload?: unknown }) => wsSendCalls.push(msg),
    request: (msg: { type: string; payload?: unknown }) => wsRequestImpl(msg),
    getSessionId: () => 'test-session',
    // `LiveView` and `InspectorPanel` (mounted while the Inspector tab is
    // active, plan 103 §5 step 103.5) both subscribe through these two on
    // mount.
    onReconnected: () => () => {},
    onBinary: () => () => {},
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { DevicePopup, RELEASE_UNDO_MS, provisioningComponentFor } = await import('./DevicePopup')
const { WallTile } = await import('@/components/wall/WallTile')
// Imported the same deferred way as the two above (plan 125 §3.10, step
// 125.5): `@/lib/auth` pulls in `@/lib/ws` for `coreBase`, so it must not be
// evaluated before the `mock.module` call above has replaced that module.
const { AuthContext } = await import('@/lib/auth')

/**
 * `HardwareRail`/`ActionsList` render Radix `Tooltip`s (plan 103 §4.1,
 * §4.2), which throw without an ancestor `TooltipProvider` — supplied by
 * `AppShell`/`app/layout.tsx` in the real app, and here since this file
 * renders `DevicePopup` standalone.
 */
function Popup(props: ComponentProps<typeof DevicePopup>) {
  return (
    <TooltipProvider>
      <DevicePopup {...props} />
    </TooltipProvider>
  )
}

/**
 * The same popup, rendered as a SIGNED-IN operator (plan 125 §3.10, step
 * 125.5). Every other test in this file renders `<Popup>` with no
 * `AuthContext.Provider` at all, which is exactly the auth-disabled path
 * (`useAuth()` falls back to its local-mode default, `user: null`) — so this
 * file already proves acceptance criterion 10 by construction: with auth
 * off, nothing about control changed.
 */
function PopupAs({ userId, ...props }: ComponentProps<typeof DevicePopup> & { userId: string }) {
  return (
    <AuthContext.Provider
      value={{
        user: { id: userId, email: 'me@example.com', role: 'admin' },
        authMode: 'server',
        setupNeeded: false,
        refresh: async () => {},
        logout: async () => {},
      }}
    >
      <Popup {...props} />
    </AuthContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  liveViewMounts = []
  liveViewInstances = []
  intentMarks = []
  wsSendCalls.length = 0
  wsRequestImpl = () => Promise.reject(new Error('ws not available in test'))
  wsListeners.clear()
})

/**
 * The props `LiveView` was given on its MOST RECENT render for `deviceId`.
 * `liveViewMounts.find(…)` returns the FIRST render's props, which since plan
 * 125 step 125.10 is the render that happens before `GET /api/devices/:id`
 * and the preparation fetch have answered anything — i.e. deliberately the
 * one with the least filled in. Anything asserting on a late-arriving prop
 * wants the latest render, not the first.
 */
function latestLiveViewProps(deviceId: string) {
  return [...liveViewMounts].reverse().find((m) => m.deviceId === deviceId)
}

function emit(msg: { type: string; payload: unknown }): void {
  for (const cb of wsListeners) cb(msg)
}

const idleDevice = {
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
  heldBy: null,
  transport: 'adb-usb',
  display: 'scrcpy',
  input: 'adb-input',
  inspection: 'ui-server',
  settings: null,
  liveDisplay: null,
  nodeId: null,
}

const jobHolder = { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }
const busyDevice = { ...idleDevice, status: 'busy', heldBy: jobHolder }

// Plan 125 §3.10/§3.11 (steps 125.5, 125.6). `id` is what the wire actually
// carries for an authenticated person: `toHolder` (`lease-manager.ts`) writes
// `holderUserId ?? holder`, so a signed-in holder's id IS their `user.id` —
// which is why comparing it to `GET /api/auth/me`'s own `user.id` is a valid
// check, and why the owner saw their own email address named as the holder.
const meHolder = { kind: 'user', id: 'user-1', label: 'me@example.com', runId: null, takeable: true, acquiredAt: 0, expiresAt: 1_700_000_300 }
const otherPersonHolder = { kind: 'user', id: 'user-2', label: 'bob@example.com', runId: null, takeable: true, acquiredAt: 0, expiresAt: 1_700_000_300 }
const agentHolder = { kind: 'agent', id: 'agent-1', label: 'Triage bot', runId: 'run-1', takeable: true, acquiredAt: 0, expiresAt: null }
const heldByMeDevice = { ...idleDevice, status: 'manual', heldBy: meHolder }
const heldByOtherDevice = { ...idleDevice, status: 'manual', heldBy: otherPersonHolder }
const heldByAgentDevice = { ...idleDevice, status: 'manual', heldBy: agentHolder }

const settingsBody = { settings: {}, schema: {}, deviceSchema: {} }

const baseResponses = {
  '/api/devices/dev-1': { body: { device: idleDevice } },
  // Plan 106 §5 step 106.7 — `usePreparation` now fetches this
  // unconditionally at mount (the screen-panel overlay needs it whether or
  // not Settings › Preparation is even open), so every test in this file
  // needs SOME response here. Empty by default (nothing provisioning); the
  // dedicated describe block below overrides it per test.
  '/api/devices/dev-1/preparation': { body: {} },
  '/api/settings': { body: settingsBody },
}

describe('DevicePopup — loading and basic chrome', () => {
  /**
   * Plan 125 §0.7, §4.5, §5 step 125.10 — this test used to assert the
   * opposite: that the screen panel showed `LoadingRows` (`aria-busy`) until
   * `GET /api/devices/:id` resolved. That placeholder WAS the defect — it
   * meant `stream.start` could not leave the browser until an HTTP round trip
   * had completed, for a payload the video path does not read. The picture is
   * now the first thing the popup asks for, and the chrome (the label, the
   * Open-full-device-page row) still fills in behind it exactly as before,
   * which is what the second half of this test still checks.
   */
  test('mounts LiveView on the first render, before the device fetch resolves — then fills in the label and an Open full device page link', async () => {
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    // Synchronously, in the same tick as the very first render: no `await`
    // anywhere above this line, so the detail fetch cannot have resolved.
    expect(liveViewMounts.some((m) => m.deviceId === 'dev-1')).toBe(true)
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    // Plan 103 §4.2 item 12 — the Actions list's own row, not a header
    // button (removed per §4.2's "displace, don't append" rule so this
    // link exists exactly once).
    expect(screen.getByRole('link', { name: /Open full device page/ }).getAttribute('href')).toBe('/device?id=dev-1')
  })

  test('the close button calls onClose', async () => {
    let closed = false
    const { getByLabelText, getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByLabelText('Close'))
    expect(closed).toBe(true)
  })

  test('LiveView renders with rail suppressed — HardwareRail draws the case buttons instead (plan 103 §4.1)', async () => {
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1')).toBe(true))
    expect(liveViewMounts.find((m) => m.deviceId === 'dev-1')?.rail).toBe(false)
  })
})

describe('DevicePopup — the three-column shell (plan 103 §4.1, §5 step 103.2)', () => {
  test('the hardware rail sends scrcpy keycodes over the SAME input.key message LiveView itself uses', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'lease.acquire') {
        return Promise.resolve({ type: 'lease.acquired', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300 } })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const { getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.inputEnabled)).toBe(true))
    fireEvent.click(getByRole('button', { name: 'Home' }))
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.key')).toBe(true))
    const homeSend = wsSendCalls.find((m) => m.type === 'input.key') as { payload?: { keycode?: number } } | undefined
    expect(homeSend?.payload?.keycode).toBe(3) // AKEYCODE_HOME
  })

  test('the Actions tab is the default and switching to Inspector never remounts LiveView (no second session, G7/G8)', async () => {
    const { getByRole, getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(getByRole('tab', { name: 'Actions' }).getAttribute('data-state')).toBe('active')
    // `SidePanel` is `Actions | Inspector` now — Terminal left as its own
    // tab when "Adb command" became a modal (plan 103 §9 Q4, answered
    // 2026-08-16; `AdbCommandDialog.test`-equivalent coverage lives in
    // `ActionsList.test.tsx`, since that row is what opens it).
    const mountsBefore = liveViewMounts.length
    // Radix's `Tabs.Trigger` activates on `mousedown`, not `click`
    // (`@radix-ui/react-tabs`'s own `TabsTrigger`) — same precedent
    // `RunScriptDialog.test.tsx`'s own Workflow/Script tab test documents.
    fireEvent.mouseDown(getByRole('tab', { name: 'Inspector' }))
    await waitFor(() => expect(getByRole('tab', { name: 'Inspector' }).getAttribute('data-state')).toBe('active'))
    // Switching panels never touches `LiveView` (it lives in `DevicePopup`'s
    // own centre panel, a sibling of the tabs) — no new mount, and
    // therefore no new session for the same device.
    expect(liveViewMounts.length).toBe(mountsBefore)
  })
})

describe('DevicePopup — quick control (no "Take control" rail item, plan 91 §3.11)', () => {
  test('an idle device is claimed automatically: lease.acquire is sent and LiveView is enabled', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'lease.acquire') {
        return Promise.resolve({ type: 'lease.acquired', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300 } })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(wsSendCalls.length + 1).toBeGreaterThan(0)) // let effects settle
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.inputEnabled)).toBe(true))
  })

  test('a busy device is never auto-claimed: no lease.acquire is sent, and the Assist row is offered instead', async () => {
    let acquireCalled = false
    wsRequestImpl = (msg) => {
      if (msg.type === 'lease.acquire') acquireCalled = true
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const { getByText, getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    expect(getByRole('button', { name: 'Assist' })).toBeTruthy()
    expect(acquireCalled).toBe(false)
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && !m.inputEnabled)).toBe(true))
  })

  test('confirming Assist (via the Actions list row) flips LiveView to enabled, without sending any lease.* message, through the non-modal path', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    wsRequestImpl = (msg) => {
      if (msg.type === 'assist.start') {
        return Promise.resolve({ type: 'assist.started', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300, primary: jobHolder } })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const { getByRole, getByText, baseElement } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    await user.click(getByRole('button', { name: 'Assist' }))
    const dialog = await screen.findByRole('dialog')
    // Plan 103 §3.2 — the non-modal path: no backdrop, so the phone stays
    // visible and interactive while this dialog is open.
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    await waitFor(() => expect(within(dialog).getByText(/checkout@1\.4\.2/)).toBeTruthy())
    await user.click(within(dialog).getByRole('button', { name: 'Assist' }))

    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.inputEnabled)).toBe(true))
    expect(wsSendCalls.some((m) => m.type.startsWith('lease.'))).toBe(false)
    // Plan 105 (M70) §5 step 105.1 — names the REAL primary holder rather
    // than a hardcoded "the job", so this reads correctly even when the
    // primary is a person, not only a job.
    expect(getByText('Assisting — checkout@1.4.2 still has control')).toBeTruthy()
  })

  test('assist.stopped for a reason other than "released" shows a notice (plan 105 §3.4, §5 step 105.3)', async () => {
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    emit({ type: 'assist.stopped', payload: { deviceId: 'dev-1', reason: 'ttl' } })
    await waitFor(() => expect(getByText(/stopped automatically after 5 minutes without input/)).toBeTruthy())
  })

  test('assist.stopped with reason "primary_ended" offers Take control in the same notice (plan 105 §3.3)', async () => {
    const { getByText, getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    emit({ type: 'assist.stopped', payload: { deviceId: 'dev-1', reason: 'primary_ended' } })
    await waitFor(() => expect(getByText(/It is free now/)).toBeTruthy())
    expect(getByRole('button', { name: 'Take control' })).toBeTruthy()
  })

  test('assist.stopped with reason "released" shows no notice at all — the operators own click needs no message (plan 105 §3.4)', async () => {
    const { getByText, queryByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    emit({ type: 'assist.stopped', payload: { deviceId: 'dev-1', reason: 'released' } })
    expect(queryByText(/Assisting stopped/)).toBeNull()
  })
})

describe('DevicePopup — release, re-take, and auto-claim origin (plan 105 §5 steps 105.5, 105.6)', () => {
  function routeAcquire() {
    wsRequestImpl = (msg) => {
      if (msg.type === 'lease.acquire') {
        return Promise.resolve({ type: 'lease.acquired', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300 } })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
  }

  test('105.5 — clicking Release control does not release immediately; it starts an undo window', async () => {
    routeAcquire()
    const { getByRole } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Release control' }))
    // The lease has NOT moved yet — this is the whole point of the undo
    // window: nobody else can claim the device while it counts down.
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(false)
    await waitFor(() => expect(getByRole('button', { name: /Releasing.*Undo/ })).toBeTruthy())
  })

  test('105.5 — Undo cancels the pending release: lease.release is never sent, and the button reverts', async () => {
    routeAcquire()
    const { getByRole } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Release control' }))
    const undoButton = await waitFor(() => getByRole('button', { name: /Releasing.*Undo/ }))
    fireEvent.click(undoButton)
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(false)
    // The NEXT test (the undo window actually elapsing) is what proves the
    // timer mechanism sends `lease.release` at all — a real wait here too
    // would only duplicate that cost. What this test still adds on top: the
    // unmount cleanup below actually cancels a timer Undo did NOT already
    // clear, which is the failure mode a merely-optimistic assertion here
    // would miss (a leaked timer that fires after this test has already
    // moved on, corrupting a LATER test's `wsSendCalls`, is exactly the bug
    // this popup shipped with until the unmount-cancel effect above (plan
    // 105 §5 step 105.5) was added).
  })

  test(
    '105.5 — once the undo window elapses, lease.release is sent and the free state offers Take control right back (105.5\'s round trip)',
    async () => {
      routeAcquire()
      const { getByRole } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
      await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
      fireEvent.click(getByRole('button', { name: 'Release control' }))
      await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(true), {
        timeout: RELEASE_UNDO_MS + 2_000,
      })
      const sent = wsSendCalls.find((m) => m.type === 'lease.release') as { payload: { deviceId: string } }
      expect(sent.payload.deviceId).toBe('dev-1')
      // 105.5's other half — `free` now renders its own primary action,
      // where before this step it rendered nothing at all.
      await waitFor(() => expect(getByRole('button', { name: 'Take control' })).toBeTruthy())
    },
    RELEASE_UNDO_MS + 5_000,
  )

  test('105.5 — the free state (nobody holds it) offers Take control, and clicking it sends lease.acquire', async () => {
    routeAcquire()
    const { getByText, getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    // The job finishes and releases the device — nobody holds it now.
    emit({ type: 'device.status', payload: { id: 'dev-1', status: 'idle' } })
    emit({ type: 'lease.changed', payload: { deviceId: 'dev-1', heldBy: null } })
    await waitFor(() => expect(getByText('Nobody holds this device.')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Take control' }))
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
  })

  test('105.6 — a lease auto-claimed on open is released when the popup unmounts', async () => {
    routeAcquire()
    const { getByRole, unmount } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(false)
    unmount()
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(true)
  })

  test('105.6 — a lease the operator explicitly took (Take control from `free`) is NOT released when the popup unmounts', async () => {
    routeAcquire()
    const { getByText, getByRole, unmount } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    emit({ type: 'device.status', payload: { id: 'dev-1', status: 'idle' } })
    emit({ type: 'lease.changed', payload: { deviceId: 'dev-1', heldBy: null } })
    await waitFor(() => expect(getByText('Nobody holds this device.')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Take control' }))
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    unmount()
    // The operator asked for this — closing the popup must not take it back
    // from them (they may be about to run something).
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(false)
  })

  test('105.6 — a `pagehide` (tab close / hard navigation) releases an auto-claimed lease too, best-effort', async () => {
    routeAcquire()
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Release control' })).toBeTruthy())
    window.dispatchEvent(new Event('pagehide'))
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(true)
  })
})

/**
 * Plan 125 (M90) §3.10, §3.11 — steps 125.5 and 125.6, both from report 3:
 * *"Take control keeps getting in the way. I open a device in browser A —
 * that auto-takes control — and it tells me `bitorex.it@gmail.com is using
 * this device now. Join them, or take over — not decided which should be the
 * default here.` As if it isn't me in this tab, when it is me, under that
 * very account."*
 *
 * Two defects in one sentence: the control model never asked who the
 * operator was, and the caption was our own unanswered design question
 * (plan 105 §9 Q1) rendered verbatim into production.
 */
describe('DevicePopup — control knows who you are (plan 125 §3.10, step 125.5)', () => {
  const acquireRequests: { payload?: unknown }[] = []

  function routeAcquire(outcome: 'ok' | 'refused' = 'ok') {
    acquireRequests.length = 0
    wsRequestImpl = (msg) => {
      if (msg.type !== 'lease.acquire') return Promise.reject(new Error(`unexpected request: ${msg.type}`))
      acquireRequests.push(msg)
      return outcome === 'ok'
        ? Promise.resolve({ type: 'lease.acquired', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300 } })
        : Promise.reject(new Error('the device is now held by someone else'))
    }
  }

  test('125.5 — a device you already hold in another tab is claimed back on open, with the takeOverFrom CAS, and never named as someone else’s', async () => {
    routeAcquire('ok')
    const { getByRole, queryAllByText } = renderWithApi(
      <PopupAs userId="user-1" deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByMeDevice } } },
    )
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    // The claim the popup made: a compare-and-swap against the holder it saw
    // — an ordinary acquire is refused while anyone still holds the device.
    expect(acquireRequests.length).toBe(1)
    expect(acquireRequests[0]?.payload).toEqual({ deviceId: 'dev-1', takeOverFrom: 'user-1' })
    // Report 3's own sentence must not be on screen at all. Asserted on a
    // COUNT, never on a node: a failing `expect(node).toBeNull()` inside a
    // retrying `waitFor` serialises a whole happy-dom element.
    expect(queryAllByText(/is using this device now/).length).toBe(0)
  })

  test('125.5 — criterion 10: with auth off, that same device is NOT auto-claimed and reads exactly as it does today', async () => {
    routeAcquire('ok')
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByMeDevice } } },
    )
    await waitFor(() => expect(getByText(/is using this device now/)).toBeTruthy())
    expect(acquireRequests.length).toBe(0)
  })

  test('125.5 — a device held by SOMEONE ELSE is still never auto-claimed, signed in or not', async () => {
    routeAcquire('ok')
    const { getByText } = renderWithApi(
      <PopupAs userId="user-1" deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByOtherDevice } } },
    )
    await waitFor(() => expect(getByText(/bob@example\.com/)).toBeTruthy())
    expect(acquireRequests.length).toBe(0)
  })

  test('125.5 — when the claim is refused, the popup offers "Resume control here" rather than describing the operator to themselves; clicking it retries the same CAS', async () => {
    routeAcquire('refused')
    const { getByRole, getByText, queryAllByText } = renderWithApi(
      <PopupAs userId="user-1" deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByMeDevice } } },
    )
    await waitFor(() => expect(getByText('You are already controlling this device somewhere else.')).toBeTruthy())
    expect(queryAllByText(/is using this device now/).length).toBe(0)
    // Never a takeover of yourself — no takeover dialog, no "Take control…".
    expect(queryAllByText('Take control…').length).toBe(0)
    routeAcquire('ok')
    fireEvent.click(getByRole('button', { name: 'Resume control here' }))
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    expect(acquireRequests[0]?.payload).toEqual({ deviceId: 'dev-1', takeOverFrom: 'user-1' })
  })

  test('125.5 — a resumed lease is NOT given up when the popup closes: you already held this device before you opened it', async () => {
    routeAcquire('ok')
    const { getByRole, unmount } = renderWithApi(
      <PopupAs userId="user-1" deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByMeDevice } } },
    )
    await waitFor(() => expect(getByRole('button', { name: 'Release control' })).toBeTruthy())
    unmount()
    expect(wsSendCalls.some((m) => m.type === 'lease.release')).toBe(false)
  })
})

describe('DevicePopup — the undecided caption is gone (plan 105 §9 Q1, answered by plan 125 §3.11, step 125.6)', () => {
  /** The control card itself — `within` it, so the Actions list's own Assist row is never mistaken for one of these two buttons. */
  function controlCard(holderLine: HTMLElement): HTMLElement {
    const card = holderLine.closest('div')
    if (!card) throw new Error('the holder line has no card around it')
    return card
  }

  test('125.6 — the caption "not decided which should be the default here" is nowhere on screen', async () => {
    const { getByText, queryAllByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByOtherDevice } } },
    )
    await waitFor(() => expect(getByText(/is using this device now/)).toBeTruthy())
    expect(queryAllByText(/not decided/i).length).toBe(0)
    expect(queryAllByText(/Join them, or take over/i).length).toBe(0)
  })

  test('125.6 — a PERSON holding it: Take control is the primary action, Assist the secondary, and each says what it does', async () => {
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByOtherDevice } } },
    )
    const card = controlCard(await waitFor(() => getByText(/is using this device now/)))
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Take control…', 'Assist'])
    expect(within(card).getByText('Ends their control and gives the device to you.')).toBeTruthy()
    expect(within(card).getByText('Drive alongside them — they keep control.')).toBeTruthy()
  })

  test('125.6 — an AGENT holding it keeps the two equal: joining a running automation is a genuinely likely intent', async () => {
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: heldByAgentDevice } } },
    )
    const card = controlCard(await waitFor(() => getByText(/is using this device now/)))
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Assist', 'Take control…'])
  })

  test('125.6 — a disabled Assist explains ITSELF (co-control off for the farm), which is what the operator needs when the button cannot be pressed', async () => {
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      {
        ...baseResponses,
        '/api/devices/dev-1': { body: { device: heldByOtherDevice } },
        '/api/settings': { body: { settings: { coControl: { mode: 'off', grantTtlSec: 300 } }, schema: {}, deviceSchema: {} } },
      },
    )
    const card = controlCard(await waitFor(() => getByText(/is using this device now/)))
    await waitFor(() => expect(within(card).getByText('Assisting is turned off for this farm.')).toBeTruthy())
  })
})

describe('DevicePopup — Mirror arms from the selection, no switch (plan 104 §3.3)', () => {
  test('nothing else selected: no arming, and the panel says nothing it does not have to (owner call, 2026-08-16)', async () => {
    const { getByText, queryByText, queryByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    // Nothing to say when input trivially reaches just this one device —
    // the popup is already showing exactly one device, so an "Input
    // reaches 1 device" line would be pure restatement (see the file's own
    // comment on this rendering condition).
    expect(queryByText('Input reaches')).toBeNull()
    expect(queryByText('1 device')).toBeNull()
    // The only `switch` left in the popup is "Focused only", and it does not
    // render at all while no group is armed — there is no on/off control.
    expect(queryByRole('switch')).toBeNull()
  })

  test('a live Wall selection behind the popup arms mirror automatically — no click at all', async () => {
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8', status: 'busy' as const }
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-1',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    // No confirmation, no switch — armed the moment the candidate set (this
    // device plus the Wall's own selection) reaches two.
    await waitFor(() => expect(getByText('2 devices')).toBeTruthy())
    await waitFor(() => expect(getByText('2 / 2 devices active')).toBeTruthy())
    await waitFor(() =>
      expect(
        liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.mirror?.groupId === 'group-1' && m.mirror?.solo === false),
      ).toBe(true),
    )
  })

  test('"Focused only" narrows the stated reach back to 1 device without disarming the group', async () => {
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-1',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const { getByText, getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('2 devices')).toBeTruthy())
    fireEvent.click(getByRole('switch', { name: 'Focused only' }))
    await waitFor(() => expect(getByText('1 device')).toBeTruthy())
    // The group itself is untouched — no `mirror.stop` was sent.
    expect(wsSendCalls.some((m) => m.type === 'mirror.stop')).toBe(false)
  })

  test('mirror.changed updates the live member count', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-1',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('2 / 2 devices active')).toBeTruthy())

    emit({
      type: 'mirror.changed',
      payload: {
        groupId: 'group-1',
        members: [
          { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
          { deviceId: 'dev-2', label: 'pixel 8', mode: 'skipped', reason: 'repeated_failures', aspectDrift: false },
        ],
      },
    })
    await waitFor(() => expect(getByText('1 / 2 devices active')).toBeTruthy())
  })

  test('the result strip shows ok/total and, clicked, names the failed devices with their codes', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-1',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('2 / 2 devices active')).toBeTruthy())

    const mounted = liveViewMounts.find((m) => m.deviceId === 'dev-1' && m.mirror)
    mounted?.mirror?.onResult?.([
      { deviceId: 'dev-1', ok: true, code: null, latencyMs: 12 },
      { deviceId: 'dev-2', ok: false, code: 'orientation_mismatch', latencyMs: 0 },
    ])

    await waitFor(() => expect(getByText('1/2')).toBeTruthy())
    fireEvent.click(getByText('1/2'))
    expect(getByText('pixel 8 — orientation_mismatch')).toBeTruthy()
  })

  test('the selection dropping back below two disarms the group automatically', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-1',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText, rerender } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('2 devices')).toBeTruthy())

    rerender(<Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={[]} onClose={() => {}} />)
    expect(wsSendCalls).toContainEqual({ type: 'mirror.stop', payload: { groupId: 'group-1' } })
    // Back down to one device reachable — the panel itself goes quiet
    // again (owner call, 2026-08-16: it only speaks up once the answer is
    // not obvious).
    await waitFor(() => expect(screen.queryByText('Input reaches')).toBeNull())
  })

  test('unmounting with an active group sends mirror.stop — no group outlives the panel', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-9',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText, unmount } = renderWithApi(
      <Popup deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('2 devices')).toBeTruthy())

    unmount()
    expect(wsSendCalls).toContainEqual({ type: 'mirror.stop', payload: { groupId: 'group-9' } })
  })
})

describe('DevicePopup — End task', () => {
  test('absent when nobody holds the device with a job', async () => {
    const { getByText, queryByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(queryByRole('button', { name: /End task/ })).toBeNull()
  })

  test('confirming cancels the job via POST /api/jobs/:id/cancel', async () => {
    const { getByText, getByRole, apiMock } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      {
        ...baseResponses,
        '/api/devices/dev-1': { body: { device: busyDevice } },
        '/api/jobs/job-1/cancel': { body: { job: { id: 'job-1', status: 'cancelled' }, cancelledDescendants: 0 } },
      },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    fireEvent.click(getByRole('button', { name: /End task/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/End checkout@1\.4\.2 on moto g06\?/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'End task' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/jobs/job-1/cancel')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 3000 })
  })
})

/**
 * Plan 124 §4.4 Group B, step 124.2 — this popup is the surface an operator
 * spends the most time in, and until this step every string in it named the
 * device by its bare `label`. On the owner's own farm that means three panels
 * whose headers, region labels and confirm dialogs all read `SM-F721U1`.
 */
describe('DevicePopup — the device number (plan 124 §4.4 Group B)', () => {
  const numbered = { ...idleDevice, number: 7 }

  test('the panel header and the region label both carry the number (criterion 5)', async () => {
    const { getByText, getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: numbered } } },
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    // Two spans, not one string — `<DeviceName>`'s visual form (§3.2), which
    // is what lets the number be dimmed beside the label rather than run
    // into it.
    expect(getByText('#7')).toBeTruthy()
    expect(getByRole('region', { name: 'Focused control — #7 moto g06' })).toBeTruthy()
  })

  test('the End task confirm names the device with its number, not just the job', async () => {
    const { getByText, getByRole } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: { ...busyDevice, number: 7 } } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    fireEvent.click(getByRole('button', { name: /End task/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/End checkout@1\.4\.2 on #7 moto g06\?/)).toBeTruthy()
  })

  test('a device with no number renders the bare label — no `#`, no `#null` (criterion 7)', async () => {
    // `idleDevice` omits `number`, so `DeviceInfoSchema`'s `.default(null)`
    // supplies it — the same value a device whose reservation was explicitly
    // released carries.
    const { getByText, getByRole, queryByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(queryByText(/#null|#undefined/)).toBeNull()
    expect(getByRole('region', { name: 'Focused control — moto g06' })).toBeTruthy()
  })

  test('a failed mirror member is named from MirrorMember.number — composed once, never twice', async () => {
    // Plan 124 §10's note from step 124.5: `MirrorMember` carries a `number`
    // FIELD and its `label` stays BARE, precisely so `labelFor` can compose.
    // `dev-2` is deliberately absent from the `devices` array here, which
    // forces `labelFor` down its mirror-member branch rather than its
    // `DeviceInfo` fallback — the branch that would have rendered `#12 #12
    // pixel 8` had the server pre-baked the number into `label` instead.
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: {
            groupId: 'group-1',
            focusDeviceId: 'dev-1',
            members: [
              { deviceId: 'dev-1', label: 'moto g06', number: 7, mode: 'lease', reason: null, aspectDrift: false },
              { deviceId: 'dev-2', label: 'pixel 8', number: 12, mode: 'assist', reason: null, aspectDrift: false },
            ],
          },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(numbered as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[numbered as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: numbered } } },
    )
    await waitFor(() => expect(getByText('2 / 2 devices active')).toBeTruthy())

    const mounted = liveViewMounts.find((m) => m.deviceId === 'dev-1' && m.mirror)
    mounted?.mirror?.onResult?.([
      { deviceId: 'dev-1', ok: true, code: null, latencyMs: 12 },
      { deviceId: 'dev-2', ok: false, code: 'orientation_mismatch', latencyMs: 0 },
    ])

    await waitFor(() => expect(getByText('1/2')).toBeTruthy())
    fireEvent.click(getByText('1/2'))
    expect(getByText('#12 pixel 8 — orientation_mismatch')).toBeTruthy()
  })
})

describe('DevicePopup — Forget closes the popup (plan 103 §4.2)', () => {
  test('a successful Forget calls onClose, the same way it navigated away on the device page', async () => {
    let closed = false
    const { getByText, getByRole, apiMock } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />,
      {
        ...baseResponses,
        '/api/devices/dev-1?deleteHistory=false': { body: {} },
      },
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Forget' }))
    const dialog = await screen.findByRole('dialog')
    // Non-modal (plan 103 §3.2) even for Forget — a destructive action still
    // must not blind the operator to the phone while they decide.
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/devices/dev-1?deleteHistory=false')).toBe(true))
    await waitFor(() => expect(closed).toBe(true))
  })
})

/**
 * The plan's own verbatim verifiable result: "on the Wall with 8 tiles live,
 * opening the popup leaves the browser decoding 8 streams, not 9; closing
 * it restores the tile." Proven as a mount COUNT, not a screenshot — this is
 * the property that is invisible any other way, and it is what plan 103 §6's
 * "zero new phase events on the tile's own channel" is really asserting:
 * the tile's own `LiveView` never remounts, so it never re-enters the
 * session-phase machinery at all. Real `WallTile`s (not mocked, unlike
 * `Wall.test.tsx`'s own wiring tests) so its own "stop decoding while
 * focused" placeholder (plan 91 §5 step 91.8) is genuinely exercised.
 */
describe('DevicePopup — decoder count (the plan\'s own verifiable result)', () => {
  test('8 live tiles plus a focused popup mount exactly 8 LiveViews, not 9', async () => {
    const tiles: DeviceInfo[] = Array.from({ length: 8 }, (_, i) => ({
      ...(idleDevice as unknown as DeviceInfo),
      id: `dev-${i + 1}`,
      label: `phone ${i + 1}`,
    }))
    const focusId = 'dev-1'

    renderWithApi(
      <>
        {tiles.map((d) => (
          <WallTile key={d.id} device={d} live onShowLive={() => {}} focused={d.id === focusId} />
        ))}
        <Popup deviceId={focusId} devices={tiles} selectedIds={[]} onClose={() => {}} />
      </>,
      baseResponses,
    )

    // Asserted against `liveViewInstances` (one entry per mounted instance),
    // not the per-render `liveViewMounts` tally — see that variable's own
    // comment. Since plan 125 step 125.10 the popup renders `<LiveView>` from
    // its first render, so it is rendered several times while the popup's
    // chrome settles; the number of DECODERS, which is what this test is
    // about, never changed.
    await waitFor(() => expect(liveViewInstances.length).toBeGreaterThan(0))
    const mountedIds = liveViewInstances
    expect(mountedIds).toHaveLength(8)
    expect(new Set(mountedIds).size).toBe(8)
    expect(mountedIds).toContain(focusId)
    // The focused tile's OWN WallTile never mounted a second LiveView for
    // dev-1 — the popup's is the only one.
    expect(mountedIds.filter((id) => id === focusId)).toHaveLength(1)
  })
})

/**
 * The identity meta row (plan 103 §5, closing step 103.11's audit rows
 * 20-22, 2026-08-17) — battery/temperature inline and unconditional, the
 * viewer-presence popover, and the device-details popover, all mounted
 * through the SAME extracted `DeviceHeader.tsx` components the device page
 * itself uses, not thinner copies. And row 29 — the "Ask an agent…" header
 * button.
 */
describe('DevicePopup — the identity meta row (plan 103 §5, closing step 103.11 audit rows 20-22, 29)', () => {
  const metaResponses = {
    ...baseResponses,
    '/api/devices/dev-1': {
      body: { device: { ...idleDevice, battery: { level: 42, temperatureC: 31.5, status: 'discharging', health: 'good', updatedAt: 0 } } },
    },
    '/api/devices/dev-1/label': {
      body: { mode: 'wallpaper', state: 'applied', reason: null, fingerprint: 'abc', appliedAt: 1, originalCaptured: true },
    },
    '/api/devices/dev-1/viewers': {
      body: { viewers: [{ sessionId: 'sess-1', userLabel: 'Alex', since: 1_700_000_000, holdsControl: false }] },
    },
    '/api/devices/dev-1/guest-agent': { body: { appVersion: '1.2.3' } },
    '/api/registry': { body: {} },
  }

  test('battery and temperature render inline, unconditional — never behind a click', async () => {
    const { getByText } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, metaResponses)
    await waitFor(() => expect(getByText('42%')).toBeTruthy())
    expect(getByText('31.5°C')).toBeTruthy()
  })

  test('the label state badge renders inline from the popup\'s own /label fetch', async () => {
    const { getByText } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, metaResponses)
    await waitFor(() => expect(getByText('Labelled')).toBeTruthy())
  })

  test('the viewers popover shows who is watching', async () => {
    const { getByLabelText, getByText } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, metaResponses)
    await waitFor(() => expect(getByLabelText('Viewers (1)')).toBeTruthy())
    fireEvent.click(getByLabelText('Viewers (1)'))
    await waitFor(() => expect(getByText('Alex')).toBeTruthy())
  })

  test('the device-details popover shows the copyable serial and stable id', async () => {
    const { getByLabelText, getAllByText, getByText } = renderWithApi(
      <Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      metaResponses,
    )
    await waitFor(() => expect(getByLabelText('Device details')).toBeTruthy())
    fireEvent.click(getByLabelText('Device details'))
    // `idleDevice`'s own fixture uses the same value for `serial` and
    // `stableId` — both rows render it (one each, both copyable), which is
    // exactly why there are two matches here rather than a fixture bug.
    await waitFor(() => expect(getAllByText('ZP2222RMBS')).toHaveLength(2))
    // The guest agent's own version, closing the same row's own gap.
    expect(getByText('1.2.3')).toBeTruthy()
  })

  test('"Ask an agent…" opens AskAnAgentDialog from the header, not a 13th Actions row', async () => {
    const { getByLabelText, getByText } = renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, metaResponses)
    await waitFor(() => expect(getByLabelText('Ask an agent…')).toBeTruthy())
    fireEvent.click(getByLabelText('Ask an agent…'))
    await waitFor(() => expect(getByText('Ask an agent about moto g06')).toBeTruthy())
  })
})

/**
 * The screen-panel provisioning overlay (plan 106 §5 step 106.7) — the
 * owner's other ask, beside the popup section: *"bisa ngga kalau
 * preparation lagi diinstall itu ada loadingnya di screen castingnya?"*
 * `provisioningComponentFor` is a pure function, tested directly rather
 * than only through a full render (deterministic, no `waitFor` needed for
 * the ordering rule itself); the wiring test below proves DevicePopup
 * actually threads its result into `LiveView`'s own `provisioning` prop —
 * the two are deliberately separate, the same split this file already uses
 * for LiveView's `mirror` prop vs. `LiveView.test.tsx`'s own routing tests.
 */
describe('provisioningComponentFor (plan 106 §5 step 106.7)', () => {
  test('null when nothing is provisioning, including an empty or absent-only record', () => {
    expect(provisioningComponentFor(null)).toBeNull()
    expect(provisioningComponentFor({})).toBeNull()
    expect(
      provisioningComponentFor({ 'ui-server': { state: 'ready', version: '1', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null } }),
    ).toBeNull()
  })

  test('names the one provisioning component, with its checkedAt as startedAt', () => {
    const result = provisioningComponentFor({
      'guest-agent': { state: 'ready', version: '1', reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null },
      'ui-server': { state: 'provisioning', version: null, reason: null, checkedAt: 1_700_000_000, attempts: 0, nextAttemptAt: null },
    })
    expect(result).toEqual({ componentId: 'ui-server', label: 'UI server (openatx)', startedAt: 1_700_000_000 })
  })

  test('prefers the guest agent when more than one component is provisioning at once', () => {
    const result = provisioningComponentFor({
      'guest-agent': { state: 'provisioning', version: null, reason: null, checkedAt: 1_700_000_001, attempts: 0, nextAttemptAt: null },
      'ui-server': { state: 'provisioning', version: null, reason: null, checkedAt: 1_700_000_002, attempts: 0, nextAttemptAt: null },
    })
    expect(result?.componentId).toBe('guest-agent')
  })
})

describe('DevicePopup — the screen-panel provisioning overlay (plan 106 §5 step 106.7)', () => {
  test('LiveView receives no provisioning prop when nothing is installing', async () => {
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1')).toBe(true))
    expect(latestLiveViewProps('dev-1')?.provisioning ?? null).toBeNull()
  })

  test('LiveView receives the provisioning component once GET /:id/preparation reports one mid-install', async () => {
    const responses = {
      ...baseResponses,
      '/api/devices/dev-1/preparation': {
        body: { 'ui-server': { state: 'provisioning', version: null, reason: null, checkedAt: 1_700_000_000, attempts: 0, nextAttemptAt: null } },
      },
    }
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, responses)
    await waitFor(() =>
      expect(latestLiveViewProps('dev-1')?.provisioning).toEqual({
        componentId: 'ui-server',
        label: 'UI server (openatx)',
        startedAt: 1_700_000_000,
      }),
    )
  })
})

/**
 * Plan 125 §0.7, §4.5, §4.7 — steps 125.10 and 125.11, the two halves of
 * "the video stops waiting, and what is left is measured".
 */
describe('DevicePopup — the ungated picture and the click→paint mark (plan 125 §4.5, §4.7)', () => {
  test('exactly one LiveView instance is ever mounted, however the detail fetch turns out', async () => {
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(liveViewInstances.length).toBe(1))
    // The point of one element at one position: the arrival of the detail
    // payload is an UPDATE, never an unmount-and-remount. A second instance
    // here would mean a second `stream.start` — and, worse, that the
    // component's own retry/progress state had been thrown away, which is
    // exactly what `WallTile.tsx`'s `rendersPicture` comment records.
    expect(liveViewInstances).toEqual(['dev-1'])
  })

  test('a failed detail fetch keeps the picture rather than unmounting it', async () => {
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, {
      ...baseResponses,
      '/api/devices/dev-1': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
    })
    // Long enough for the rejection to have propagated through the effect.
    await waitFor(() => expect(liveViewInstances.length).toBe(1))
    expect(liveViewMounts.filter((m) => m.deviceId === 'dev-1').length).toBeGreaterThan(0)
    expect(liveViewInstances).toEqual(['dev-1'])
  })

  test('opening the popup marks the click→paint start, but only if nothing marked it first', async () => {
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    expect(intentMarks.length).toBeGreaterThan(0)
    expect(intentMarks[0]?.deviceId).toBe('dev-1')
    // `onlyIfAbsent` is the whole contract with `WallTile`: a popup opened by
    // a tile double-click must keep that tile's earlier, truer timestamp, or
    // every wall-originated reading silently loses the popup-mount leg.
    expect(intentMarks[0]?.opts?.onlyIfAbsent).toBe(true)
  })

  test('the mark is taken once per device, not on every re-render', async () => {
    renderWithApi(<Popup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(liveViewMounts.filter((m) => m.deviceId === 'dev-1').length).toBeGreaterThan(1))
    expect(intentMarks.filter((m) => m.deviceId === 'dev-1').length).toBe(1)
  })
})
