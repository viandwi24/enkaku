import { describe, expect, test } from 'bun:test'
import type { UiChangedEvent, UiNode } from '@enkaku/protocol'
import type { GuestAgentClient } from '../../network/guest-agent/client'
import { UiTreeInspector, type UiTreeWatchHandle } from './inspector'

function node(over: Partial<UiNode> = {}): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.example',
    bounds: { left: 10, top: 10, right: 100, bottom: 60 },
    clickable: true,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...over,
  }
}

function fakeClient(over: Partial<GuestAgentClient> = {}): GuestAgentClient {
  return {
    uiDump: async () => ({ root: node({ className: 'hierarchy' }), widthPx: 1080, heightPx: 2400, nodeCount: 1, truncated: false, tookMs: 5 }),
    uiFind: async () => ({ node: node(), matches: 1, tookMs: 5 }),
    uiStatus: async () => ({ enabled: true, connected: true, watching: false, lastDumpAgoMs: null, lastDumpNodes: null, lastError: null }),
    ...over,
  } as unknown as GuestAgentClient
}

describe('UiTreeInspector (plan 222 §4.2)', () => {
  test('dump returns the agent\'s root unchanged and records lastDump', async () => {
    const root = node({ className: 'hierarchy' })
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient({ uiDump: async () => ({ root, widthPx: 1, heightPx: 1, nodeCount: 1, truncated: false, tookMs: 1 }) })),
    })
    const result = await inspector.dump()
    expect(result).toBe(root)
    expect(inspector.lastDump()?.root).toBe(root)
  })

  test('a truncated dump is logged as truncated and still returned', async () => {
    const root = node({ className: 'hierarchy' })
    const logs: Array<{ level: string; msg: string }> = []
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient({ uiDump: async () => ({ root, widthPx: 1, heightPx: 1, nodeCount: 50_000, truncated: true, tookMs: 1 }) })),
      onLog: (level, msg) => logs.push({ level, msg }),
    })
    const result = await inspector.dump()
    expect(result).toBe(root)
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('truncated'))).toBe(true)
  })

  test('find returns the first match even when matches is above one', async () => {
    const n = node({ resourceId: 'x' })
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient({ uiFind: async () => ({ node: n, matches: 4, tookMs: 1 }) })),
    })
    expect(await inspector.find({ id: 'x' })).toBe(n)
  })

  test('findDetailed reports ambiguous when matches is above one', async () => {
    const n = node({ resourceId: 'x' })
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient({ uiFind: async () => ({ node: n, matches: 4, tookMs: 1 }) })),
    })
    expect(await inspector.findDetailed({ id: 'x' })).toEqual({ ok: false, reason: 'ambiguous', matches: 4 })
  })

  test('findDetailed reports rejected-oversized before ambiguous for a full-screen node', async () => {
    const fullScreen = node({ bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } })
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient({ uiFind: async () => ({ node: fullScreen, matches: 3, tookMs: 1 }) })),
      screenSize: async () => ({ width: 1080, height: 2400 }),
    })
    expect(await inspector.findDetailed({ id: 'x' })).toEqual({ ok: false, reason: 'rejected-oversized', matches: 3 })
  })

  test('find and findDetailed answer a point selector without touching the agent', async () => {
    let touched = false
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: async (fn) => {
        touched = true
        return fn(fakeClient())
      },
    })
    expect(await inspector.find({ point: { x: 5, y: 5 } })).not.toBeNull()
    expect(await inspector.findDetailed({ point: { x: 5, y: 5 } })).toEqual({ ok: true, node: expect.anything() })
    expect(touched).toBe(false)
  })

  test('screenshot goes through the transport, never the agent', async () => {
    let execOutCalled = false
    let agentTouched = false
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: {
        execOut: async (cmd: string) => {
          execOutCalled = true
          expect(cmd).toBe('screencap -p')
          return new Uint8Array([1, 2, 3])
        },
      } as never,
      withClient: async (fn) => {
        agentTouched = true
        return fn(fakeClient())
      },
    })
    const png = await inspector.screenshot()
    expect(execOutCalled).toBe(true)
    expect(agentTouched).toBe(false)
    expect(png).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('two watch subscribers share one agent connection and the last close tears it down', async () => {
    let opens = 0
    let closes = 0
    // A holder object rather than a bare `let` — TS narrows a plain
    // reassign-only-inside-a-closure variable to `never` at the later
    // read (a known control-flow quirk), which a property access avoids.
    const captured: { onEvent: ((e: UiChangedEvent) => void) | null } = { onEvent: null }
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient()),
      openWatch: async (hooks) => {
        opens += 1
        captured.onEvent = hooks.onEvent
        const handle: UiTreeWatchHandle = { close: async () => { closes += 1 } }
        return handle
      },
    })
    let calls1 = 0
    let calls2 = 0
    const w1 = await inspector.watch(() => calls1++)
    const w2 = await inspector.watch(() => calls2++)
    expect(opens).toBe(1)
    captured.onEvent?.({ event: 'ui.changed', seq: 1, at: 0, packageName: 'x', reason: 'content' })
    expect(calls1).toBe(1)
    expect(calls2).toBe(1)
    await w1.close()
    expect(closes).toBe(0)
    await w2.close()
    expect(closes).toBe(1)
  })

  test('an onClose from the agent wakes every subscriber', async () => {
    const captured: { onClose: ((reason: string) => void) | null } = { onClose: null }
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient()),
      openWatch: async (hooks) => {
        captured.onClose = hooks.onClose
        return { close: async () => {} }
      },
    })
    let calls = 0
    await inspector.watch(() => calls++)
    captured.onClose?.('closed')
    expect(calls).toBe(1)
  })

  test('watch throws when no openWatch was supplied', async () => {
    const inspector = new UiTreeInspector({
      deviceId: 'd1',
      transport: { execOut: async () => new Uint8Array() } as never,
      withClient: (fn) => fn(fakeClient()),
    })
    await expect(inspector.watch(() => {})).rejects.toThrow()
  })
})
