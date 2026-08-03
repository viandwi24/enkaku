import { describe, expect, test } from 'bun:test'
import { createClipboardControl } from './index'
import type { DeviceMessage } from './device-messages'
import { CONTROL_MSG } from '../version'

/** A fake control socket: `write` records bytes, `emit` simulates an inbound device message. */
function fakeDeps() {
  const written: Uint8Array[] = []
  const subscribers = new Set<(m: DeviceMessage) => void>()
  return {
    written,
    emit: (m: DeviceMessage) => {
      for (const cb of [...subscribers]) cb(m)
    },
    subscriberCount: () => subscribers.size,
    deps: {
      write: (bytes: Uint8Array) => written.push(bytes),
      onDeviceMessage: (cb: (m: DeviceMessage) => void) => {
        subscribers.add(cb)
        return () => subscribers.delete(cb)
      },
    },
  }
}

describe('createClipboardControl.getClipboard (plan 38 §4.3)', () => {
  test('resolves with the text carried by the next clipboard device message', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    const promise = control.getClipboard()
    expect(fake.written).toHaveLength(1)
    expect(fake.written[0]?.[0]).toBe(CONTROL_MSG.GET_CLIPBOARD)
    fake.emit({ type: 'clipboard', text: 'copied text' })
    await expect(promise).resolves.toBe('copied text')
  })

  test('rejects E_CLIPBOARD_TIMEOUT when no clipboard message ever arrives', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    await expect(control.getClipboard({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'E_CLIPBOARD_TIMEOUT' })
  })

  test('an unrelated ackClipboard message does not resolve a pending getClipboard', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    const promise = control.getClipboard({ timeoutMs: 50 })
    fake.emit({ type: 'ackClipboard', sequence: 1n })
    fake.emit({ type: 'clipboard', text: 'the real answer' })
    await expect(promise).resolves.toBe('the real answer')
  })

  test('unsubscribes after resolving — a later stray clipboard message is not observed by the finished call', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    await Promise.all([
      control.getClipboard().then((v) => expect(v).toBe('first')),
      (async () => {
        // give getClipboard's write a tick before emitting
        await Bun.sleep(0)
        fake.emit({ type: 'clipboard', text: 'first' })
      })(),
    ])
    expect(fake.subscriberCount()).toBe(0)
  })
})

describe('createClipboardControl.setClipboard (plan 38 §3.4, §4.3) — sequence matching', () => {
  test('resolves only once ACK_CLIPBOARD carries the SAME sequence that was sent', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    const promise = control.setClipboard('hello')
    const sent = fake.written[0]
    expect(sent).toBeDefined()
    const dv = new DataView(sent!.buffer, sent!.byteOffset, sent!.byteLength)
    expect(dv.getUint8(0)).toBe(CONTROL_MSG.SET_CLIPBOARD)
    const sentSeq = dv.getBigUint64(1, false)

    // A mismatched sequence must not resolve the call.
    fake.emit({ type: 'ackClipboard', sequence: sentSeq + 1n })
    let resolved = false
    void promise.then(() => {
      resolved = true
    })
    await Bun.sleep(10)
    expect(resolved).toBe(false)

    fake.emit({ type: 'ackClipboard', sequence: sentSeq })
    await expect(promise).resolves.toBeUndefined()
  })

  test('paste defaults to false and is set to 1 when opts.paste is true', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    const p1 = control.setClipboard('a')
    const first = fake.written[0]!
    fake.emit({ type: 'ackClipboard', sequence: new DataView(first.buffer, first.byteOffset).getBigUint64(1, false) })
    await p1
    expect(new DataView(first.buffer, first.byteOffset).getUint8(9)).toBe(0)

    const p2 = control.setClipboard('b', { paste: true })
    const second = fake.written[1]!
    fake.emit({ type: 'ackClipboard', sequence: new DataView(second.buffer, second.byteOffset).getBigUint64(1, false) })
    await p2
    expect(new DataView(second.buffer, second.byteOffset).getUint8(9)).toBe(1)
  })

  test('rejects E_CLIPBOARD_TIMEOUT if no matching ACK_CLIPBOARD arrives', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    await expect(control.setClipboard('x', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'E_CLIPBOARD_TIMEOUT' })
  })

  test('successive calls use increasing sequence numbers', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)
    const p1 = control.setClipboard('a')
    const seq1 = new DataView(fake.written[0]!.buffer, fake.written[0]!.byteOffset).getBigUint64(1, false)
    fake.emit({ type: 'ackClipboard', sequence: seq1 })
    await p1

    const p2 = control.setClipboard('b')
    const seq2 = new DataView(fake.written[1]!.buffer, fake.written[1]!.byteOffset).getBigUint64(1, false)
    expect(seq2).not.toBe(seq1)
    fake.emit({ type: 'ackClipboard', sequence: seq2 })
    await p2
  })
})

describe('createClipboardControl — single-flight queuing (plan 38 §4.3)', () => {
  test('a second concurrent call does not write to the socket until the first settles', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)

    const first = control.getClipboard()
    const second = control.getClipboard()
    // Only the FIRST call's request has been written so far.
    expect(fake.written).toHaveLength(1)

    fake.emit({ type: 'clipboard', text: 'one' })
    await first
    // Only after the first resolves does the second get to write.
    await Bun.sleep(0)
    expect(fake.written).toHaveLength(2)

    fake.emit({ type: 'clipboard', text: 'two' })
    await expect(second).resolves.toBe('two')
  })

  test('a call that times out still releases the queue for the next one', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)

    const first = control.getClipboard({ timeoutMs: 15 })
    const second = control.getClipboard()
    await expect(first).rejects.toMatchObject({ code: 'E_CLIPBOARD_TIMEOUT' })
    await Bun.sleep(0)
    expect(fake.written).toHaveLength(2)
    fake.emit({ type: 'clipboard', text: 'after timeout' })
    await expect(second).resolves.toBe('after timeout')
  })

  test('get and set queue behind each other too, in call order', async () => {
    const fake = fakeDeps()
    const control = createClipboardControl(fake.deps)

    const getPromise = control.getClipboard()
    const setPromise = control.setClipboard('queued')
    expect(fake.written).toHaveLength(1) // only the get has gone out

    fake.emit({ type: 'clipboard', text: 'first' })
    await getPromise
    await Bun.sleep(0)
    expect(fake.written).toHaveLength(2)

    const setBytes = fake.written[1]!
    const seq = new DataView(setBytes.buffer, setBytes.byteOffset).getBigUint64(1, false)
    fake.emit({ type: 'ackClipboard', sequence: seq })
    await setPromise
  })
})
