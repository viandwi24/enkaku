import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { DeviceInfo } from '@enkaku/protocol'
// `WallTile` (rendered for real below, for the decoder-count test) calls
// `useRouter()` — needs `next/navigation` replaced before it is first
// evaluated, the same requirement `WallTile.test.tsx` documents for itself.
// `FocusOverlay`'s own "Open full device page" `next/link` needs it too.
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `FocusOverlay` (plan 91 §3.11, §5 step 91.9) — the thing that closes what
 * step 91.8 opened. `LiveView` (a WebCodecs/WS video decoder) is mocked here
 * for the SAME reason `ScreenCard.test.tsx`/`WallTile.test.tsx` mock it out
 * of their own tests: standing up a real decoder is not needed to prove the
 * rail around it, and it lets this file also prove the ONE resource property
 * the plan's own brief calls "invisible in a screenshot" — how many `LiveView`
 * instances actually mount — by counting stub renders instead of guessing
 * from the DOM. `RotationQuickAction` and `AssistDialog` are NOT mocked
 * (same precedent `app/device/page.test.tsx` sets for both): they are real,
 * already-tested components this step only had to reuse.
 */
let liveViewMounts: { deviceId: string; inputEnabled: boolean; mirror: { groupId: string; solo: boolean; onResult?: (r: unknown) => void } | undefined }[] = []
mock.module('@/components/LiveView', () => ({
  LiveView: (props: {
    deviceId: string
    inputEnabled?: boolean
    mirror?: { groupId: string; solo: boolean; onResult?: (r: unknown) => void }
  }) => {
    liveViewMounts.push({ deviceId: props.deviceId, inputEnabled: Boolean(props.inputEnabled), mirror: props.mirror })
    return <div data-testid={`live-view-${props.deviceId}`} />
  },
}))

let wsRequestImpl: (msg: { type: string; payload?: unknown }) => Promise<unknown> = () =>
  Promise.reject(new Error('ws not available in test'))
const wsSendCalls: { type: string; payload?: unknown }[] = []
let wsListener: ((m: { type: string; payload: unknown }) => void) | null = null
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
      wsListener = cb
      return () => {
        wsListener = null
      }
    },
    send: (msg: { type: string; payload?: unknown }) => wsSendCalls.push(msg),
    request: (msg: { type: string; payload?: unknown }) => wsRequestImpl(msg),
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { FocusOverlay } = await import('./FocusOverlay')
const { WallTile } = await import('./WallTile')

afterEach(() => {
  cleanup()
  liveViewMounts = []
  wsSendCalls.length = 0
  wsRequestImpl = () => Promise.reject(new Error('ws not available in test'))
  wsListener = null
})

function emit(msg: { type: string; payload: unknown }): void {
  wsListener?.(msg)
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

const settingsBody = { settings: {}, schema: {}, deviceSchema: {} }

const baseResponses = {
  '/api/devices/dev-1': { body: { device: idleDevice } },
  '/api/settings': { body: settingsBody },
}

describe('FocusOverlay — loading and basic chrome', () => {
  test('shows loading rows before the device fetch resolves, then the label and an Open full device page link', async () => {
    const { container, getByText } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(screen.getByRole('link', { name: /Open full device page/ }).getAttribute('href')).toBe('/device?id=dev-1')
  })

  test('the close button calls onClose', async () => {
    let closed = false
    const { getByLabelText, getByText } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByLabelText('Close'))
    expect(closed).toBe(true)
  })
})

describe('FocusOverlay — quick control (no "Take control" rail item, plan 91 §3.11)', () => {
  test('an idle device is claimed automatically: lease.acquire is sent and LiveView is enabled', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'lease.acquire') {
        return Promise.resolve({ type: 'lease.acquired', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300 } })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    renderWithApi(<FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />, baseResponses)
    await waitFor(() => expect(wsSendCalls.length + 1).toBeGreaterThan(0)) // let effects settle
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.inputEnabled)).toBe(true))
  })

  test('a busy device is never auto-claimed: no lease.acquire is sent, and the Assist banner is offered instead', async () => {
    let acquireCalled = false
    wsRequestImpl = (msg) => {
      if (msg.type === 'lease.acquire') acquireCalled = true
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const { getByText, getByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    expect(getByRole('button', { name: 'Assist' })).toBeTruthy()
    expect(acquireCalled).toBe(false)
    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && !m.inputEnabled)).toBe(true))
  })

  test('confirming Assist flips LiveView to enabled, without sending any lease.* message', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    wsRequestImpl = (msg) => {
      if (msg.type === 'assist.start') {
        return Promise.resolve({ type: 'assist.started', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300, primary: jobHolder } })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const { getByRole, getByText } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    await user.click(getByRole('button', { name: 'Assist' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText(/checkout@1\.4\.2/)).toBeTruthy())
    await user.click(within(dialog).getByRole('button', { name: 'Assist' }))

    await waitFor(() => expect(liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.inputEnabled)).toBe(true))
    expect(wsSendCalls.some((m) => m.type.startsWith('lease.'))).toBe(false)
    expect(getByText('Assisting — the job still has control')).toBeTruthy()
  })

  test('assist.stopped for a reason other than "released" shows a notice', async () => {
    const { getByText } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    emit({ type: 'assist.stopped', payload: { deviceId: 'dev-1', reason: 'ttl' } })
    await waitFor(() => expect(getByText(/stopped automatically after a period of inactivity/)).toBeTruthy())
  })
})

describe('FocusOverlay — Mirror (plan 91 §3.8, §3.9)', () => {
  test('the toggle is disabled with a reason when fewer than two devices are candidates', async () => {
    const { getByText, getByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(getByRole('switch', { name: /Mirror input/ })).toHaveProperty('disabled', true)
    expect(getByText(/Select at least one more device/)).toBeTruthy()
  })

  test('turning it on opens a confirmation naming the device count, and confirming starts the group', async () => {
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
    const { getByText, getByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    const toggle = getByRole('switch', { name: /Mirror input/ })
    expect(toggle).toHaveProperty('disabled', false)
    fireEvent.click(toggle)
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Control 2 devices at once?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /Control 2 devices/ }))

    // Both requested devices resolved to an active mode (`lease` for the
    // free one, `assist` for the busy one) — `2 / 2` counts everything but
    // `skipped`, proven separately by the `mirror.changed` test below.
    await waitFor(() => expect(getByText('2 / 2 devices active')).toBeTruthy())
    await waitFor(() =>
      expect(
        liveViewMounts.some((m) => m.deviceId === 'dev-1' && m.mirror?.groupId === 'group-1' && m.mirror?.solo === false),
      ).toBe(true),
    )
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
    const { getByText, getByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('switch', { name: /Mirror input/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Control 2 devices/ }))
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
    // `dev-2` dropped to `skipped` (§3.9's auto-drop) — the active count
    // reflects it live, without a fresh `mirror.start`.
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
    const { getByText, getByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('switch', { name: /Mirror input/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Control 2 devices/ }))
    await waitFor(() => expect(getByText('2 / 2 devices active')).toBeTruthy())

    // Simulate `LiveView` reporting `input.mirror.result` back up through
    // the `mirror.onResult` prop it was mounted with — this file mocks
    // `LiveView` out precisely so it can drive that callback directly rather
    // than fabricating a WS frame.
    const mounted = liveViewMounts.find((m) => m.deviceId === 'dev-1' && m.mirror)
    mounted?.mirror?.onResult?.([
      { deviceId: 'dev-1', ok: true, code: null, latencyMs: 12 },
      { deviceId: 'dev-2', ok: false, code: 'orientation_mismatch', latencyMs: 0 },
    ])

    await waitFor(() => expect(getByText('1/2')).toBeTruthy())
    fireEvent.click(getByText('1/2'))
    expect(getByText('pixel 8 — orientation_mismatch')).toBeTruthy()
  })

  test('turning it off sends mirror.stop and clears the group', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: { groupId: 'group-1', focusDeviceId: 'dev-1', members: [{ deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false }] },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText, getByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('switch', { name: /Mirror input/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Control 2 devices/ }))
    // Radix's `Switch` is a `<button role="switch">`, not a native
    // checkbox — there is no `.checked` DOM property, only `aria-checked`.
    await waitFor(() => expect(getByRole('switch', { name: /Mirror input/ }).getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(getByRole('switch', { name: /Mirror input/ }))
    expect(wsSendCalls).toContainEqual({ type: 'mirror.stop', payload: { groupId: 'group-1' } })
    await waitFor(() => expect(getByRole('switch', { name: /Mirror input/ }).getAttribute('aria-checked')).toBe('false'))
  })

  test('unmounting with an active group sends mirror.stop — no group outlives the panel', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'mirror.start') {
        return Promise.resolve({
          type: 'mirror.started',
          payload: { groupId: 'group-9', focusDeviceId: 'dev-1', members: [{ deviceId: 'dev-1', label: 'moto g06', mode: 'lease', reason: null, aspectDrift: false }] },
        })
      }
      return Promise.reject(new Error('unexpected'))
    }
    const other: DeviceInfo = { ...(idleDevice as unknown as DeviceInfo), id: 'dev-2', label: 'pixel 8' }
    const { getByText, getByRole, unmount } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[idleDevice as unknown as DeviceInfo, other]} selectedIds={['dev-2']} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    fireEvent.click(getByRole('switch', { name: /Mirror input/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Control 2 devices/ }))
    await waitFor(() => expect(getByRole('switch', { name: /Mirror input/ }).getAttribute('aria-checked')).toBe('true'))

    unmount()
    expect(wsSendCalls).toContainEqual({ type: 'mirror.stop', payload: { groupId: 'group-9' } })
  })
})

describe('FocusOverlay — End task', () => {
  test('absent when nobody holds the device with a job', async () => {
    const { getByText, queryByRole } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
      baseResponses,
    )
    await waitFor(() => expect(getByText('moto g06')).toBeTruthy())
    expect(queryByRole('button', { name: /End task/ })).toBeNull()
  })

  test('confirming cancels the job via POST /api/jobs/:id/cancel', async () => {
    const { getByText, getByRole, apiMock } = renderWithApi(
      <FocusOverlay deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => {}} />,
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
    // The call itself is the direct signal — waiting on it rather than only
    // on the dialog's own (Radix-animated) unmount, which can lag under a
    // loaded machine and made this assertion flaky.
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/jobs/job-1/cancel')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 3000 })
  })
})

/**
 * The plan's own verbatim verifiable result: "on the Wall with 8 tiles live,
 * opening the overlay leaves the browser decoding 8 streams, not 9; closing
 * it restores the tile." Proven as a mount COUNT, not a screenshot — this is
 * the property that is invisible any other way. Real `WallTile`s (not
 * mocked, unlike `Wall.test.tsx`'s own wiring tests) so its own 91.8
 * "stop decoding while focused" placeholder is genuinely exercised, not
 * assumed.
 */
describe('FocusOverlay — decoder count (the plan\'s own verifiable result)', () => {
  test('8 live tiles plus a focused overlay mount exactly 8 LiveViews, not 9', async () => {
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
        <FocusOverlay deviceId={focusId} devices={tiles} selectedIds={[]} onClose={() => {}} />
      </>,
      baseResponses,
    )

    await waitFor(() => expect(liveViewMounts.length).toBeGreaterThan(0))
    const mountedIds = liveViewMounts.map((m) => m.deviceId)
    expect(mountedIds).toHaveLength(8)
    expect(new Set(mountedIds).size).toBe(8)
    expect(mountedIds).toContain(focusId)
    // The focused tile's OWN WallTile never mounted a second LiveView for
    // dev-1 — the overlay's is the only one.
    expect(mountedIds.filter((id) => id === focusId)).toHaveLength(1)
  })
})
