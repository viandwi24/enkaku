import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'

/**
 * Plan 103 §5 step 103.7 — `Esc` precedence written as its OWN table-driven
 * test, not scattered assertions. `DevicePopup.escape.test.tsx` already
 * proves each rule empirically (one `test()` per rule, with its own prose);
 * this file adds the thing step 103.7 names specifically: `ESC_PRECEDENCE`
 * below IS the table from `DevicePopup.tsx`'s own doc comment (plan 103
 * §3.5) as literal data, and the single loop beneath it drives one real
 * DOM scenario per row — so a future reader who adds a fourth claimant (a
 * new popup layer, say) has an actual table to extend, not three
 * independent test bodies to re-derive the shape of by reading prose.
 */
let wsRequestImpl: (msg: { type: string; id?: string; payload?: unknown }) => Promise<unknown> = () =>
  Promise.reject(new Error('ws not available in test'))
const wsSendCalls: { type: string; payload?: unknown }[] = []
mock.module('@/lib/ws', () => ({
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  ws: {
    on: () => () => {},
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
const busyDevice = {
  ...idleDevice,
  status: 'busy',
  heldBy: { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null },
}
const settingsBody = { settings: {}, schema: {}, deviceSchema: {} }

/** `input.key` with `BACK` (keycode 4, `packages/protocol/src/ui-node.ts`). */
const BACK_KEYCODE = 4

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

/**
 * The table itself — `DevicePopup.tsx`'s own three-row precedence,
 * reproduced as data. `claimant`/`condition`/`outcome` are the exact
 * columns plan 103 §3.5 names; `run` is what makes each row a real
 * assertion rather than a comment.
 */
const ESC_PRECEDENCE: {
  rule: 1 | 2 | 3
  claimant: string
  condition: string
  outcome: string
  run: () => Promise<void>
}[] = [
  {
    rule: 1,
    claimant: 'An open action/read popup',
    condition: 'A dialog (e.g. Assist) is open above the device popup',
    outcome: 'The dialog closes itself; the device popup stays open',
    run: async () => {
      routeStreamStart()
      let closed = false
      const { getByText, getByRole } = renderWithApi(
        <TooltipProvider>
          <DevicePopup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />
        </TooltipProvider>,
        { '/api/devices/dev-1': { body: { device: busyDevice } }, '/api/settings': { body: settingsBody } },
      )
      await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
      fireEvent.click(getByRole('button', { name: 'Assist' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(closed).toBe(false)
    },
  },
  {
    rule: 2,
    claimant: 'The live canvas',
    condition: 'No popup is open, and the canvas has focus with input enabled',
    outcome: 'Esc becomes Android BACK on the device; the device popup stays open',
    run: async () => {
      routeStreamStart()
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
      let closed = false
      const { getByLabelText } = renderWithApi(
        <TooltipProvider>
          <DevicePopup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />
        </TooltipProvider>,
        { '/api/devices/dev-1': { body: { device: idleDevice } }, '/api/settings': { body: settingsBody } },
      )
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
    },
  },
  {
    rule: 3,
    claimant: 'The device popup itself',
    condition: 'No popup is open, and the canvas has not consumed the key (input disabled)',
    outcome: 'The device popup closes; no BACK is sent',
    run: async () => {
      routeStreamStart()
      let closed = false
      const { getByText, getByLabelText } = renderWithApi(
        <TooltipProvider>
          <DevicePopup deviceId="dev-1" devices={[]} selectedIds={[]} onClose={() => (closed = true)} />
        </TooltipProvider>,
        { '/api/devices/dev-1': { body: { device: busyDevice } }, '/api/settings': { body: settingsBody } },
      )
      await waitFor(() => expect(getByText(/checkout@1\.4\.2/)).toBeTruthy())
      const canvas = getByLabelText('Device screen')
      canvas.focus()
      fireEvent.keyDown(canvas, { key: 'Escape' })
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(closed).toBe(true))
      expect(wsSendCalls.some((m) => m.type === 'input.key')).toBe(false)
    },
  },
]

describe('DevicePopup — Esc precedence, table-driven (plan 103 §3.5, §5 step 103.7)', () => {
  test('the table is exactly three rows, in rule order 1 → 2 → 3', () => {
    expect(ESC_PRECEDENCE.map((r) => r.rule)).toEqual([1, 2, 3])
  })

  for (const row of ESC_PRECEDENCE) {
    test(`rule ${row.rule} — ${row.claimant}: ${row.outcome}`, row.run)
  }
})
