import { describe, expect, test } from 'bun:test'
import { ShellFrameParser } from './shell-frames'

const ID_STDOUT = 1
const ID_STDERR = 2
const ID_EXIT = 3

/** Builds one `[id][len:u32le][payload]` packet, mirroring `shell,v2,raw`'s wire format. */
function frame(id: number, payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  const out = new Uint8Array(5 + body.length)
  out[0] = id
  new DataView(out.buffer).setUint32(1, body.length, true)
  out.set(body, 5)
  return out
}

function exitPacket(code: number): Uint8Array {
  return frame(ID_EXIT, new Uint8Array([code & 0xff]))
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

describe('ShellFrameParser', () => {
  test('a whole packet in one push', () => {
    const p = new ShellFrameParser()
    p.push(frame(ID_STDOUT, 'hello\n'))
    expect(p.result()).toEqual({ stdout: 'hello\n', stderr: '', exitCode: null })
  })

  test('a packet split across two push calls — split inside the header', () => {
    const p = new ShellFrameParser()
    const whole = frame(ID_STDOUT, 'hello-stdout\n')
    p.push(whole.subarray(0, 3)) // id + 2 of the 4 length bytes
    p.push(whole.subarray(3))
    expect(p.result()).toEqual({ stdout: 'hello-stdout\n', stderr: '', exitCode: null })
  })

  test('a packet split across two push calls — split inside the payload', () => {
    const p = new ShellFrameParser()
    const whole = frame(ID_STDOUT, 'hello-stdout\n')
    p.push(whole.subarray(0, 8)) // full header + a few payload bytes
    p.push(whole.subarray(8))
    expect(p.result()).toEqual({ stdout: 'hello-stdout\n', stderr: '', exitCode: null })
  })

  test('one chunk holding several whole packets', () => {
    const p = new ShellFrameParser()
    const chunk = concatAll([frame(ID_STDOUT, 'hello-stdout\n'), frame(ID_STDERR, 'oops-stderr\n'), exitPacket(7)])
    p.push(chunk)
    expect(p.result()).toEqual({ stdout: 'hello-stdout\n', stderr: 'oops-stderr\n', exitCode: 7 })
  })

  test('interleaved stdout and stderr packets accumulate independently, in order', () => {
    const p = new ShellFrameParser()
    p.push(frame(ID_STDOUT, 'out-1 '))
    p.push(frame(ID_STDERR, 'err-1 '))
    p.push(frame(ID_STDOUT, 'out-2'))
    p.push(frame(ID_STDERR, 'err-2'))
    expect(p.result()).toEqual({ stdout: 'out-1 out-2', stderr: 'err-1 err-2', exitCode: null })
  })

  test('a missing exit packet reports exitCode: null, never a fabricated 0', () => {
    const p = new ShellFrameParser()
    p.push(frame(ID_STDOUT, 'no exit follows\n'))
    expect(p.result()).toEqual({ stdout: 'no exit follows\n', stderr: '', exitCode: null })
  })

  test('a truncated trailing header stays buffered rather than corrupting or throwing', () => {
    const p = new ShellFrameParser()
    p.push(frame(ID_STDOUT, 'complete\n'))
    // 3 bytes of a 5-byte header — the socket ends here in this scenario, so
    // these bytes never complete. The parser must not throw and must not
    // treat the partial header as if it were a real packet.
    p.push(new Uint8Array([ID_EXIT, 0x01, 0x00]))
    expect(p.result()).toEqual({ stdout: 'complete\n', stderr: '', exitCode: null })
  })

  test('the exit payload is exactly one byte holding the code', () => {
    const p = new ShellFrameParser()
    p.push(exitPacket(255))
    expect(p.result().exitCode).toBe(255)
  })

  test('a zero-length payload packet (empty stdout write) is a no-op, not a corrupting one', () => {
    const p = new ShellFrameParser()
    p.push(frame(ID_STDOUT, ''))
    p.push(frame(ID_STDOUT, 'after-empty'))
    expect(p.result()).toEqual({ stdout: 'after-empty', stderr: '', exitCode: null })
  })

  test('push() can be called many times with single bytes and still parses correctly', () => {
    const p = new ShellFrameParser()
    const chunk = concatAll([frame(ID_STDOUT, 'byte-by-byte\n'), exitPacket(3)])
    for (const b of chunk) p.push(new Uint8Array([b]))
    expect(p.result()).toEqual({ stdout: 'byte-by-byte\n', stderr: '', exitCode: 3 })
  })
})
