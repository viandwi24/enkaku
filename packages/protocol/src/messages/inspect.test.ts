import { describe, expect, test } from 'bun:test'
import {
  InspectAttachMessage,
  InspectDetachMessage,
  InspectDumpMessage,
  InspectFindMessage,
  InspectMatchMessage,
  InspectStatusMessage,
  InspectTreeMessage,
} from './inspect'

const leaf = {
  resourceId: '',
  text: '',
  desc: '',
  className: 'android.widget.TextView',
  packageName: 'com.example',
  bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  clickable: false,
  enabled: true,
  focused: false,
  index: 0,
  children: [] as unknown[],
}

describe('inspect.* messages (plan 56 §4.1)', () => {
  test('inspect.attach parses with just a deviceId', () => {
    expect(() => InspectAttachMessage.parse({ type: 'inspect.attach', id: 'r1', payload: { deviceId: 'dev-1' } })).not.toThrow()
  })

  test('inspect.detach carries no id (fire-and-forget)', () => {
    expect(() => InspectDetachMessage.parse({ type: 'inspect.detach', payload: { deviceId: 'dev-1' } })).not.toThrow()
  })

  test('inspect.dump requires a requestId in 0..255', () => {
    expect(() =>
      InspectDumpMessage.parse({ type: 'inspect.dump', id: 'r1', payload: { deviceId: 'dev-1', requestId: 3, screenshot: true } }),
    ).not.toThrow()
    expect(() =>
      InspectDumpMessage.parse({ type: 'inspect.dump', id: 'r1', payload: { deviceId: 'dev-1', requestId: 999, screenshot: true } }),
    ).toThrow()
  })

  test('inspect.find carries a Selector, exactly one key', () => {
    expect(() =>
      InspectFindMessage.parse({
        type: 'inspect.find',
        id: 'r1',
        payload: { deviceId: 'dev-1', requestId: 1, selector: { id: 'feed_action' } },
      }),
    ).not.toThrow()
    expect(() =>
      InspectFindMessage.parse({
        type: 'inspect.find',
        id: 'r1',
        payload: { deviceId: 'dev-1', requestId: 1, selector: { id: 'x', text: 'y' } },
      }),
    ).toThrow()
  })

  test('inspect.status requires a reason to be readable, but does not force one when ready', () => {
    expect(() =>
      InspectStatusMessage.parse({
        type: 'inspect.status',
        payload: { deviceId: 'dev-1', state: 'unavailable', engineId: '', capabilities: [], reason: 'no session' },
      }),
    ).not.toThrow()
    expect(() =>
      InspectStatusMessage.parse({
        type: 'inspect.status',
        payload: { deviceId: 'dev-1', state: 'ready', engineId: 'ui-server', capabilities: ['dump', 'find'] },
      }),
    ).not.toThrow()
  })

  test('inspect.tree round-trips a UiNode tree with frame size and timing', () => {
    const parsed = InspectTreeMessage.parse({
      type: 'inspect.tree',
      id: 'r1',
      payload: {
        deviceId: 'dev-1',
        requestId: 7,
        root: { ...leaf, children: [leaf] },
        frameSize: { width: 1080, height: 2400 },
        at: 1_700_000_000,
        tookMs: 82,
        snapshot: true,
      },
    })
    expect(parsed.payload.root.children).toHaveLength(1)
  })

  test('inspect.match allows a null node (not found)', () => {
    expect(() =>
      InspectMatchMessage.parse({ type: 'inspect.match', id: 'r1', payload: { deviceId: 'dev-1', requestId: 1, node: null, tookMs: 12 } }),
    ).not.toThrow()
  })
})
