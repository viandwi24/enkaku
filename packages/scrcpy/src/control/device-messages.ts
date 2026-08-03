/**
 * Device→host messages on the scrcpy control socket (plan 38 §3.2, §3.3).
 *
 * The control socket was write-only until now: every existing control
 * message (taps, keys, UHID reports) is fire-and-forget, so nothing ever read
 * from it. `GET_CLIPBOARD` is the first message that gets an answer back, and
 * the device-message channel also carries `ACK_CLIPBOARD` and UHID output
 * reports — both of which future work will want. So this reader is written
 * generically, and clipboard is only its first consumer.
 *
 * Wire format (the pinned server version — `packages/scrcpy/src/version.ts` —
 * is the single source of these type numbers, spec §7.6):
 *
 *   [type u8][payload]
 *
 *   type 0  CLIPBOARD      [len u32BE][utf8 text]
 *   type 1  ACK_CLIPBOARD  [sequence u64BE]
 *   type 2  UHID_OUTPUT    [id u16BE][size u16BE][data]
 *
 * Modelled on `VideoDemuxer`'s chunk-accumulation discipline: `push()` bytes
 * straight from the socket, with no assumption about TCP chunk boundaries —
 * a message split across chunks is simply incomplete until enough bytes
 * arrive.
 */

const DEVICE_MSG_TYPE = { CLIPBOARD: 0, ACK_CLIPBOARD: 1, UHID_OUTPUT: 2 } as const

export type DeviceMessage =
  | { type: 'clipboard'; text: string }
  | { type: 'ackClipboard'; sequence: bigint }
  | { type: 'uhidOutput'; id: number; data: Uint8Array }

/**
 * Returns a `push(chunk)` function. `onMessage` fires once per complete
 * device message; `onError` fires AT MOST ONCE, when an unknown message type
 * is seen.
 *
 * An unknown type has no knowable length (there is no generic
 * length-prefixed envelope around the whole message, only per-type payload
 * shapes), so there is no safe way to skip it and keep reading — guessing
 * would silently desynchronise the stream and every message after it would
 * be garbage. So the reader logs once, via `onError`, and then stops parsing
 * for the rest of this socket's life. Critically, this must never throw or
 * close anything itself (plan 38 §8): input already works through this same
 * socket via `write()`, which this reader never touches.
 */
export function createDeviceMessageReader(
  onMessage: (m: DeviceMessage) => void,
  onError: (e: Error) => void,
): (chunk: Uint8Array) => void {
  let buf = new Uint8Array(0)
  let stopped = false

  function take(n: number): Uint8Array | null {
    if (buf.length < n) return null
    const head = buf.subarray(0, n)
    buf = buf.subarray(n)
    return head
  }

  function drain(): void {
    for (;;) {
      if (buf.length < 1) return
      const type = buf[0]

      if (type === DEVICE_MSG_TYPE.CLIPBOARD) {
        if (buf.length < 5) return // type + len not fully arrived yet
        const len = new DataView(buf.buffer, buf.byteOffset, 5).getUint32(1, false)
        if (buf.length < 5 + len) return // body not fully arrived yet
        take(1)
        const raw = take(4)
        if (!raw) return
        const body = take(len)
        if (!body) return
        onMessage({ type: 'clipboard', text: new TextDecoder().decode(body) })
        continue
      }

      if (type === DEVICE_MSG_TYPE.ACK_CLIPBOARD) {
        if (buf.length < 9) return
        take(1)
        const raw = take(8)
        if (!raw) return
        const sequence = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false)
        onMessage({ type: 'ackClipboard', sequence })
        continue
      }

      if (type === DEVICE_MSG_TYPE.UHID_OUTPUT) {
        if (buf.length < 5) return
        const header = new DataView(buf.buffer, buf.byteOffset, 5)
        const id = header.getUint16(1, false)
        const size = header.getUint16(3, false)
        if (buf.length < 5 + size) return
        take(5)
        const data = take(size)
        if (!data) return
        onMessage({ type: 'uhidOutput', id, data: new Uint8Array(data) })
        continue
      }

      // Unknown type, unknowable length: stop rather than desynchronise.
      if (!stopped) {
        stopped = true
        onError(
          new Error(
            `unknown scrcpy device message type ${type} — the device message reader has stopped parsing this ` +
              'socket to avoid silently misreading unrelated bytes as message boundaries',
          ),
        )
      }
      return
    }
  }

  return (chunk: Uint8Array) => {
    if (stopped) return
    const merged = new Uint8Array(buf.length + chunk.length)
    merged.set(buf, 0)
    merged.set(chunk, buf.length)
    buf = merged
    drain()
  }
}
