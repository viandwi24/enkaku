import { describe, expect, test } from 'bun:test'
import { ClipboardChangedMessage, ClipboardSetMessage } from './clipboard'
import { ServerMessageSchema } from '../index'

describe('clipboard.changed (plan 209 §3.2 D10, §5 step 209.3)', () => {
  test('clipboard.changed parses', () => {
    const result = ClipboardChangedMessage.safeParse({ type: 'clipboard.changed', payload: { deviceId: 'dev-1', text: 'copied text' } })
    expect(result.success).toBe(true)
  })

  test('ServerMessageSchema accepts clipboard.changed', () => {
    const result = ServerMessageSchema.safeParse({ type: 'clipboard.changed', payload: { deviceId: 'dev-1', text: 'x' } })
    expect(result.success).toBe(true)
  })

  test('clipboard.set still defaults paste to false', () => {
    const result = ClipboardSetMessage.safeParse({ type: 'clipboard.set', id: 'req-1', payload: { deviceId: 'dev-1', text: 'hi' } })
    expect(result.success).toBe(true)
    expect(result.success && result.data.payload.paste).toBe(false)
  })
})
