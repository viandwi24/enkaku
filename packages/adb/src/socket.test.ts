import { describe, expect, test } from 'bun:test'
import { AdbError, type AdbErrorCode } from './errors'
import { AdbSocket } from './socket'

async function expectAdbError(p: Promise<unknown>, code: AdbErrorCode): Promise<void> {
  try {
    await p
    throw new Error(`expected rejection with ${code}, but it resolved`)
  } catch (err) {
    expect(err).toBeInstanceOf(AdbError)
    expect((err as AdbError).code).toBe(code)
  }
}

describe('AdbSocket against a fake adb server (Bun.listen)', () => {
  test('accept-then-silence rejects E_ADB_HANDSHAKE_TIMEOUT instead of hanging', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data() {}, // accepted, but never answers
        close() {},
        error() {},
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port)
      socket.send('host:version')
      const start = Date.now()
      await expectAdbError(socket.readStatus({ timeoutMs: 150 }), 'E_ADB_HANDSHAKE_TIMEOUT')
      expect(Date.now() - start).toBeLessThan(1_000)
    } finally {
      listener.stop(true)
    }
  })

  test('readStatus/readBlock with no timeoutMs do not time out on their own — a long-lived stream (e.g. DeviceTracker.track-devices) can stay silent indefinitely between events', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data() {}, // never answers, on purpose
        close() {},
        error() {},
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port)
      socket.send('host:track-devices')
      let settled = false
      socket
        .readStatus()
        .catch(() => {}) // the eventual outcome (once we tear the listener down below) is not the point
        .finally(() => {
          settled = true
        })
      // Long enough to prove no implicit default fired (DEFAULT_HANDSHAKE_TIMEOUT_MS is 3s).
      await new Promise((r) => setTimeout(r, 300))
      expect(settled).toBe(false)
    } finally {
      listener.stop(true)
    }
  })

  test('a connection that never establishes rejects E_ADB_CONNECT_TIMEOUT instead of hanging', async () => {
    // 240.0.0.0/4 is reserved ("future use") and never routable — whether the
    // local OS refuses it immediately or the connect genuinely stalls, both
    // paths in AdbSocket.connect converge on the same coded error, so this
    // exercises "does not hang" either way.
    const start = Date.now()
    await expectAdbError(AdbSocket.connect('240.0.0.1', 15037, { connectTimeoutMs: 200 }), 'E_ADB_CONNECT_TIMEOUT')
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test('OKAY then an endless byte stream rejects E_ADB_OUTPUT_LIMIT', async () => {
    let floodTimer: ReturnType<typeof setInterval> | null = null
    let armTimer: ReturnType<typeof setTimeout> | null = null
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(s) {
          s.write(Buffer.from('OKAY'))
          // Give the client time to consume the 4-byte status before the
          // flood starts, so this test exercises readUntilClose() specifically
          // rather than racing the handshake read.
          armTimer = setTimeout(() => {
            const chunk = new Uint8Array(4096).fill(1)
            floodTimer = setInterval(() => {
              s.write(chunk)
            }, 2)
          }, 30)
        },
        close() {},
        error() {},
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port, { maxBytes: 2048 })
      socket.send('host:version')
      await socket.readStatus()
      await expectAdbError(socket.readUntilClose(), 'E_ADB_OUTPUT_LIMIT')
    } finally {
      if (armTimer) clearTimeout(armTimer)
      if (floodTimer) clearInterval(floodTimer)
      listener.stop(true)
    }
  })

  test('streamFrom (plan 24 §4.1) delivers chunks incrementally, and memory does not grow with total bytes', async () => {
    let sendTimer: ReturnType<typeof setInterval> | null = null
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(s, data) {
          const text = new TextDecoder().decode(data)
          if (text.includes('host:transport')) {
            s.write(Buffer.from('OKAY'))
          } else if (text.includes('shell:')) {
            s.write(Buffer.from('OKAY'))
            let n = 0
            sendTimer = setInterval(() => {
              n++
              s.write(Buffer.from(`line ${n}\n`))
              if (n >= 5 && sendTimer) {
                clearInterval(sendTimer)
                sendTimer = null
              }
            }, 5)
          }
        },
        close() {},
        error() {},
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port, { maxBytes: 1024 })
      socket.send('host:transport:emulator-5554')
      await socket.readStatus()
      socket.send('shell:logcat')
      await socket.readStatus()

      const received: string[] = []
      let ended = false
      let endErr: unknown
      await new Promise<void>((resolve) => {
        socket.streamFrom(
          (chunk) => {
            received.push(new TextDecoder().decode(chunk))
            // "memory does not grow with total bytes": each delivered chunk
            // is small — nothing close to the whole transfer accumulated.
            expect(chunk.length).toBeLessThan(64)
            if (received.join('').includes('line 5')) resolve()
          },
          (err) => {
            ended = true
            endErr = err
          },
        )
      })
      expect(received.join('')).toContain('line 1')
      expect(received.join('')).toContain('line 5')
      expect(ended).toBe(false)
      expect(endErr).toBeUndefined()
      socket.close(true)
    } finally {
      if (sendTimer) clearInterval(sendTimer)
      listener.stop(true)
    }
  })

  test('setIdleTimeout (plan 24 §3.3, §4.1) ends the stream with E_ADB_STREAM_IDLE when the peer goes quiet', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(s, data) {
          const text = new TextDecoder().decode(data)
          if (text.includes('host:transport')) {
            s.write(Buffer.from('OKAY'))
          } else if (text.includes('shell:')) {
            s.write(Buffer.from('OKAY'))
            s.write(Buffer.from('one line\n')) // then goes quiet forever
          }
        },
        close() {},
        error() {},
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port)
      socket.send('host:transport:emulator-5554')
      await socket.readStatus()
      socket.send('shell:logcat')
      await socket.readStatus()
      // Bun's native socket.timeout() has a coarse floor (empirically ~4s
      // for any value below that on this Bun build) — this only asserts it
      // fires well short of a hang, not the exact second requested.
      socket.setIdleTimeout(1)

      const start = Date.now()
      const endReason = await new Promise<unknown>((resolve) => {
        socket.streamFrom(
          () => {},
          (err) => resolve(err),
        )
      })
      expect(Date.now() - start).toBeLessThan(8_000)
      expect(endReason).toBeInstanceOf(AdbError)
      expect((endReason as AdbError).code).toBe('E_ADB_STREAM_IDLE')
    } finally {
      listener.stop(true)
    }
  }, 10_000)

  test('a normal exchange completes successfully', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(s, data) {
          const text = new TextDecoder().decode(data)
          if (text.includes('host:transport')) {
            s.write(Buffer.from('OKAY'))
          } else if (text.includes('shell:')) {
            s.write(Buffer.from('OKAY'))
            s.write(Buffer.from('hello from the device\n'))
            s.end()
          }
        },
        close() {},
        error() {},
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port)
      socket.send('host:transport:emulator-5554')
      await socket.readStatus()
      socket.send('shell:echo hi')
      await socket.readStatus()
      const raw = await socket.readUntilClose()
      expect(new TextDecoder().decode(raw)).toBe('hello from the device\n')
      socket.close()
    } finally {
      listener.stop(true)
    }
  })

  /**
   * Regression: `write()` used to discard Bun's return value, which is the
   * number of bytes it ACTUALLY accepted. Anything the kernel buffer could not
   * take was silently dropped, so a small payload worked and a large one
   * corrupted the stream — a real 30 MB APK push failed with the adb server's
   * own `FAIL invalid data message`, while a 150 KB probe passed. The write
   * must deliver every byte, parking on `drain` when the buffer is full.
   */
  test('write() delivers every byte of a large payload, honouring backpressure', async () => {
    const SIZE = 8 * 1024 * 1024
    let received = 0
    let handshakeSeen = false
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        // The OKAY is sent in response to the handshake request, NOT on open:
        // replying on open lets `readStatus()` resolve before the request has
        // even reached the server, so the handshake's own bytes would land
        // after the counter was zeroed and inflate the total.
        data(s, data) {
          if (!handshakeSeen) {
            handshakeSeen = true
            s.write(new TextEncoder().encode('OKAY'))
            return
          }
          received += data.length
        },
      },
    })
    try {
      const socket = await AdbSocket.connect('127.0.0.1', listener.port)
      socket.send('host:transport:probe')
      await socket.readStatus()

      const payload = new Uint8Array(SIZE)
      for (let i = 0; i < SIZE; i++) payload[i] = i & 0xff
      await socket.write(payload)

      // The write resolved, so every byte was handed to the kernel. Give the
      // loopback peer a moment to drain what is still in flight.
      const deadline = Date.now() + 5000
      while (received < SIZE && Date.now() < deadline) await Bun.sleep(10)
      expect(received).toBe(SIZE)
      socket.close()
    } finally {
      listener.stop(true)
    }
  })
})
