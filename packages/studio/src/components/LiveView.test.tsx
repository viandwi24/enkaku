import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * `LiveView`'s Mirror routing (plan 91 §3.8, §3.9, §5 step 91.9) — the one
 * additive change this step made to this file: a new optional `mirror` prop
 * that, when present, sends every pointer/key/text action through ONE
 * `input.mirror` envelope instead of `input.<verb>` (`sendInputAction`,
 * `flushText`'s own mirror branch). `DevicePopup.test.tsx` proves this
 * component receives the RIGHT `mirror` prop; this file proves the prop, once
 * received, is actually acted on — the two are deliberately separate so
 * `LiveView` itself, the reusable component, carries its own coverage rather
 * than only being exercised indirectly through one caller.
 */
let wsRequestImpl: (msg: { type: string; id?: string; payload?: unknown }) => Promise<unknown> = () =>
  Promise.reject(new Error('ws not available in test'))
const wsSendCalls: { type: string; payload?: unknown }[] = []
let wsListener: ((m: { type: string; payload: unknown }) => void) | null = null
mock.module('@/lib/ws', () => ({
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
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(true)
      return () => {}
    },
    onReconnected: () => () => {},
    getSessionId: () => 's1',
    isConnected: () => true,
    send: (msg: { type: string; payload?: unknown }) => wsSendCalls.push(msg),
    request: (msg: { type: string; id?: string; payload?: unknown }) => wsRequestImpl(msg),
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

/**
 * Plan 103 step 103.9 — `fitContainer`'s sizing effect needs a real
 * `ResizeObserver` to attach to; happy-dom has none (the same gap
 * `WorkflowBuilder.test.tsx`/`WorkflowCanvas.test.tsx` document for
 * `@xyflow/react`). This stub is deliberately CONTROLLABLE rather than a
 * no-op: it captures the callback `LiveView` passed in and the element it
 * asked to observe, so a test can fire a resize "notification" on demand
 * (`triggerResize()`) instead of only relying on the effect's own initial
 * synchronous `recompute()` call.
 */
let resizeObserverCallback: (() => void) | null = null
let resizeObserverTarget: Element | null = null
class StubResizeObserver {
  constructor(cb: () => void) {
    resizeObserverCallback = cb
  }
  observe(el: Element) {
    resizeObserverTarget = el
  }
  unobserve() {}
  disconnect() {
    resizeObserverCallback = null
    resizeObserverTarget = null
  }
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver

function triggerResize() {
  resizeObserverCallback?.()
}

/** A `DOMRect`-shaped object is enough for `getBoundingClientRect` callers here — only `width`/`height` are read. */
function rect(width: number, height = 0): DOMRect {
  return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

const { LiveView } = await import('./LiveView')

afterEach(() => {
  cleanup()
  wsSendCalls.length = 0
  wsRequestImpl = () => Promise.reject(new Error('ws not available in test'))
  wsListener = null
  resizeObserverCallback = null
  resizeObserverTarget = null
})

function routeStreamStart() {
  wsRequestImpl = (msg) => {
    if (msg.type === 'stream.start') {
      return Promise.resolve({
        type: 'stream.started',
        id: msg.id,
        payload: { deviceId: 'dev-1', streamId: 1, codec: 'png', width: 1080, height: 2400 },
      })
    }
    return Promise.reject(new Error(`unexpected request: ${msg.type}`))
  }
}

function renderCanvas(props: Partial<Parameters<typeof LiveView>[0]> = {}) {
  const utils = render(
    <TooltipProvider>
      <LiveView deviceId="dev-1" inputEnabled quality="control" {...props} />
    </TooltipProvider>,
  )
  return utils.getByLabelText('Device screen') as HTMLCanvasElement
}

describe('LiveView — ordinary (no mirror prop): unchanged single-device behaviour', () => {
  test('a tap sends input.tap with deviceId, not input.mirror', async () => {
    routeStreamStart()
    const canvas = renderCanvas()
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.tap')).toBe(true))
    expect(wsSendCalls.some((m) => m.type === 'input.mirror')).toBe(false)
  })

  /**
   * Plan 94 §4.4 (closes F4/F5): a tap's measured pointer down→up duration
   * now travels on the wire as `holdMs` — before this step `input.tap`
   * carried only `pos`, so a long-press could not be expressed (or later
   * recorded) at all.
   */
  test('a tap sends holdMs — the measured pointer down→up duration', async () => {
    routeStreamStart()
    const canvas = renderCanvas()
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.tap')).toBe(true))
    const sent = wsSendCalls.find((m) => m.type === 'input.tap') as { payload: { holdMs?: number } }
    expect(typeof sent.payload.holdMs).toBe('number')
    expect(sent.payload.holdMs).toBeGreaterThanOrEqual(0)
  })
})

describe('LiveView — Mirror routing (plan 91 §3.8, §3.9)', () => {
  test('a tap, with a mirror group set and solo off, sends input.mirror naming the group and no soloDeviceId', async () => {
    routeStreamStart()
    const canvas = renderCanvas({ mirror: { groupId: 'group-1', solo: false } })
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.mirror')).toBe(true))
    expect(wsSendCalls.some((m) => m.type === 'input.tap')).toBe(false)
    const sent = wsSendCalls.find((m) => m.type === 'input.mirror') as {
      payload: { groupId: string; seq: number; action: { verb: string }; soloDeviceId?: string }
    }
    expect(sent.payload.groupId).toBe('group-1')
    expect(sent.payload.action.verb).toBe('tap')
    expect(sent.payload.soloDeviceId).toBeUndefined()
  })

  test('solo (Alt / "Focused only") narrows the SAME dispatch to soloDeviceId, without leaving mirror mode', async () => {
    routeStreamStart()
    const canvas = renderCanvas({ mirror: { groupId: 'group-1', solo: true } })
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.mirror')).toBe(true))
    const sent = wsSendCalls.find((m) => m.type === 'input.mirror') as { payload: { soloDeviceId?: string } }
    expect(sent.payload.soloDeviceId).toBe('dev-1')
  })

  test('a hardware/nav button press (a keycode, not a canvas event) also routes through input.mirror while mirroring', async () => {
    routeStreamStart()
    const utils = render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled quality="control" mirror={{ groupId: 'group-1', solo: false }} />
      </TooltipProvider>,
    )
    fireEvent.click(utils.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.mirror')).toBe(true))
    const sent = wsSendCalls.find((m) => m.type === 'input.mirror') as { payload: { action: { verb: string; keycode?: number } } }
    expect(sent.payload.action.verb).toBe('key')
  })

  test('typed text, while mirroring, is sent as one input.mirror text action rather than the single-device input.text ladder', async () => {
    routeStreamStart()
    const canvas = renderCanvas({ mirror: { groupId: 'group-1', solo: false } })
    canvas.focus()
    fireEvent.keyDown(canvas, { key: 'h' })
    // `flushText` debounces (`TEXT_DEBOUNCE_MS`, 500ms) — a longer timeout
    // than the library default keeps this from flaking under a loaded
    // machine, the same reasoning `DevicePopup.test.tsx`'s own End-task fix
    // documents.
    await waitFor(
      () => expect(wsSendCalls.some((m) => m.type === 'input.mirror')).toBe(true),
      { timeout: 3000 },
    )
    expect(wsSendCalls.some((m) => m.type === 'input.text')).toBe(false)
    const sent = wsSendCalls.find((m) => m.type === 'input.mirror') as { payload: { action: { verb: string; text?: string } } }
    expect(sent.payload.action.verb).toBe('text')
    expect(sent.payload.action.text).toBe('h')
  })

  test('input.mirror.result for THIS group calls onResult; a different group is ignored', async () => {
    routeStreamStart()
    const results: unknown[] = []
    renderCanvas({ mirror: { groupId: 'group-1', solo: false, onResult: (r) => results.push(r) } })
    await waitFor(() => expect(wsListener).not.toBeNull())

    wsListener?.({ type: 'input.mirror.result', payload: { groupId: 'some-other-group', seq: 1, results: ['nope'] } })
    expect(results).toHaveLength(0)

    wsListener?.({
      type: 'input.mirror.result',
      payload: { groupId: 'group-1', seq: 1, results: [{ deviceId: 'dev-1', ok: true, code: null, latencyMs: 5 }] },
    })
    await waitFor(() => expect(results).toHaveLength(1))
    expect(results[0]).toEqual([{ deviceId: 'dev-1', ok: true, code: null, latencyMs: 5 }])
  })

  test('clipboard.set (Cmd/Ctrl+V paste) is never routed through input.mirror — §3.10 forbids mirroring it structurally', async () => {
    routeStreamStart()
    let clipboardSetCalled = false
    wsRequestImpl = (msg) => {
      if (msg.type === 'stream.start') {
        return Promise.resolve({
          type: 'stream.started',
          id: msg.id,
          payload: { deviceId: 'dev-1', streamId: 1, codec: 'png', width: 1080, height: 2400 },
        })
      }
      if (msg.type === 'clipboard.set') {
        clipboardSetCalled = true
        return Promise.resolve({ type: 'clipboard.ok', id: msg.id, payload: {} })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve('hello') },
      configurable: true,
    })
    try {
      const canvas = renderCanvas({ mirror: { groupId: 'group-1', solo: false } })
      canvas.focus()
      fireEvent.keyDown(canvas, { key: 'v', metaKey: true })
      // Wait for the REAL effect (the `clipboard.set` request actually
      // completing) before asserting the negative — asserting "never sent"
      // against a `waitFor` would otherwise pass trivially on its very
      // first, immediate check, before the async paste had any chance to
      // run at all.
      await waitFor(() => expect(clipboardSetCalled).toBe(true))
      expect(wsSendCalls.some((m) => m.type === 'input.mirror')).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true })
    }
  })
})

/**
 * The wake-up phase panel, compact vs full (Plan 92 §4.7, fixes F16):
 * `compact` (a Wall tile) gets a spinner and one word, never the four-step
 * breadcrumb the device page draws — a 100 px column has room for one word,
 * not a wall of text (F16's own evidence).
 */
describe('LiveView — the wake-up phase panel, compact vs full (Plan 92 §4.7, fixes F16)', () => {
  test('compact mode shows one word for the phase, not the four-step breadcrumb', async () => {
    routeStreamStart()
    renderCanvas({ compact: true })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({ type: 'session.progress', payload: { deviceId: 'dev-1', phase: 'waking' } })
    await waitFor(() => expect(document.body.textContent).toContain('Waking'))
    // None of the OTHER breadcrumb steps, and not the full sentence-form
    // headline either — compact never mounts `PHASE_STEPS` at all.
    expect(document.body.textContent).not.toContain('Waiting for the first frame')
    expect(document.body.textContent).not.toContain('Starting video')
    expect(document.body.textContent).not.toContain('Waking the device')
  })

  test('the full (device page) panel still shows the sentence headline and the four-step breadcrumb', async () => {
    routeStreamStart()
    renderCanvas({ compact: false })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({ type: 'session.progress', payload: { deviceId: 'dev-1', phase: 'waking' } })
    await waitFor(() => expect(document.body.textContent).toContain('Waking the device'))
    expect(document.body.textContent).toContain('Waiting for the first frame')
  })
})

/**
 * `session.progress.detail`, finally rendered (plan 92 §3.8 rule 5, §4.5,
 * §5 step 92.2 — fixes F17). Before this step `SessionProgressMessage`
 * already carried an optional `detail` and `LiveView` parsed the message but
 * read only `phase`, so a session restarted by a video settings change was
 * indistinguishable from an ordinary reconnect. Both compact (Wall tile) and
 * full (device page) panels are covered — F17 named both surfaces.
 */
describe('LiveView — session.progress.detail, rendered under the phase headline (plan 92 §3.8 rule 5, fixes F17)', () => {
  test('compact mode shows the detail under the one-word phase label', async () => {
    routeStreamStart()
    renderCanvas({ compact: true })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({
      type: 'session.progress',
      payload: { deviceId: 'dev-1', phase: 'starting-video', detail: 'applying new video settings' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('applying new video settings'))
    // The compact phase word (92.6's own one-word convention) is still there
    // — the detail is ADDITIVE, not a replacement for it.
    expect(document.body.textContent).toContain('Video')
  })

  test('the full (device page) panel shows the detail under the sentence headline', async () => {
    routeStreamStart()
    renderCanvas({ compact: false })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({
      type: 'session.progress',
      payload: { deviceId: 'dev-1', phase: 'starting-video', detail: 'applying new video settings' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('applying new video settings'))
    expect(document.body.textContent).toContain('Starting video')
  })

  test('a phase with no detail renders no detail line at all — nothing invented', async () => {
    routeStreamStart()
    renderCanvas({ compact: false })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({ type: 'session.progress', payload: { deviceId: 'dev-1', phase: 'waking' } })
    await waitFor(() => expect(document.body.textContent).toContain('Waking the device'))
    expect(document.body.textContent).not.toContain('applying new video settings')
  })

  test('a fresh mount clears a PRIOR detail — a restart the operator watched does not leak its explanation into the next one', async () => {
    routeStreamStart()
    renderCanvas({ compact: false })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({
      type: 'session.progress',
      payload: { deviceId: 'dev-1', phase: 'starting-video', detail: 'applying new video settings' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('applying new video settings'))
    // The next phase for the SAME session, with no detail of its own, drops it.
    wsListener?.({ type: 'session.progress', payload: { deviceId: 'dev-1', phase: 'waiting-frame' } })
    await waitFor(() => expect(document.body.textContent).toContain('Waiting for the first frame'))
    expect(document.body.textContent).not.toContain('applying new video settings')
  })
})

/**
 * Plan 100 §3.2, §3.7 item 2, §4.4, §5 step 100.5 — a `control` request
 * whose dedicated second scrcpy session could not be built: the server
 * substitutes the device's already-open `wall` entry (`quality: 'wall'` on
 * the wire even though `control` was requested) and says so via
 * `degradedReason`/`degradedDetail`. The client must render this honestly
 * — never under the ordinary Control label — with a Retry action.
 */
describe('LiveView — control session unavailable, showing the wall picture instead (plan 100 §3.2, §3.7 item 2, §4.4, §5 step 100.5)', () => {
  test('renders §4.4\'s wording with the reason, and offers Retry', async () => {
    wsRequestImpl = (msg) => {
      if (msg.type === 'stream.start') {
        return Promise.resolve({
          type: 'stream.started',
          id: msg.id,
          payload: {
            deviceId: 'dev-1',
            streamId: 1,
            codec: 'png',
            width: 480,
            height: 1040,
            quality: 'wall',
            degradedReason: 'control_session_unavailable',
            degradedDetail: 'encoder busy: only one concurrent MediaCodec session on this chipset',
          },
        })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const utils = render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled quality="control" />
      </TooltipProvider>,
    )
    await waitFor(() => expect(document.body.textContent).toContain('A dedicated full-quality view could not be started for this device'))
    expect(document.body.textContent).toContain('encoder busy: only one concurrent MediaCodec session on this chipset')
    expect(document.body.textContent).toContain('Showing the wall')
    // Never worded as ordinary Control — the reason is visible, not swallowed.
    expect(utils.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  test('an ordinary control acquire (no degradedReason) shows no banner at all', async () => {
    routeStreamStart()
    renderCanvas()
    await waitFor(() => expect(wsListener).not.toBeNull())
    expect(document.body.textContent).not.toContain('A dedicated full-quality view could not be started')
  })

  test('Retry re-issues stream.start — the client-side half of "re-attempt the fast path"', async () => {
    let startCalls = 0
    wsRequestImpl = (msg) => {
      if (msg.type === 'stream.start') {
        startCalls++
        return Promise.resolve({
          type: 'stream.started',
          id: msg.id,
          payload: {
            deviceId: 'dev-1',
            streamId: startCalls,
            codec: 'png',
            width: 480,
            height: 1040,
            quality: 'wall',
            degradedReason: 'control_session_unavailable',
          },
        })
      }
      return Promise.reject(new Error(`unexpected request: ${msg.type}`))
    }
    const utils = render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled quality="control" />
      </TooltipProvider>,
    )
    await waitFor(() => expect(startCalls).toBe(1))
    fireEvent.click(utils.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(startCalls).toBe(2))
  })
})

/**
 * The "Stream stopped" overlay, compact vs full (Plan 92 §4.7): the overlay
 * itself already existed and already translated the reason (`explain`) —
 * this step only adds the compact sizing, so the full panel's own wording
 * is a regression check, not new behaviour.
 */
describe('LiveView — the stopped overlay, compact vs full (Plan 92 §4.7)', () => {
  test('compact mode shows the translated reason and "Try again", not the "Stream stopped" headline', async () => {
    routeStreamStart()
    renderCanvas({ compact: true })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({ type: 'stream.ended', payload: { deviceId: 'dev-1', reason: 'device unauthorized' } })
    await waitFor(() => expect(document.body.textContent).toContain('has not allowed debugging yet'))
    expect(document.body.textContent).not.toContain('Stream stopped')
    expect(document.body.textContent).toContain('Try again')
  })

  test('the full panel keeps "Stream stopped" and "Try connecting again"', async () => {
    routeStreamStart()
    renderCanvas({ compact: false })
    await waitFor(() => expect(wsListener).not.toBeNull())
    wsListener?.({ type: 'stream.ended', payload: { deviceId: 'dev-1', reason: 'device unauthorized' } })
    await waitFor(() => expect(document.body.textContent).toContain('Stream stopped'))
    expect(document.body.textContent).toContain('Try connecting again')
  })
})

/**
 * Plan 106 §5 step 106.7 — the screen-panel overlay for a component
 * installing on this device right now (the owner's own ask: *"bisa ngga
 * kalau preparation lagi diinstall itu ada loadingnya di screen
 * castingnya?"*). `DevicePopup.test.tsx` proves DevicePopup computes and
 * passes the RIGHT `provisioning` prop; this file proves the prop, once
 * received, renders as a non-blocking indeterminate indicator — never a
 * percentage, never something that blocks the canvas — the same split this
 * file already uses for `mirror`.
 */
describe('LiveView — the provisioning overlay (plan 106 §5 step 106.7)', () => {
  test('renders nothing when provisioning is absent', () => {
    renderCanvas({ provisioning: null })
    expect(document.body.textContent).not.toContain('Installing')
  })

  test('names the component and shows elapsed time, never a percentage', () => {
    renderCanvas({ provisioning: { componentId: 'ui-server', label: 'UI server (openatx)', startedAt: Math.floor(Date.now() / 1000) - 12 } })
    expect(document.body.textContent).toContain('Installing UI server (openatx)')
    expect(document.body.textContent).toContain('12s')
    expect(document.body.textContent).not.toMatch(/%/)
  })

  test('is non-blocking: pointer-events-none, and never disables the canvas', () => {
    const canvas = renderCanvas({ provisioning: { componentId: 'ui-server', label: 'UI server (openatx)', startedAt: Math.floor(Date.now() / 1000) } })
    const overlay = document.querySelector('[data-testid="live-view-provisioning-overlay"]')
    expect(overlay).toBeTruthy()
    expect(overlay?.className).toContain('pointer-events-none')
    expect(canvas.className).not.toContain('pointer-events-none')
  })

  test('compact mode (a Wall tile) never renders it, even if a caller passed it', () => {
    render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled={false} quality="wall" compact provisioning={{ componentId: 'ui-server', label: 'UI server', startedAt: 0 }} />
      </TooltipProvider>,
    )
    expect(document.querySelector('[data-testid="live-view-provisioning-overlay"]')).toBeNull()
  })
})

/**
 * Plan 103 step 103.9 — the `fitContainer` panel takes the PICTURE's own
 * aspect ratio, computed from the LIVE stream (`stream.started`/
 * `stream.meta`, never the device registry's stored `screenW`/`screenH`),
 * instead of whatever leftover width `flex-1` handed it in the caller. See
 * `LiveView.tsx`'s own sizing effect for the full formula this exercises.
 */
describe('LiveView — fitContainer takes the picture\'s own aspect ratio (plan 103 step 103.9)', () => {
  test('the root panel is given an explicit pixel width, derived from the video-area height and the stream aspect ratio', async () => {
    routeStreamStart() // stream.started reports width: 1080, height: 2400 → ratio 0.45
    const { getByTestId, getByLabelText, getByText } = render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled quality="control" rail={false} fitContainer />
      </TooltipProvider>,
    )
    // Wait for the REAL ratio (1080×2400, via `stream.started`) to have
    // landed before measuring — the sizing effect also runs once on mount
    // with the 9/16 fallback (before this resolves), and racing that
    // transient run would size against the wrong ratio.
    await waitFor(() => expect(getByText('1080×2400')).toBeTruthy())
    expect(resizeObserverTarget).toBe(getByTestId('live-view-video-area'))

    const root = getByTestId('live-view-root')
    const videoArea = getByTestId('live-view-video-area')
    const canvas = getByLabelText('Device screen')
    // videoArea is `p-4` padded around the canvas, and root's own 1px border
    // sits outside videoArea — both measured, never hardcoded (see the
    // sizing effect's own comment): here, padding = 300 - 268 = 32,
    // border = 302 - 300 = 2.
    root.getBoundingClientRect = () => rect(302)
    videoArea.getBoundingClientRect = () => rect(300, 600)
    canvas.getBoundingClientRect = () => rect(268)

    triggerResize()
    // canvasHeight = 600 - 32 = 568; idealCanvasWidth = 568 * 0.45 = 255.6;
    // idealPanelWidth = round(255.6 + 32 + 2) = 290.
    await waitFor(() => expect(root.style.width).toBe('290px'))
  })

  test('a rotation (a NEW stream.meta, the live stream — not a stored column) re-derives the width in the same effect, no extra resize needed', async () => {
    routeStreamStart()
    const { getByTestId, getByLabelText, getByText } = render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled quality="control" rail={false} fitContainer />
      </TooltipProvider>,
    )
    await waitFor(() => expect(getByText('1080×2400')).toBeTruthy())

    const root = getByTestId('live-view-root')
    const videoArea = getByTestId('live-view-video-area')
    const canvas = getByLabelText('Device screen')
    root.getBoundingClientRect = () => rect(302)
    videoArea.getBoundingClientRect = () => rect(300, 600)
    canvas.getBoundingClientRect = () => rect(268)
    triggerResize()
    await waitFor(() => expect(root.style.width).toBe('290px'))

    // The device rotates: the SAME message (`stream.meta`) that updates the
    // status line's own "WxH" readout also drives this — no separate
    // rotation event exists, and none should have to.
    wsListener?.({ type: 'stream.meta', payload: { streamId: 1, width: 2400, height: 1080 } })
    // ratio flips to 2400/1080 ≈ 2.2222; canvasHeight is unchanged (568);
    // idealPanelWidth = round(568 * 2400/1080 + 32 + 2) = round(1296.2) = 1296.
    await waitFor(() => expect(root.style.width).toBe('1296px'))
  })

  test('compact mode never sets an explicit width — the fixed aspect-[9/16] Wall tile box governs it instead', async () => {
    routeStreamStart()
    const { getByLabelText } = render(
      <TooltipProvider>
        <LiveView deviceId="dev-1" inputEnabled={false} quality="wall" compact />
      </TooltipProvider>,
    )
    await waitFor(() => expect(getByLabelText('Device screen')).toBeTruthy())
    expect(resizeObserverTarget).toBeNull()
  })
})
