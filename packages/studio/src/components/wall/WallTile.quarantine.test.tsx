import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * The Wall's quarantine tile (field report, 2026-08-26).
 *
 * The tile had ALWAYS rendered the reason — `temperature reached 45.6°C` —
 * and had never offered the way out: `onReleaseQuarantine` reached
 * `DeviceCard` (List view) and stopped there, and `Wall` was never handed
 * one to pass down. Wall is the default view, so on a real farm the reported
 * symptom was "temperature reached cannot be dismissed, and there is no
 * setting for it": the button existed, one view away, with nothing on screen
 * saying so.
 *
 * `@/lib/ws` is stubbed for the same reason `DeviceContextMenu.test.tsx`
 * stubs it — `WallTile` pulls in `LiveView` through its streaming branch.
 * A quarantined tile never mounts that branch, but the import still runs.
 */
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
    onReconnected: () => () => {},
    onBinary: () => () => {},
    send: () => {},
    request: () => Promise.reject(new Error('ws not available in test')),
    getSessionId: () => 'test-session',
  },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { WallTile } = await import('./WallTile')

afterEach(cleanup)

const QUARANTINED = {
  id: 'dev-1',
  stableId: 'R5CT81JZR3B',
  serial: '192.168.10.227:5555',
  label: 'SM-F721U1',
  androidVersion: '16',
  apiLevel: 36,
  screenW: 1080,
  screenH: 1920,
  density: 280,
  status: 'quarantined',
  lastSeen: 1,
  battery: { level: 40, temperatureC: 31.8, status: 'discharging', health: 'good', voltageMv: 4300, updatedAt: 1 },
  quarantineReason: 'thermal:45.6C',
  tags: [],
  cluster: null,
  lastCrashAt: null,
  readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
  heldBy: null,
  transport: 'adb-usb',
  number: 2,
  connection: { kind: 'network', medium: 'wifi', mediumSource: 'declared', address: '192.168.10.227', port: 5555, networkLabel: null },
} as unknown as Parameters<typeof WallTile>[0]['device']

function renderTile(over: Partial<Parameters<typeof WallTile>[0]> = {}) {
  return renderWithApi(
    <WallTile device={QUARANTINED} live={false} onShowLive={() => {}} {...over} />,
  )
}

describe('WallTile — the way out of quarantine (field report 2026-08-26)', () => {
  test('offers "Return to queue" when the caller supplies a handler', () => {
    const onReleaseQuarantine = mock(() => {})
    renderTile({ onReleaseQuarantine, canReleaseQuarantine: true })
    const button = screen.getByRole('button', { name: /return to queue/i })
    fireEvent.click(button)
    expect(onReleaseQuarantine).toHaveBeenCalledTimes(1)
  })

  test('a non-admin sees the button disabled with the reason, never a missing control', () => {
    renderTile({ onReleaseQuarantine: () => {}, canReleaseQuarantine: false })
    const button = screen.getByRole('button', { name: /return to queue/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toMatch(/only an admin/i)
  })

  /**
   * The tile's own click toggles selection or navigates to the device. A
   * click on the release button must do neither — otherwise releasing a
   * device from the Wall would silently also select it, or navigate away
   * from the very grid the operator is working through.
   */
  test('clicking the button does not also toggle the tile selection', () => {
    const onToggleSelect = mock(() => {})
    const onReleaseQuarantine = mock(() => {})
    renderTile({ onReleaseQuarantine, canReleaseQuarantine: true, onToggleSelect })
    fireEvent.click(screen.getByRole('button', { name: /return to queue/i }))
    expect(onReleaseQuarantine).toHaveBeenCalledTimes(1)
    expect(onToggleSelect).not.toHaveBeenCalled()
  })

  test('with no handler the tile is exactly what it was before — reason only, no control', () => {
    renderTile()
    expect(screen.getByText(/temperature reached 45.6°C/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /return to queue/i })).toBeNull()
  })

  test('names the current temperature beside the one it was pulled at', () => {
    renderTile()
    expect(screen.getByText(/temperature reached 45.6°C — now 31.8°C/i)).toBeTruthy()
  })
})
