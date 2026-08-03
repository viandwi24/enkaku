import { describe, expect, test } from 'bun:test'
import { createDeviceMessageReader, type DeviceMessage } from './device-messages'

function clipboardBytes(text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const buf = new Uint8Array(5 + body.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, 0)
  dv.setUint32(1, body.length, false)
  buf.set(body, 5)
  return buf
}

function ackClipboardBytes(sequence: bigint): Uint8Array {
  const buf = new Uint8Array(9)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, 1)
  dv.setBigUint64(1, sequence, false)
  return buf
}

function uhidOutputBytes(id: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(5 + data.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, 2)
  dv.setUint16(1, id, false)
  dv.setUint16(3, data.length, false)
  buf.set(data, 5)
  return buf
}

function collect(): { messages: DeviceMessage[]; errors: Error[]; push: (chunk: Uint8Array) => void } {
  const messages: DeviceMessage[] = []
  const errors: Error[] = []
  const push = createDeviceMessageReader(
    (m) => messages.push(m),
    (e) => errors.push(e),
  )
  return { messages, errors, push }
}

describe('createDeviceMessageReader (plan 38 §3.2, §3.3) — all three types', () => {
  test('a CLIPBOARD message in one push decodes the text', () => {
    const { messages, push } = collect()
    push(clipboardBytes('hello clipboard'))
    expect(messages).toEqual([{ type: 'clipboard', text: 'hello clipboard' }])
  })

  test('an empty CLIPBOARD message (len 0) decodes to an empty string, not nothing', () => {
    const { messages, push } = collect()
    push(clipboardBytes(''))
    expect(messages).toEqual([{ type: 'clipboard', text: '' }])
  })

  test('a multi-byte UTF-8 CLIPBOARD payload round-trips (byte length, not char length)', () => {
    const { messages, push } = collect()
    push(clipboardBytes('héllo 世界'))
    expect(messages).toEqual([{ type: 'clipboard', text: 'héllo 世界' }])
  })

  test('an ACK_CLIPBOARD message decodes the u64BE sequence', () => {
    const { messages, push } = collect()
    push(ackClipboardBytes(0x1122334455667788n))
    expect(messages).toEqual([{ type: 'ackClipboard', sequence: 0x1122334455667788n }])
  })

  test('a UHID_OUTPUT message decodes id and data', () => {
    const { messages, push } = collect()
    const data = new Uint8Array([9, 8, 7])
    push(uhidOutputBytes(42, data))
    expect(messages).toHaveLength(1)
    const m = messages[0]
    if (m?.type !== 'uhidOutput') throw new Error('expected uhidOutput')
    expect(m.id).toBe(42)
    expect([...m.data]).toEqual([9, 8, 7])
  })

  test('several messages back to back in one chunk are all parsed, in order', () => {
    const { messages, push } = collect()
    const a = clipboardBytes('one')
    const b = ackClipboardBytes(5n)
    const c = uhidOutputBytes(1, new Uint8Array([1]))
    const merged = new Uint8Array(a.length + b.length + c.length)
    merged.set(a, 0)
    merged.set(b, a.length)
    merged.set(c, a.length + b.length)
    push(merged)
    expect(messages.map((m) => m.type)).toEqual(['clipboard', 'ackClipboard', 'uhidOutput'])
  })
})

describe('createDeviceMessageReader — a message split across TCP chunks (plan 38 §3.3, acceptance #4)', () => {
  test('a CLIPBOARD message split byte-by-byte still decodes correctly', () => {
    const { messages, push } = collect()
    const bytes = clipboardBytes('split across many tiny chunks')
    for (const b of bytes) push(new Uint8Array([b]))
    expect(messages).toEqual([{ type: 'clipboard', text: 'split across many tiny chunks' }])
  })

  test('a CLIPBOARD message split right in the middle of the length prefix', () => {
    const { messages, push } = collect()
    const bytes = clipboardBytes('half a length prefix')
    push(bytes.subarray(0, 3)) // type byte + 2 of the 4 length bytes
    push(bytes.subarray(3))
    expect(messages).toEqual([{ type: 'clipboard', text: 'half a length prefix' }])
  })

  test('a CLIPBOARD message split right in the middle of the text body', () => {
    const { messages, push } = collect()
    const bytes = clipboardBytes('body split in half')
    const mid = Math.floor(bytes.length / 2)
    push(bytes.subarray(0, mid))
    push(bytes.subarray(mid))
    expect(messages).toEqual([{ type: 'clipboard', text: 'body split in half' }])
  })

  test('an ACK_CLIPBOARD message split across the sequence field', () => {
    const { messages, push } = collect()
    const bytes = ackClipboardBytes(99n)
    push(bytes.subarray(0, 4))
    push(bytes.subarray(4))
    expect(messages).toEqual([{ type: 'ackClipboard', sequence: 99n }])
  })

  test('a truncated tail (message started, never completes) emits nothing and waits — no error', () => {
    const { messages, errors, push } = collect()
    const bytes = clipboardBytes('never finishes')
    push(bytes.subarray(0, bytes.length - 3)) // withhold the last few bytes
    expect(messages).toEqual([])
    expect(errors).toEqual([])
  })

  test('a message arriving right after its truncated prefix completes normally', () => {
    const { messages, push } = collect()
    const first = clipboardBytes('first')
    const second = clipboardBytes('second')
    push(first.subarray(0, first.length - 2))
    push(first.subarray(first.length - 2))
    push(second)
    expect(messages).toEqual([
      { type: 'clipboard', text: 'first' },
      { type: 'clipboard', text: 'second' },
    ])
  })
})

describe('createDeviceMessageReader — unknown type (plan 38 §3.3, acceptance #4)', () => {
  test('an unknown type calls onError exactly once and does not throw', () => {
    const { errors, push } = collect()
    expect(() => push(new Uint8Array([200, 1, 2, 3]))).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  test('after an unknown type, the reader stops parsing rather than desynchronising — a well-formed message pushed afterwards is never emitted', () => {
    const { messages, errors, push } = collect()
    push(new Uint8Array([200, 1, 2, 3]))
    push(clipboardBytes('this must not appear'))
    expect(errors).toHaveLength(1)
    expect(messages).toEqual([])
  })

  test('a well-formed message BEFORE the unknown type is still delivered', () => {
    const { messages, errors, push } = collect()
    const good = clipboardBytes('delivered before the desync')
    const merged = new Uint8Array(good.length + 4)
    merged.set(good, 0)
    merged.set([200, 1, 2, 3], good.length)
    push(merged)
    expect(messages).toEqual([{ type: 'clipboard', text: 'delivered before the desync' }])
    expect(errors).toHaveLength(1)
  })

  test('onError fires only once even if more unknown-typed bytes keep arriving', () => {
    const { errors, push } = collect()
    push(new Uint8Array([201]))
    push(new Uint8Array([202, 1, 1]))
    expect(errors).toHaveLength(1)
  })
})
