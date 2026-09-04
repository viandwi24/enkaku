import { describe, expect, test } from 'bun:test'
import { StreamMetaMessage, StreamStartedMessage } from './stream'
import * as protocol from '../index'

/** Plan 206 §4.5: the encoder-split additions to `stream.started`/`stream.meta`, and the deletion of the phase-progress message. */
describe('StreamStartedMessage.payload.substitute (plan 206 §3.4, §4.5)', () => {
  function base(overrides: Record<string, unknown> = {}) {
    return {
      type: 'stream.started' as const,
      id: 'req-1',
      payload: {
        deviceId: 'dev-1',
        streamId: 0,
        codec: 'h264' as const,
        width: 480,
        height: 1024,
        quality: 'wall' as const,
        ...overrides,
      },
    }
  }

  test('accepts substitute: wall', () => {
    const msg = base({ quality: 'wall', substitute: 'wall' })
    expect(StreamStartedMessage.parse(msg).payload.substitute).toBe('wall')
  })

  test('substitute is optional — absent for an ordinary wall or control attach', () => {
    expect(StreamStartedMessage.parse(base()).payload.substitute).toBeUndefined()
  })

  test('rejects substitute: control — the substitute is only ever the wall entry', () => {
    expect(() => StreamStartedMessage.parse(base({ substitute: 'control' }))).toThrow()
  })
})

describe('StreamMetaMessage.payload.quality (plan 206 §3.4, §4.5)', () => {
  test('accepts a quality — the encoder-switch announcement', () => {
    const msg = { type: 'stream.meta' as const, payload: { streamId: 0, width: 1600, height: 720, quality: 'control' as const } }
    expect(StreamMetaMessage.parse(msg).payload.quality).toBe('control')
  })

  test('quality and detail are both optional — the ordinary rotation/resize case', () => {
    const msg = { type: 'stream.meta' as const, payload: { streamId: 0, width: 480, height: 1024 } }
    const parsed = StreamMetaMessage.parse(msg)
    expect(parsed.payload.quality).toBeUndefined()
    expect(parsed.payload.detail).toBeUndefined()
  })

  test('accepts a detail alongside quality: wall — the control build failed after substitute was reported', () => {
    const msg = { type: 'stream.meta' as const, payload: { streamId: 0, width: 480, height: 1024, quality: 'wall' as const, detail: 'E_SCRCPY_UNAVAILABLE' } }
    expect(StreamMetaMessage.parse(msg).payload.detail).toBe('E_SCRCPY_UNAVAILABLE')
  })
})

describe('the old phase-progress message is deleted (plan 206 §10)', () => {
  // Spelled out via string concatenation rather than as literal identifiers,
  // so this test proving they are GONE does not itself become a live
  // reference to them (plan 206 §10's own removal grep).
  const deletedMessageName = 'Session' + 'Progress' + 'Message'
  const deletedMessageType = 'session' + '.' + 'progress'

  test('is not exported from @enkaku/protocol', () => {
    expect((protocol as Record<string, unknown>)[deletedMessageName]).toBeUndefined()
  })

  test('its message type is not a member of ServerMessageSchema', () => {
    expect(protocol.SERVER_MESSAGE_TYPES).not.toContain(deletedMessageType)
  })
})
