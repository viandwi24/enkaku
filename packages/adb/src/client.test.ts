import { describe, expect, test } from 'bun:test'
import { AdbClient } from './client'
import { AdbError, type AdbErrorCode } from './errors'

/** Builds one `shell,v2,raw` wire packet: `[id][len:u32le][payload]` (plan 53 §3.3). */
function v2Frame(id: number, payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  const header = Buffer.alloc(5)
  header[0] = id
  header.writeUInt32LE(body.length, 1)
  return Buffer.concat([header, body])
}
const V2_STDOUT = 1
const V2_STDERR = 2
const V2_EXIT = 3

function failBuffer(msg: string): Buffer {
  const body = Buffer.from(msg, 'utf8')
  return Buffer.concat([Buffer.from('FAIL'), Buffer.from(body.length.toString(16).padStart(4, '0')), body])
}

/**
 * A fake adb server good enough to drive AdbClient.exec end to end: it
 * understands `host:transport:<serial>` (always OKAY), `shell,v2,raw:`
 * (routed to `onFramed`, or FAIL — "an adb build with no framed shell" —
 * when `onFramed` is omitted, exercising the plan 53 §3.4 fallback), and
 * whatever `shell:` behaviour each test wires up via `onShell`.
 */
function fakeAdbServer(
  onShell: (socket: import('bun').Socket, cmd: string) => void,
  onFramed?: (socket: import('bun').Socket, cmd: string) => void,
) {
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
        const framedMarker = 'shell,v2,raw:'
        const framedIdx = text.indexOf(framedMarker)
        if (framedIdx !== -1) {
          const cmd = text.slice(framedIdx + framedMarker.length)
          if (onFramed) onFramed(s, cmd)
          else s.write(failBuffer('unknown service shell,v2,raw'))
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
      expect(next).toEqual({ stdout: 'ok', stderr: '', exitCode: null })
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
      expect(next).toEqual({ stdout: 'ok', stderr: '', exitCode: null })
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
      expect(next).toEqual({ stdout: 'ok', stderr: '', exitCode: null })
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
      expect(out).toEqual({ stdout: 'ok', stderr: '', exitCode: null }) // exec() trims stdout, matching pre-existing behaviour
    } finally {
      listener.stop(true)
    }
  })
})

/**
 * The framed `shell,v2,raw` protocol itself (plan 53 §3.3, §3.4) — separate
 * from the queue/timeout/cap suite above, which only ever drives the
 * fallback path (its fake server has no `onFramed`).
 */
describe('AdbClient.exec — framed shell (plan 53)', () => {
  test('stdout, stderr, and the exit code arrive separated — a failing command is no longer invisible', async () => {
    const listener = fakeAdbServer(
      () => {
        throw new Error('should never fall back to shell: — the framed service answers directly')
      },
      (s, cmd) => {
        if (cmd !== "echo hello-stdout; echo oops-stderr 1>&2; exit 7") return
        s.write(Buffer.from('OKAY'))
        s.write(v2Frame(V2_STDOUT, 'hello-stdout\n'))
        s.write(v2Frame(V2_STDERR, 'oops-stderr\n'))
        s.write(v2Frame(V2_EXIT, Uint8Array.of(7)))
        s.end()
      },
    )
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const result = await client.exec('serial-framed-1', "echo hello-stdout; echo oops-stderr 1>&2; exit 7")
      expect(result).toEqual({ stdout: 'hello-stdout', stderr: 'oops-stderr', exitCode: 7 })
    } finally {
      listener.stop(true)
    }
  })

  test('packets split across several writes are still parsed correctly end to end', async () => {
    const listener = fakeAdbServer(
      () => {
        throw new Error('should never fall back to shell:')
      },
      (s, cmd) => {
        if (cmd !== 'split') return
        s.write(Buffer.from('OKAY'))
        const whole = Buffer.concat([v2Frame(V2_STDOUT, 'part-a-part-b\n'), v2Frame(V2_EXIT, Uint8Array.of(0))])
        // Write it one byte at a time to exercise the parser's incremental path over a real socket.
        for (const b of whole) s.write(Buffer.from([b]))
        s.end()
      },
    )
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const result = await client.exec('serial-framed-2', 'split')
      expect(result).toEqual({ stdout: 'part-a-part-b', stderr: '', exitCode: 0 })
    } finally {
      listener.stop(true)
    }
  })

  test('a device/adb build without shell,v2,raw falls back to shell: — exitCode: null, never a fabricated 0', async () => {
    const listener = fakeAdbServer((s, cmd) => {
      if (cmd !== 'echo hello-stdout; echo oops-stderr 1>&2; exit 7') return
      s.write(Buffer.from('OKAY'))
      // The legacy service merges stdout and stderr and has no exit-code channel at all.
      s.write(Buffer.from('hello-stdout\noops-stderr\n'))
      s.end()
    }) // no onFramed — the server FAILs shell,v2,raw:, exactly like a pre-framing adb build
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const result = await client.exec('serial-fallback-1', 'echo hello-stdout; echo oops-stderr 1>&2; exit 7')
      expect(result).toEqual({ stdout: 'hello-stdout\noops-stderr', stderr: '', exitCode: null })
    } finally {
      listener.stop(true)
    }
  })

  test('the unsupported verdict is cached per serial — the second command on the same serial skips straight to shell:', async () => {
    let framedAttempts = 0
    const listener = fakeAdbServer(
      (s, cmd) => {
        if (cmd === 'one' || cmd === 'two') {
          s.write(Buffer.from('OKAY'))
          s.write(Buffer.from(`${cmd}-out\n`))
          s.end()
        }
      },
      (s) => {
        framedAttempts++
        s.write(failBuffer('unknown service'))
      },
    )
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const first = await client.exec('serial-cache-1', 'one')
      expect(first).toEqual({ stdout: 'one-out', stderr: '', exitCode: null })
      expect(framedAttempts).toBe(1)

      const second = await client.exec('serial-cache-1', 'two')
      expect(second).toEqual({ stdout: 'two-out', stderr: '', exitCode: null })
      expect(framedAttempts).toBe(1) // no second attempt at the framed service — the verdict was cached
    } finally {
      listener.stop(true)
    }
  })
})

/**
 * A fake adb server good enough to drive `listDevices`/`reconnectOffline`
 * (plan 85 §3.3, §4.3) — both are plain host: services (send a request,
 * read one status, read one block), so this only needs to understand the
 * two service strings, not `host:transport:` or any shell service.
 */
function fakeHostServiceServer(handlers: { devicesL?: () => string; reconnectOffline?: () => string }) {
  const respond = (s: import('bun').Socket, body: string) => {
    const bodyBuf = Buffer.from(body, 'utf8')
    const lenHex = bodyBuf.length.toString(16).padStart(4, '0')
    s.write(Buffer.concat([Buffer.from('OKAY'), Buffer.from(lenHex, 'ascii'), bodyBuf]))
  }
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s, data) {
        const text = new TextDecoder().decode(data)
        if (text.includes('host:devices-l')) {
          respond(s, handlers.devicesL?.() ?? '')
          return
        }
        if (text.includes('host:reconnect-offline')) {
          respond(s, handlers.reconnectOffline?.() ?? '')
          return
        }
      },
      close() {},
      error() {},
    },
  })
}

describe('AdbClient.listDevices — host:devices-l (plan 85 §3.3, §4.3)', () => {
  test('parses a mix of the long-format padding and a plain tab, ignoring the trailing product/model fields but keeping transport_id', async () => {
    const listener = fakeHostServiceServer({
      devicesL: () =>
        '0123456789ABCDEF       device product:sunfish model:Pixel_4a device:sunfish transport_id:1\n' +
        'ZY327K2XYZ\toffline\n' +
        'ZP2222RMBS   unauthorized transport_id:3\n',
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const devices = await client.listDevices()
      expect(devices).toEqual([
        { serial: '0123456789ABCDEF', state: 'device', transportId: 1 },
        { serial: 'ZY327K2XYZ', state: 'offline' },
        { serial: 'ZP2222RMBS', state: 'unauthorized', transportId: 3 },
      ])
    } finally {
      listener.stop(true)
    }
  })

  test('a zero-length block (no devices at all) parses to an empty array', async () => {
    const listener = fakeHostServiceServer({ devicesL: () => '' })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const devices = await client.listDevices()
      expect(devices).toEqual([])
    } finally {
      listener.stop(true)
    }
  })

  /**
   * Plan 88 §3.1, §4.1, fixes F6: `usb:` is adb's own signal that a
   * transport is USB rather than TCP — this used to be discarded outright.
   * Modelled on a real `adb devices -l` line captured against the attached
   * hardware for plan 88 §5 step 88.1's H6 spike.
   */
  test('keeps the usb: field for a USB transport and transport_id for both, ignoring product/model/device', async () => {
    const listener = fakeHostServiceServer({
      devicesL: () => 'ZP2222RMBS             device usb:3-1.4.3 product:lagos_gpn model:moto_g06_power device:lagos transport_id:10\n',
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const devices = await client.listDevices()
      expect(devices).toEqual([{ serial: 'ZP2222RMBS', state: 'device', usb: '3-1.4.3', transportId: 10 }])
    } finally {
      listener.stop(true)
    }
  })

  test('a TCP line has no usb: field', async () => {
    const listener = fakeHostServiceServer({
      devicesL: () => '10.20.0.37:5555       device product:sunfish model:Pixel_4a device:sunfish transport_id:7\n',
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const devices = await client.listDevices()
      expect(devices).toEqual([{ serial: '10.20.0.37:5555', state: 'device', transportId: 7 }])
      expect(devices[0]!.usb).toBeUndefined()
    } finally {
      listener.stop(true)
    }
  })

  test('a malformed transport_id (non-numeric) is dropped rather than crashing the parse', async () => {
    const listener = fakeHostServiceServer({
      devicesL: () => 'ZP2222RMBS   device usb:3-1.4.3 transport_id:not-a-number\n',
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const devices = await client.listDevices()
      expect(devices).toEqual([{ serial: 'ZP2222RMBS', state: 'device', usb: '3-1.4.3' }])
    } finally {
      listener.stop(true)
    }
  })
})

describe('AdbClient.reconnectOffline — host:reconnect-offline (plan 85 §3.3, §4.3) — NOT kill-server', () => {
  test('sends the request and returns the server block verbatim', async () => {
    const listener = fakeHostServiceServer({ reconnectOffline: () => 'reconnecting device 0123456789ABCDEF\n' })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const result = await client.reconnectOffline()
      expect(result).toBe('reconnecting device 0123456789ABCDEF\n')
    } finally {
      listener.stop(true)
    }
  })

  test('a zero-length response block resolves to an empty string, not an error', async () => {
    const listener = fakeHostServiceServer({ reconnectOffline: () => '' })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const result = await client.reconnectOffline()
      expect(result).toBe('')
    } finally {
      listener.stop(true)
    }
  })
})

/**
 * `tcpip:<port>` as a DEVICE service (plan 88 §0.2 H1, §5 step 88.5) — a
 * `host:transport:<serial>` handshake (same shape `exec` already uses,
 * always OKAY here) followed by the `tcpip:<port>` device service itself,
 * which this fake server answers OKAY or FAIL depending on the test. This
 * proves the WIRE FRAMING `cutover.ts` relies on; whether a real adbd
 * actually accepts `tcpip:` this way (as opposed to needing the `adb`
 * CLI) is H1 itself, unverified without hardware — see plan 88 §5 step
 * 88.5's write-up.
 */
function fakeTcpipServer(onTcpip: (socket: import('bun').Socket, port: string) => void) {
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
        const marker = 'tcpip:'
        const idx = text.indexOf(marker)
        if (idx !== -1) onTcpip(s, text.slice(idx + marker.length))
      },
      close() {},
      error() {},
    },
  })
}

describe('AdbClient.tcpip — the device service H1 is about (plan 88 §0.2, §5 step 88.5)', () => {
  test('selects the device via host:transport, then resolves once tcpip:<port> replies OKAY', async () => {
    const requested: string[] = []
    const listener = fakeTcpipServer((s, port) => {
      requested.push(port)
      s.write(Buffer.from('OKAY'))
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expect(client.tcpip('ZP2222RMBS', 5555)).resolves.toBeUndefined()
      expect(requested).toEqual(['5555'])
    } finally {
      listener.stop(true)
    }
  })

  test('rejects E_ADB_FAIL when adbd refuses the service, so the caller can fall back to hostAdb.run', async () => {
    const listener = fakeTcpipServer((s) => {
      s.write(failBuffer('device unauthorized'))
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expectAdbError(client.tcpip('ZP2222RMBS', 5555), 'E_ADB_FAIL')
    } finally {
      listener.stop(true)
    }
  })
})

/**
 * A fake adb server for the `forward` trio (plan 119 §4.1, step 119.2):
 * `host-serial:<serial>:forward:<local>;<remote>`, `host:list-forward`, and
 * `host-serial:<serial>:killforward:<local>`. None of these go through
 * `host:transport:<serial>` first — the serial is embedded directly in the
 * request string, per §0.2's own live repro — so this fake server only ever
 * needs to understand these three request shapes.
 */
function fakeForwardServer(handlers: {
  onForward?: (s: import('bun').Socket, serial: string, local: string, remote: string) => void
  onListForward?: (s: import('bun').Socket) => void
  onKillForward?: (s: import('bun').Socket, serial: string, local: string) => void
}) {
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s, data) {
        const text = new TextDecoder().decode(data)
        const hostSerialMarker = 'host-serial:'
        const hostSerialIdx = text.indexOf(hostSerialMarker)
        if (hostSerialIdx !== -1) {
          const rest = text.slice(hostSerialIdx + hostSerialMarker.length)
          const colon = rest.indexOf(':')
          const serial = rest.slice(0, colon)
          const afterSerial = rest.slice(colon + 1)
          if (afterSerial.startsWith('forward:')) {
            const [local, remote] = afterSerial.slice('forward:'.length).split(';')
            if (local && remote) handlers.onForward?.(s, serial, local, remote)
            return
          }
          if (afterSerial.startsWith('killforward:')) {
            handlers.onKillForward?.(s, serial, afterSerial.slice('killforward:'.length))
            return
          }
        }
        if (text.includes('host:list-forward')) {
          handlers.onListForward?.(s)
        }
      },
      close() {},
      error() {},
    },
  })
}

/** OKAY + a length-prefixed body — the SAME shape `host:list-forward` uses (verified live, §0.2). */
function okayBlock(s: import('bun').Socket, body: string): void {
  const bodyBuf = Buffer.from(body, 'utf8')
  const lenHex = bodyBuf.length.toString(16).padStart(4, '0')
  s.write(Buffer.concat([Buffer.from('OKAY'), Buffer.from(lenHex, 'ascii'), bodyBuf]))
}

describe('AdbClient.forward / listForward / killForward — the forward trio, off the process-spawn path (plan 119)', () => {
  test('forward resolves as soon as OKAY arrives, with no body read after it — the asymmetric-shape hazard §0.2 measured', async () => {
    const requested: string[] = []
    const listener = fakeForwardServer({
      onForward(s, serial, local, remote) {
        requested.push(`${serial} ${local} ${remote}`)
        // Bare OKAY, then the connection ends immediately — no body ever
        // follows. If `forward()` wrongly called `readBlock()` next, this
        // would reject instead of resolving cleanly.
        s.write(Buffer.from('OKAY'))
        s.end()
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expect(client.forward('ZP2222RMBS', 'tcp:19999', 'localabstract:enkaku-guest-agent')).resolves.toBeUndefined()
      expect(requested).toEqual(['ZP2222RMBS tcp:19999 localabstract:enkaku-guest-agent'])
    } finally {
      listener.stop(true)
    }
  })

  test('forward rejects E_ADB_FAIL with an empty reason for a bogus device — matching §0.2\'s own live repro', async () => {
    const listener = fakeForwardServer({
      onForward(s) {
        s.write(failBuffer(''))
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expectAdbError(client.forward('no-such-device', 'tcp:19999', 'tcp:20000'), 'E_ADB_FAIL')
    } finally {
      listener.stop(true)
    }
  })

  test('listForward parses a single active forward line', async () => {
    const listener = fakeForwardServer({
      onListForward(s) {
        okayBlock(s, 'ZP2222RMBS tcp:19999 localabstract:enkaku-guest-agent\n')
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const list = await client.listForward()
      expect(list).toEqual([{ serial: 'ZP2222RMBS', local: 'tcp:19999', remote: 'localabstract:enkaku-guest-agent' }])
    } finally {
      listener.stop(true)
    }
  })

  test('listForward parses multiple active forward lines', async () => {
    const listener = fakeForwardServer({
      onListForward(s) {
        okayBlock(
          s,
          'ZP2222RMBS tcp:19999 localabstract:enkaku-guest-agent\n' + '0123456789ABCDEF tcp:20000 localabstract:enkaku-ui-server\n',
        )
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const list = await client.listForward()
      expect(list).toEqual([
        { serial: 'ZP2222RMBS', local: 'tcp:19999', remote: 'localabstract:enkaku-guest-agent' },
        { serial: '0123456789ABCDEF', local: 'tcp:20000', remote: 'localabstract:enkaku-ui-server' },
      ])
    } finally {
      listener.stop(true)
    }
  })

  test('listForward on no active forwards resolves to an empty array — the exact case §0.2 verified live', async () => {
    const listener = fakeForwardServer({
      onListForward(s) {
        okayBlock(s, '')
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expect(client.listForward()).resolves.toEqual([])
    } finally {
      listener.stop(true)
    }
  })

  test('listForward rejects rather than hangs or silently returns [] when the server sends a bare OKAY with no body — proving it actually expects the length-prefixed block, unlike forward/killForward', async () => {
    const listener = fakeForwardServer({
      onListForward(s) {
        s.write(Buffer.from('OKAY'))
        s.end() // no length-prefixed block ever follows — a protocol violation for THIS service
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expectAdbError(client.listForward(), 'E_ADB_PROTOCOL')
    } finally {
      listener.stop(true)
    }
  })

  test('listForward rejects E_ADB_FAIL when the server refuses the query', async () => {
    const listener = fakeForwardServer({
      onListForward(s) {
        s.write(failBuffer(''))
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expectAdbError(client.listForward(), 'E_ADB_FAIL')
    } finally {
      listener.stop(true)
    }
  })

  test('killForward resolves as soon as OKAY arrives, with no body read after it — same asymmetric shape as forward', async () => {
    const requested: string[] = []
    const listener = fakeForwardServer({
      onKillForward(s, serial, local) {
        requested.push(`${serial} ${local}`)
        s.write(Buffer.from('OKAY'))
        s.end()
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expect(client.killForward('ZP2222RMBS', 'tcp:19999')).resolves.toBeUndefined()
      expect(requested).toEqual(['ZP2222RMBS tcp:19999'])
    } finally {
      listener.stop(true)
    }
  })

  test('killForward rejects E_ADB_FAIL with an empty reason for a nonexistent forward — matching §0.2\'s host:killforward:tcp:19999 repro', async () => {
    const listener = fakeForwardServer({
      onKillForward(s) {
        s.write(failBuffer(''))
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expectAdbError(client.killForward('ZP2222RMBS', 'tcp:19999'), 'E_ADB_FAIL')
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
          // This fake server only understands the legacy `shell:` service
          // (plan 53 §3.4) — every `AdbClient.exec` call below (the
          // fire-and-forget `kill`, and any deliberate `exec()` call) tries
          // `shell,v2,raw:` first and must fall back.
          if (text.includes('shell,v2,raw:')) {
            s.write(failBuffer('unknown service shell,v2,raw'))
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
      expect(echoed).toEqual({ stdout: 'ok', stderr: '', exitCode: null })
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

  test('a farm-wide refusal names the current occupancy and which serials hold the slots (plan 85 §5, step 85.1)', async () => {
    let logTimerA: ReturnType<typeof setInterval> | null = null
    let logTimerB: ReturnType<typeof setInterval> | null = null
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('1\n'))
        const timer = setInterval(() => s.write(Buffer.from('x\n')), 5)
        if (!logTimerA) logTimerA = timer
        else logTimerB = timer
      },
    })
    try {
      const client = new AdbClient({
        adbPath: 'unused',
        host: '127.0.0.1',
        port: listener.port,
        maxStreamsPerDevice: 4,
        maxStreams: 2,
      })
      const first = await client.execStream('serial-a', 'logcat', { onData: () => {}, onEnd: () => {} })
      const second = await client.execStream('serial-a', 'logcat', { onData: () => {}, onEnd: () => {} })
      try {
        await client.execStream('serial-b', 'logcat', { onData: () => {}, onEnd: () => {} })
        throw new Error('expected E_ADB_STREAM_LIMIT, but the stream opened')
      } catch (err) {
        expect(err).toBeInstanceOf(AdbError)
        const message = (err as AdbError).message
        // Names the current occupancy (2 of a max of 2)...
        expect(message).toContain('2')
        // ...and the per-device breakdown naming the serial holding both slots.
        expect(message).toContain('serial-a: 2')
      }
      await first.stop()
      await second.stop()
    } finally {
      if (logTimerA) clearInterval(logTimerA)
      if (logTimerB) clearInterval(logTimerB)
      listener.stop(true)
    }
  })

  test('a per-device refusal also names the farm-wide occupancy breakdown', async () => {
    let logTimer: ReturnType<typeof setInterval> | null = null
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'logcat') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('1\n'))
        logTimer = setInterval(() => s.write(Buffer.from('x\n')), 5)
      },
    })
    try {
      const client = new AdbClient({
        adbPath: 'unused',
        host: '127.0.0.1',
        port: listener.port,
        maxStreamsPerDevice: 1,
        maxStreams: 8,
      })
      const first = await client.execStream('serial-limit', 'logcat', { onData: () => {}, onEnd: () => {} })
      try {
        await client.execStream('serial-limit', 'logcat', { onData: () => {}, onEnd: () => {} })
        throw new Error('expected E_ADB_STREAM_LIMIT, but the stream opened')
      } catch (err) {
        expect(err).toBeInstanceOf(AdbError)
        const message = (err as AdbError).message
        expect(message).toContain('serial-limit')
        expect(message).toContain('serial-limit: 1')
      }
      await first.stop()
    } finally {
      if (logTimer) clearInterval(logTimer)
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

  test('idleTimeoutMs: 0 and absoluteTimeoutMs: 0 disable both stream clocks (plan 34 §4.1, §8) — a silent, long-lived stream is never ended by either', async () => {
    const listener = fakeStreamingServer({
      onStream(s, cmd) {
        if (cmd !== 'am instrument') return
        s.write(Buffer.from('OKAY'))
        s.write(Buffer.from('88\n')) // the PID line, then total silence — like the ui-server instrumentation
      },
    })
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      const ended: Array<{ reason: string }> = []
      const handle = await client.execStream('serial-off', 'am instrument', {
        onData: () => {},
        onEnd: (reason) => ended.push({ reason }),
        idleTimeoutMs: 0,
        absoluteTimeoutMs: 0,
      })
      // Long enough to have tripped either clock had it not been disabled —
      // the idle test above needed only its coarse floor (~4s per that
      // test's own comment) and the deadline test used 150ms.
      await new Promise((r) => setTimeout(r, 500))
      expect(ended).toEqual([])
      await handle.stop()
      expect(ended).toEqual([{ reason: 'stopped' }])
    } finally {
      listener.stop(true)
    }
  })

  test('idleTimeoutMs: -1 or absoluteTimeoutMs: -1 still reject E_ADB_BAD_TIMEOUT — only 0 means "off", not any non-positive value', async () => {
    const listener = fakeStreamingServer({})
    try {
      const client = new AdbClient({ adbPath: 'unused', host: '127.0.0.1', port: listener.port })
      await expectAdbError(
        client.execStream('serial-neg', 'logcat', { onData: () => {}, onEnd: () => {}, idleTimeoutMs: -1 }),
        'E_ADB_BAD_TIMEOUT',
      )
      await expectAdbError(
        client.execStream('serial-neg2', 'logcat', { onData: () => {}, onEnd: () => {}, absoluteTimeoutMs: -1 }),
        'E_ADB_BAD_TIMEOUT',
      )
    } finally {
      listener.stop(true)
    }
  })

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
