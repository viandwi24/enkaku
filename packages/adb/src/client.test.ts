import { describe, expect, test } from 'bun:test'
import { AdbClient } from './client'
import { AdbError, type AdbErrorCode } from './errors'

/**
 * A fake adb server good enough to drive AdbClient.exec end to end: it only
 * understands `host:transport:<serial>` (always OKAY) and whatever `shell:`
 * behaviour each test wires up via `onShell`.
 */
function fakeAdbServer(onShell: (socket: import('bun').Socket, cmd: string) => void) {
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s, data) {
        // Every request is length-prefixed (4 hex digits) before the
        // payload (plan 01 §4.2's framing), so a plain startsWith() would
        // miss it — search for the marker instead.
        const text = new TextDecoder().decode(data)
        if (text.includes('host:transport:')) {
          s.write(Buffer.from('OKAY'))
          return
        }
        const marker = 'shell:'
        const idx = text.indexOf(marker)
        if (idx !== -1) {
          onShell(s, text.slice(idx + marker.length))
        }
      },
      close() {},
      error() {},
    },
  })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function expectAdbError(p: Promise<unknown>, code: AdbErrorCode): Promise<void> {
  try {
    await p
    throw new Error(`expected rejection with ${code}, but it resolved`)
  } catch (err) {
    expect(err).toBeInstanceOf(AdbError)
    expect((err as AdbError).code).toBe(code)
  }
}

describe('AdbClient.exec against a fake adb server (Bun.listen) — this is the hazard packages/scrcpy/src/session.ts:90-98 documents', () => {
  test('a hung shell command rejects E_ADB_TIMEOUT, and the NEXT command on the same serial still runs — the slot was released', async () => {
    const listener = fakeAdbServer((s, cmd) => {
      if (cmd === 'hang') {
        s.write(Buffer.from('OKAY')) // answers the shell: status, then never another byte, never closes
      } else if (cmd === 'echo hi') {
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('ok\n'))
        s.end()
      }
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const hung = client.exec('serial-1', 'hang', { timeoutMs: 100 })
      await expectAdbError(hung, 'E_ADB_TIMEOUT')
      await flush()
      expect(client.pending('serial-1')).toBe(0)

      const next = await client.exec('serial-1', 'echo hi')
      expect(next).toBe('ok')
    } finally {
      listener.stop(true)
    }
  })

  test('an AbortSignal fired mid-flight terminates the socket and rejects E_ADB_ABORTED — the slot is released', async () => {
    const listener = fakeAdbServer((s, cmd) => {
      if (cmd === 'sleep 600') {
        s.write(Buffer.from('OKAY')) // then silence — the client aborts before anything else happens
      } else if (cmd === 'echo hi') {
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('ok\n'))
        s.end()
      }
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const controller = new AbortController()
      const p = client.exec('serial-2', 'sleep 600', { signal: controller.signal, timeoutMs: 5_000 })
      setTimeout(() => controller.abort(), 50)
      await expectAdbError(p, 'E_ADB_ABORTED')
      await flush()
      expect(client.pending('serial-2')).toBe(0)

      const next = await client.exec('serial-2', 'echo hi')
      expect(next).toBe('ok')
    } finally {
      listener.stop(true)
    }
  })

  test('output beyond maxOutputBytes rejects E_ADB_OUTPUT_LIMIT, and the next command on the same serial still runs', async () => {
    let floodTimer: ReturnType<typeof setInterval> | null = null
    const listener = fakeAdbServer((s, cmd) => {
      if (cmd === 'flood') {
        s.write(Buffer.from('OKAY'))
        const chunk = new Uint8Array(4096).fill(1)
        floodTimer = setInterval(() => s.write(chunk), 2)
      } else if (cmd === 'echo hi') {
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('ok\n'))
        s.end()
      }
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const flooded = client.exec('serial-3', 'flood', { maxOutputBytes: 2048 })
      await expectAdbError(flooded, 'E_ADB_OUTPUT_LIMIT')
      if (floodTimer) clearInterval(floodTimer)
      await flush()
      expect(client.pending('serial-3')).toBe(0)

      const next = await client.exec('serial-3', 'echo hi')
      expect(next).toBe('ok')
    } finally {
      if (floodTimer) clearInterval(floodTimer)
      listener.stop(true)
    }
  })

  test('a normal exchange is unaffected by any of this — same behaviour as before the plan', async () => {
    const listener = fakeAdbServer((s, cmd) => {
      if (cmd === 'echo hi') {
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('  ok  \n'))
        s.end()
      }
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const out = await client.exec('serial-4', 'echo hi', { profile: 'probe' })
      expect(out).toBe('ok') // exec() trims, matching pre-existing behaviour
    } finally {
      listener.stop(true)
    }
  })
})

/**
 * `execStream` (plan 24 §4.2) — the central rule of the plan: a stream must
 * NEVER go through `PerDeviceQueue`. `pending(serial)` staying 0 for a
 * stream's entire lifetime, while `exec()` on the same serial keeps
 * answering normally, is how that is proven rather than merely asserted.
 */
describe('AdbClient.execStream — the streaming lane, never PerDeviceQueue (plan 24)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  /** Understands `echo $$; exec <cmd>` in addition to a plain shell command. */
  function fakeStreamingServer(handlers: {
    onStream?: (s: import('bun').Socket, cmd: string) => void
    onShell?: (s: import('bun').Socket, cmd: string) => void
  }) {
    return Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(s, data) {
          const text = new TextDecoder().decode(data)
          if (text.includes('host:transport:')) {
            s.write(Buffer.from('OKAY'))
            return
          }
          const marker = 'shell:'
          const idx = text.indexOf(marker)
          if (idx === -1) return
          const cmd = text.slice(idx + marker.length)
          const streamMarker = 'echo $$; exec '
          if (cmd.startsWith(streamMarker) && handlers.onStream) {
            handlers.onStream(s, cmd.slice(streamMarker.length))
          } else if (handlers.onShell) {
            handlers.onShell(s, cmd)
          }
        },
        close() {},
        error() {},
      },
    })
  }

  test('a stream never touches PerDeviceQueue: pending(serial) stays 0 throughout, and exec() on the same serial is unaffected', async () => {
    let logTimer: ReturnType<typeof setInterval> | null = null
    const killedCmds: string[] = []
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat -v time') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('4242\n')) // the PID line
        let n = 0
        logTimer = setInterval(() => {
          n++
          s.write(Buffer.from(`log line ${n}\n`))
        }, 5)
      },
      onShell(s, cmd) {
        if (cmd === 'echo hi') {
          s.write(Buffer.from('OKAY'))
          s.write(Buffer.from('ok\n'))
          s.end()
        } else if (cmd.startsWith('kill ')) {
          killedCmds.push(cmd)
          s.write(Buffer.from('OKAY'))
          s.end()
        }
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const chunks: string[] = []
      const ended: Array<{ reason: string; err: unknown }> = []
      const handle = await client.execStream('serial-stream-1', 'logcat -v time', {
        onData: (c) => chunks.push(new TextDecoder().decode(c)),
        onEnd: (reason, err) => ended.push({ reason, err }),
        idleTimeoutMs: 30_000,
        absoluteTimeoutMs: 30_000,
      })

      // The central rule: starting and running a stream leaves the
      // per-device queue completely untouched.
      expect(client.pending('serial-stream-1')).toBe(0)

      // A normal exec() on the SAME serial keeps answering while the stream
      // is open — this is exactly what session.ts:90-98 documents as having
      // broken the last time a long-lived command went through the queue.
      const echoed = await client.exec('serial-stream-1', 'echo hi')
      expect(echoed).toBe('ok')
      expect(client.pending('serial-stream-1')).toBe(0)

      // Wait for a few log lines and the PID to resolve.
      while (chunks.join('').split('\n').filter(Boolean).length < 3) {
        await flush()
      }
      expect(handle.pid).toBe(4242)
      expect(chunks.join('')).toContain('log line 1')
      expect(client.pending('serial-stream-1')).toBe(0)

      await handle.stop()
      if (logTimer) clearInterval(logTimer)
      await flush()

      expect(ended).toHaveLength(1)
      expect(ended[0]?.reason).toBe('stopped')
      // The kill went through the NORMAL per-device queue (§4.2) — it is the
      // only adb call this whole test makes that does — and it settles
      // straight back to 0, same as any other one-shot command.
      expect(killedCmds).toEqual(['kill 4242'])
      expect(client.pending('serial-stream-1')).toBe(0)
    } finally {
      if (logTimer) clearInterval(logTimer)
      listener.stop(true)
    }
  })

  test('exceeding maxStreamsPerDevice rejects E_ADB_STREAM_LIMIT synchronously, without opening a second socket', async () => {
    let streamOpens = 0
    let logTimer: ReturnType<typeof setInterval> | null = null
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat') return
        streamOpens++
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('111\n'))
        logTimer = setInterval(() => s.write(Buffer.from('x\n')), 5)
      },
    })
    try {
      const client = new AdbClient({
        adbPath: 'unused',
        host: '127.0.0.1',
        port: listener.port,
        maxStreamsPerDevice: 1,
        maxStreams: 4,
      })
      const first = await client.execStream('serial-limit', 'logcat', {
        onData: () => {},
        onEnd: () => {},
        idleTimeoutMs: 30_000,
        absoluteTimeoutMs: 30_000,
      })
      await expectAdbError(
        client.execStream('serial-limit', 'logcat', { onData: () => {}, onEnd: () => {} }),
        'E_ADB_STREAM_LIMIT',
      )
      expect(streamOpens).toBe(1)
      await first.stop()
    } finally {
      if (logTimer) clearInterval(logTimer)
      listener.stop(true)
    }
  })

  test('exceeding the farm-wide maxStreams rejects E_ADB_STREAM_LIMIT even across different devices', async () => {
    let logTimer1: ReturnType<typeof setInterval> | null = null
    let logTimer2: ReturnType<typeof setInterval> | null = null
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('1\n'))
        const timer = setInterval(() => s.write(Buffer.from('x\n')), 5)
        if (!logTimer1) logTimer1 = timer
        else logTimer2 = timer
      },
    })
    try {
      const client = new AdbClient({
        adbPath: 'unused',
        host: '127.0.0.1',
        port: listener.port,
        maxStreamsPerDevice: 4,
        maxStreams: 1,
      })
      const first = await client.execStream('serial-a', 'logcat', { onData: () => {}, onEnd: () => {} })
      await expectAdbError(
        client.execStream('serial-b', 'logcat', { onData: () => {}, onEnd: () => {} }),
        'E_ADB_STREAM_LIMIT',
      )
      await first.stop()
    } finally {
      if (logTimer1) clearInterval(logTimer1)
      if (logTimer2) clearInterval(logTimer2)
      listener.stop(true)
    }
  })

  test('the byte cap ends the stream with reason "bytes"', async () => {
    let floodTimer: ReturnType<typeof setInterval> | null = null
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'flood') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('1\n'))
        const chunk = new Uint8Array(4096).fill(1)
        floodTimer = setInterval(() => s.write(chunk), 2)
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const ended = await new Promise<{ reason: string }>((resolve) => {
        void client.execStream('serial-bytes', 'flood', {
          onData: () => {},
          onEnd: (reason) => resolve({ reason }),
          maxBytes: 2048,
          idleTimeoutMs: 30_000,
          absoluteTimeoutMs: 30_000,
        })
      })
      expect(ended.reason).toBe('bytes')
    } finally {
      if (floodTimer) clearInterval(floodTimer)
      listener.stop(true)
    }
  })

  test('the absolute deadline ends a healthy, chatty stream with reason "deadline"', async () => {
    let logTimer: ReturnType<typeof setInterval> | null = null
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'top') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('99\n'))
        logTimer = setInterval(() => s.write(Buffer.from('busy\n')), 10) // never idle
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const start = Date.now()
      const ended = await new Promise<{ reason: string }>((resolve) => {
        void client.execStream('serial-deadline', 'top', {
          onData: () => {},
          onEnd: (reason) => resolve({ reason }),
          idleTimeoutMs: 30_000,
          absoluteTimeoutMs: 150,
        })
      })
      expect(ended.reason).toBe('deadline')
      expect(Date.now() - start).toBeLessThan(2_000)
    } finally {
      if (logTimer) clearInterval(logTimer)
      listener.stop(true)
    }
  })

  test('the idle timeout ends a quiet stream with reason "idle"', async () => {
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('55\n')) // the PID line, then total silence
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const ended = await new Promise<{ reason: string }>((resolve) => {
        void client.execStream('serial-idle', 'logcat', {
          onData: () => {},
          onEnd: (reason) => resolve({ reason }),
          // Bun's native socket.timeout() has a coarse floor (empirically
          // ~4s on this Bun build, well short of the 10s test timeout below)
          // regardless of how small a value is requested here.
          idleTimeoutMs: 1,
          absoluteTimeoutMs: 30_000,
        })
      })
      expect(ended.reason).toBe('idle')
    } finally {
      listener.stop(true)
    }
  }, 10_000)

  test('a PID split across multiple TCP writes is still parsed correctly, and data after it is never mistaken for the PID line', async () => {
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat') return
        s.write(Buffer.from('OKAY'))
        // The PID line arrives in two separate writes.
        s.write(Buffer.from('77'))
        setTimeout(() => {
          s.write(Buffer.from('7\n'))
          s.write(Buffer.from('first data line\n'))
        }, 5)
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const chunks: string[] = []
      const handle = await client.execStream('serial-split', 'logcat', {
        onData: (c) => chunks.push(new TextDecoder().decode(c)),
        onEnd: () => {},
        idleTimeoutMs: 30_000,
        absoluteTimeoutMs: 30_000,
      })
      while (chunks.join('').length === 0) await flush()
      expect(handle.pid).toBe(777)
      expect(chunks.join('')).toBe('first data line\n')
      await handle.stop()
    } finally {
      listener.stop(true)
    }
  })
})
