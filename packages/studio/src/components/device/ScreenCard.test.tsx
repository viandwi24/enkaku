import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@enkaku/ui'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `ScreenCard` (plan 91 §3.4, §5 step 91.6; plan 94 §4.10, §5 step 94.4):
 * the pre-assist banner, the assisting chrome, and — this step — the
 * `record` mode. `LiveView` (a WebCodecs/WS video decoder) and
 * `InspectorPanel` are mocked out for the SAME reason `WallTile.test.tsx`
 * mocks `LiveView` out of ITS OWN tests — neither is this file's concern,
 * and standing up a real decoder in happy-dom is not needed to prove the
 * chrome around the picture. `lastLiveViewProps` now also feeds
 * `liveViewActiveHistory` (below) — plan 94's brief singles out "a test that
 * only checks the strip renders would leave the property unproven", so
 * entering `record` needs its own proof that the video is never restarted,
 * not just that the mode switch works.
 */
let lastLiveViewProps: Record<string, unknown> | null = null
const liveViewActiveHistory: unknown[] = []
let liveViewRenderCount = 0
mock.module('@/components/LiveView', () => ({
  LiveView: (props: Record<string, unknown>) => {
    lastLiveViewProps = props
    liveViewActiveHistory.push(props.active)
    liveViewRenderCount += 1
    return <div data-testid="live-view-stub" />
  },
}))
mock.module('@/components/InspectorPanel', () => ({
  InspectorPanel: () => <div data-testid="inspector-panel-stub" />,
}))

/**
 * `useRecording` (step 94.4's own new hook) is called unconditionally at
 * `ScreenCard`'s own top level (never gated on `mode === 'record'`) — see
 * that file's own header comment — which means it reaches `@/lib/ws` on
 * EVERY render of this component, not only when a test is exercising
 * recording. A real `WsClient` would try to open an actual `WebSocket` in
 * happy-dom, so this mock is required here even for tests that have nothing
 * to do with recording — the same reason `app/device/page.test.tsx` already
 * mocks this module wholesale.
 */
type WsHandler = (msg: unknown) => void
let wsHandlers: Set<WsHandler> = new Set()
let wsSendCalls: unknown[] = []
let wsRequestImpl: (msg: unknown) => Promise<unknown> = () => Promise.reject(new Error('ws.request is not mocked in this test'))
function emitWs(msg: unknown): void {
  for (const cb of [...wsHandlers]) cb(msg)
}
mock.module('@/lib/ws', () => ({
  coreBase: () => 'http://core.test',
  ws: {
    send: (msg: unknown) => {
      wsSendCalls.push(msg)
    },
    on: (cb: WsHandler) => {
      wsHandlers.add(cb)
      return () => wsHandlers.delete(cb)
    },
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(false)
      return () => {}
    },
    onReconnected: () => () => {},
    isConnected: () => false,
    getSessionId: () => null,
    request: (msg: unknown) => wsRequestImpl(msg),
    connect: () => {},
  },
  newId: () => 'test-id',
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

const { ScreenCard } = await import('./ScreenCard')

afterEach(() => {
  cleanup()
  lastLiveViewProps = null
  liveViewActiveHistory.length = 0
  liveViewRenderCount = 0
  wsHandlers = new Set()
  wsSendCalls = []
  wsRequestImpl = () => Promise.reject(new Error('ws.request is not mocked in this test'))
})

const BASE_PROPS = {
  deviceId: 'dev-1',
  mode: 'live' as const,
  onModeChange: () => {},
  jobRunning: false,
  inputEnabled: false,
  canInspect: false,
  onTakeControl: () => {},
  onActivity: () => {},
  autoReconnect: false,
  visible: true,
}

describe('ScreenCard — the pre-assist banner (plan 91 §3.4 item 1)', () => {
  test('a busy device not yet assisted shows the banner naming the running script, with an Assist button', () => {
    const onAssist = mock(() => {})
    renderWithApi(
      <ScreenCard {...BASE_PROPS} jobRunning assistPrimaryLabel="checkout@1.4.2" onAssist={onAssist} />,
    )
    expect(screen.getByText(/checkout@1\.4\.2/)).toBeTruthy()
    expect(screen.getByText(/is running on this device/)).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Assist' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    expect(onAssist).toHaveBeenCalledTimes(1)
  })

  test('an idle device shows no banner at all', () => {
    renderWithApi(<ScreenCard {...BASE_PROPS} jobRunning={false} assistPrimaryLabel={null} />)
    expect(screen.queryByText(/is running on this device/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assist' })).toBeNull()
  })

  test('no primaryLabel yet (heldBy has not loaded) still reads honestly, generic rather than blank', () => {
    renderWithApi(<ScreenCard {...BASE_PROPS} jobRunning assistPrimaryLabel={null} onAssist={() => {}} />)
    expect(screen.getByText(/A job is running on this device/)).toBeTruthy()
  })

  test('a farm-wide switch turned off disables the button with a reason, rather than hiding it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onAssist = mock(() => {})
    renderWithApi(
      <TooltipProvider>
        <ScreenCard
          {...BASE_PROPS}
          jobRunning
          assistPrimaryLabel="checkout@1.4.2"
          onAssist={onAssist}
          assistDisabledReason="Assisting is turned off for this farm."
        />
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Assist' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.hover(button)
    await waitFor(() => expect(document.body.textContent).toContain('Assisting is turned off for this farm.'))
    expect(onAssist).not.toHaveBeenCalled()
  })

  test('with no onAssist wired (no assist manager on this host), the button never appears — the banner still names the job', () => {
    renderWithApi(<ScreenCard {...BASE_PROPS} jobRunning assistPrimaryLabel="checkout@1.4.2" />)
    expect(screen.getByText(/checkout@1\.4\.2/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Assist' })).toBeNull()
  })
})

describe('ScreenCard — the assisting chrome (plan 91 §3.4 item 2)', () => {
  test('replaces the pre-assist banner once a grant exists', () => {
    renderWithApi(
      <ScreenCard
        {...BASE_PROPS}
        jobRunning
        inputEnabled
        assistPrimaryLabel="checkout@1.4.2"
        onAssist={() => {}}
        assisting={{ secondsLeft: 221 }}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Assist' })).toBeNull()
    expect(screen.getByText('Assisting — the job still has control')).toBeTruthy()
  })

  test('the rack-label and readout countdown render with the right classes', () => {
    const { container } = renderWithApi(
      <ScreenCard {...BASE_PROPS} jobRunning inputEnabled assisting={{ secondsLeft: 221 }} />,
    )
    expect(container.querySelector('.rack-label')?.textContent).toBe('Assisting — the job still has control')
    expect(container.querySelector('.readout')?.textContent).toBe('3:41')
    // Amber, not the status rail's own colour vocabulary (§3.4 item 3: the
    // rail itself is never touched by this).
    expect(container.querySelector('.border-led-warn')).toBeTruthy()
  })

  test('"Stop assisting" fires the handler when wired, and is absent when it is not', () => {
    const onStopAssisting = mock(() => {})
    const { rerender, getByText, queryByText } = renderWithApi(
      <ScreenCard {...BASE_PROPS} jobRunning assisting={{ secondsLeft: 10 }} onStopAssisting={onStopAssisting} />,
    )
    getByText('Stop assisting').click()
    expect(onStopAssisting).toHaveBeenCalledTimes(1)

    rerender(<ScreenCard {...BASE_PROPS} jobRunning assisting={{ secondsLeft: 10 }} />)
    expect(queryByText('Stop assisting')).toBeNull()
  })
})

describe('ScreenCard — input wiring (plan 91 §5 step 91.6)', () => {
  test('`inputEnabled` is forwarded to `LiveView` verbatim — the actual `(iHoldControl && !busy) || iAmAssisting` decision is the caller\'s (device/page.tsx), proven there', () => {
    renderWithApi(<ScreenCard {...BASE_PROPS} inputEnabled={false} />)
    expect(screen.getByTestId('live-view-stub')).toBeTruthy()
    expect(lastLiveViewProps?.inputEnabled).toBe(false)

    renderWithApi(<ScreenCard {...BASE_PROPS} jobRunning inputEnabled assisting={{ secondsLeft: 10 }} />)
    expect(lastLiveViewProps?.inputEnabled).toBe(true)
  })
})

/**
 * Plan 94 §4.10, F17, §5 step 94.4 — `record` as a third mode. The brief's
 * own warning: "a test that only checks the strip renders would leave the
 * property unproven" — so the first describe block below is not about the
 * step strip at all. It is the proof that entering `record` never restarts
 * the video: the SAME `live-view-stub` DOM node stays in the document
 * (`querySelector` returns reference-equal elements across the mode
 * switch — React never unmounted and remounted it) and `active` never drops
 * to `false` on the way from `live` to `record`, which is the prop that
 * actually controls whether `LiveView`'s own decoder/WS subscription tears
 * down (`LiveView.tsx`).
 */
describe('ScreenCard — record mode never restarts the video (plan 94 §5 step 94.4, the hard part)', () => {
  test('the live-view DOM node is the SAME element before and after switching live -> record -> live, and `active` never goes false in between', () => {
    const { container, rerender } = renderWithApi(
      <ScreenCard {...BASE_PROPS} mode="live" visible inputEnabled />,
    )
    const nodeBeforeSwitch = container.querySelector('[data-testid="live-view-stub"]')
    expect(nodeBeforeSwitch).toBeTruthy()
    expect(lastLiveViewProps?.active).toBe(true)
    const renderCountBefore = liveViewRenderCount

    rerender(<ScreenCard {...BASE_PROPS} mode="record" visible inputEnabled />)
    expect(lastLiveViewProps?.active).toBe(true)
    // React re-rendered LiveView (its props changed), but never unmounted it
    // — `renderCount` grew, and the DOM node it produced is the identical
    // object, not a fresh one a remount would have produced.
    expect(liveViewRenderCount).toBeGreaterThan(renderCountBefore)
    const nodeDuringRecord = container.querySelector('[data-testid="live-view-stub"]')
    expect(nodeDuringRecord).toBe(nodeBeforeSwitch)

    rerender(<ScreenCard {...BASE_PROPS} mode="live" visible inputEnabled />)
    expect(container.querySelector('[data-testid="live-view-stub"]')).toBe(nodeBeforeSwitch)
    // Not a single render in the whole live -> record -> live sequence ever
    // saw `active: false` — the property the brief calls "the hard part".
    expect(liveViewActiveHistory.every((v) => v === true)).toBe(true)
  })

  test('switching to `inspect` (the one mode that DOES swap the picture) still keeps the same video node mounted, merely hidden', () => {
    const { container, rerender } = renderWithApi(<ScreenCard {...BASE_PROPS} mode="live" visible inputEnabled />)
    const node = container.querySelector('[data-testid="live-view-stub"]')
    rerender(<ScreenCard {...BASE_PROPS} mode="inspect" visible inputEnabled canInspect />)
    expect(container.querySelector('[data-testid="live-view-stub"]')).toBe(node)
    // `inspect` is the one mode where the picture genuinely stops being the
    // live feed — `active` correctly goes false here (unlike `record`).
    expect(lastLiveViewProps?.active).toBe(false)
  })
})

describe('ScreenCard — the Record mode button', () => {
  test('is a third button, alongside Live and Inspect, and switches mode on click', () => {
    const onModeChange = mock(() => {})
    renderWithApi(<ScreenCard {...BASE_PROPS} mode="live" onModeChange={onModeChange} />)
    const group = screen.getByRole('group', { name: 'Screen mode' })
    expect(group.textContent).toContain('Record')
    screen.getByRole('button', { name: /Record/ }).click()
    expect(onModeChange).toHaveBeenCalledWith('record')
  })

  test('a structural block (a node-owned device) disables the button with a reason, rather than hiding it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(
      <TooltipProvider>
        <ScreenCard {...BASE_PROPS} recordDisabledReason="Recording is not available for cloud (node-owned) devices yet." />
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: /Record/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.hover(button)
    await waitFor(() => expect(document.body.textContent).toContain('Recording is not available for cloud (node-owned) devices yet.'))
  })

  test('a small red dot marks the button while a recording is active, even while a different mode is on screen', async () => {
    wsRequestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: BASE_PROPS.deviceId, active: true, stepCount: 0, startedAt: 1000 } })
    const { container } = renderWithApi(<ScreenCard {...BASE_PROPS} mode="record" inputEnabled />)
    expect(container.querySelector('[aria-label="Recording in progress"]')).toBeNull()
    act(() => screen.getByRole('button', { name: 'Start recording' }).click())
    await waitFor(() => expect(container.querySelector('[aria-label="Recording in progress"]')).toBeTruthy())
  })
})

describe('ScreenCard — the record panel is wired to the live WS surface (plan 94 §5 step 94.4)', () => {
  test('records, sees steps appear as they arrive, stops, and lands on the review panel', async () => {
    wsRequestImpl = (msg: unknown) => {
      const m = msg as { type: string }
      if (m.type === 'recording.start') {
        return Promise.resolve({ type: 'recording.state', payload: { deviceId: BASE_PROPS.deviceId, active: true, stepCount: 0, startedAt: 1000 } })
      }
      return Promise.resolve({ type: 'recording.state', payload: { deviceId: BASE_PROPS.deviceId, active: false, stepCount: 2, startedAt: 1000 } })
    }
    renderWithApi(<ScreenCard {...BASE_PROPS} mode="record" inputEnabled />)

    act(() => screen.getByRole('button', { name: 'Start recording' }).click())
    await waitFor(() => expect(screen.getByText('Recording')).toBeTruthy())

    act(() => emitWs({ type: 'recording.step', payload: { deviceId: BASE_PROPS.deviceId, index: 0, kind: 'tap', hasCandidate: true } }))
    act(() => emitWs({ type: 'recording.step', payload: { deviceId: BASE_PROPS.deviceId, index: 1, kind: 'swipe', hasCandidate: false } }))
    expect(screen.getAllByRole('listitem').length).toBe(2)
    expect(screen.getByText('2 steps')).toBeTruthy()

    act(() => screen.getByRole('button', { name: /Stop/ }).click())
    await waitFor(() => expect(screen.getByText('Review')).toBeTruthy())
    // The video was never touched by any of this (proven above) — this test
    // is the end-to-end shape the plan's verifiable result names.
  })

  test('the recording ending on its own (a lease loss, never a Stop click) still lands the operator on the review panel, naming why', async () => {
    wsRequestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: BASE_PROPS.deviceId, active: true, stepCount: 0, startedAt: 1000 } })
    renderWithApi(<ScreenCard {...BASE_PROPS} mode="record" inputEnabled />)
    act(() => screen.getByRole('button', { name: 'Start recording' }).click())
    await waitFor(() => expect(screen.getByText('Recording')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeTruthy()

    act(() =>
      emitWs({
        type: 'recording.state',
        payload: { deviceId: BASE_PROPS.deviceId, active: false, stepCount: 5, startedAt: 1000, stoppedReason: 'lease-lost' },
      }),
    )
    await waitFor(() => expect(screen.getByText('Review')).toBeTruthy())
    expect(screen.getByText(/control of this device was lost/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull()
  })

  test('Discard sends recording.cancel and returns to the idle "Start recording" state', async () => {
    wsRequestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: BASE_PROPS.deviceId, active: true, stepCount: 0, startedAt: 1000 } })
    renderWithApi(<ScreenCard {...BASE_PROPS} mode="record" inputEnabled />)
    act(() => screen.getByRole('button', { name: 'Start recording' }).click())
    await waitFor(() => expect(screen.getByText('Recording')).toBeTruthy())

    act(() => screen.getByRole('button', { name: /Discard/ }).click())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeTruthy())
    expect(wsSendCalls).toContainEqual({ type: 'recording.cancel', payload: { deviceId: BASE_PROPS.deviceId } })
  })

  test('the core-restart caveat is on screen in record mode, before anything is started', () => {
    renderWithApi(<ScreenCard {...BASE_PROPS} mode="record" inputEnabled />)
    expect(screen.getByText(/lives only in this core.s memory until it is saved/)).toBeTruthy()
  })

  test('without input enabled, Start recording is disabled with a reason — recording needs the same lease manual input does', () => {
    renderWithApi(<ScreenCard {...BASE_PROPS} mode="record" inputEnabled={false} />)
    const button = screen.getByRole('button', { name: 'Start recording' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Take control to record.')).toBeTruthy()
  })
})
