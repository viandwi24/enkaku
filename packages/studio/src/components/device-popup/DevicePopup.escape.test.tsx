import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * `DevicePopup`'s `Esc` precedence (plan 91 §3.11; plan 103 §3.5's three-row
 * table — replaces `wall/FocusOverlay.escape.test.tsx`, moved rather than
 * duplicated per §4.3): (1) an open action popup takes `Esc` and closes
 * itself, (2) otherwise the live canvas sends `BACK` when it has focus,
 * (3) otherwise `Esc` closes the device popup. This file deliberately does
 * NOT mock `LiveView` (unlike `DevicePopup.test.tsx`) for rules 2 and 3 —
 * the precedence there lives in the interaction between `LiveView`'s real
 * `onKeyDown`/`preventDefault` and this component's own `window` listener,
 * so proving it needs the real thing. Rule 1 uses the real `AssistDialog`
 * for the same reason — Radix's own `DismissableLayer` is what actually
 * implements it, not a line of code in `DevicePopup.tsx`.
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

const { DevicePopup } = await import('./DevicePopup')

afterEach(() => {
  cleanup()
  wsSendCalls.length = 0
  wsRequestImpl = () => Promise.reject(new Error('ws not available in test'))
  wsListener = null
})

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

const settingsBody = { settings: {}, schema: {}, deviceSchema: {} }
const baseResponses = {
  '/api/devices/dev-1': { body: { device: idleDevice } },
  '/api/settings': { body: settingsBody },
}

/** `input.key` with `BACK` (keycode 4, `packages/protocol/src/ui-node.ts`) — the message `LiveView` sends when Esc reaches its own `onKeyDown`. */
const BACK_KEYCODE = 4

function routeRequests() {
  wsRequestImpl = (msg) => {
    if (msg.type === 'lease.acquire') {
      return Promise.resolve({ type: 'lease.acquired', payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300 } })
    }
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

describe('DevicePopup — Esc precedence (plan 103 §3.5)', () => {
  test('rule 1: an open action popup (Assist) takes Esc and closes ITSELF — the device popup stays open', async () => {
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
    const busyDevice = {
      ...idleDevice,
      status: 'busy',
      heldBy: { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
    }
    let closed = false
    const { getByText, getByRole } = renderWithApi(
      <TooltipProvider>
        <DevicePopup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />
      </TooltipProvider>,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    fireEvent.click(getByRole('button', { name: 'Assist' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Escape' })

    // Radix's `DismissableLayer` (capture phase, on `document`) dismisses
    // the TOPMOST open layer and calls `preventDefault()` before this
    // popup's own bubble-phase `window` listener ever sees the event — so
    // the dialog closes and the popup does not, with no code in
    // `DevicePopup.tsx` deciding between the two.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(closed).toBe(false)
  })

  test('rule 2: the canvas focused with input enabled — Esc sends BACK and does NOT close the popup', async () => {
    routeRequests()
    let closed = false
    const { getByLabelText } = renderWithApi(
      <TooltipProvider>
        <DevicePopup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />
      </TooltipProvider>,
      baseResponses,
    )
    // The idle device is auto-claimed (no "Take control" row exists — see
    // `DevicePopup.tsx`'s own header comment) — wait for that to land
    // before touching the canvas, or `inputEnabled` would still be false.
    const canvas = await waitFor(() => getByLabelText('Device screen'))
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.tap')).toBe(true))
    wsSendCalls.length = 0

    canvas.focus()
    fireEvent.keyDown(canvas, { key: 'Escape' })

    await waitFor(() => expect(wsSendCalls.some((m) => m.type === 'input.key')).toBe(true))
    const backSend = wsSendCalls.find((m) => m.type === 'input.key') as { payload?: { keycode?: number } } | undefined
    expect(backSend?.payload?.keycode).toBe(BACK_KEYCODE)
    expect(closed).toBe(false)
  })

  test('rule 3: input NOT enabled (a busy device, not yet assisted) — Esc closes the popup and sends no BACK', async () => {
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
    const busyDevice = {
      ...idleDevice,
      status: 'busy',
      heldBy: { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
    }
    let closed = false
    const { getByText, getByLabelText } = renderWithApi(
      <TooltipProvider>
        <DevicePopup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />
      </TooltipProvider>,
      { ...baseResponses, '/api/devices/dev-1': { body: { device: busyDevice } } },
    )
    await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
    const canvas = getByLabelText('Device screen')
    canvas.focus()
    fireEvent.keyDown(canvas, { key: 'Escape' })
    // `LiveView`'s own `onKeyDown` returns immediately when `inputEnabled`
    // is false — it never calls `preventDefault()`, so the bubbled `window`
    // event this popup listens for is NOT already consumed.
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(closed).toBe(true))
    expect(wsSendCalls.some((m) => m.type === 'input.key')).toBe(false)
  })
})
