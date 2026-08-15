import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * `LiveView`'s Mirror routing (plan 91 §3.8, §3.9, §5 step 91.9) — the one
 * additive change this step made to this file: a new optional `mirror` prop
 * that, when present, sends every pointer/key/text action through ONE
 * `input.mirror` envelope instead of `input.<verb>` (`sendInputAction`,
 * `flushText`'s own mirror branch). `FocusOverlay.test.tsx` proves this
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

const { LiveView } = await import('./LiveView')

afterEach(() => {
  cleanup()
  wsSendCalls.length = 0
  wsRequestImpl = () => Promise.reject(new Error('ws not available in test'))
  wsListener = null
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
    // machine, the same reasoning `FocusOverlay.test.tsx`'s own End-task fix
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
