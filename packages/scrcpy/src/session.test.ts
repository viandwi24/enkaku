import { describe, expect, test } from 'bun:test'
import type { AdbExecutor } from './session'
import { parseScrcpyServerList, sweepStrayScrcpyServers, startScrcpySession, isOwnScrcpyForwardRemote } from './session'

/** Mirrors session.ts's private marker (SCID_MARKER_BYTE = 0x7f); a test that pins the shipped value. */
const SCID_MARKER_PREFIX = '7f'

/**
 * The marker byte shipped as `0xec` for a short window and broke scrcpy on
 * every real device: the server parses `scid` with Java's signed
 * `Integer.parseInt(scid, 16)`, and a top byte with its high bit set
 * (anything `>= 0x80`) pushes every minted `scid` past `Integer.MAX_VALUE`
 * (0x7fffffff), so the server throws `NumberFormatException` before it ever
 * starts — 100% of sessions, not an occasional one. No fake-`ps`-based test
 * below can catch that, because none of them run real Java. This is the one
 * check that can, cheaply, without hardware: the marker's own numeric value
 * must fit inside a signed 31-bit range no matter what the other 6 hex
 * digits are.
 */
test('SCID_MARKER_PREFIX stays inside scrcpy signed Integer.parseInt(scid, 16) range', () => {
  const maxPossibleScid = Number.parseInt(`${SCID_MARKER_PREFIX}ffffff`, 16)
  expect(maxPossibleScid).toBeLessThanOrEqual(0x7fffffff)
  expect(maxPossibleScid).toBeGreaterThan(0)
})

/**
 * Step 100.1 — 96.23's own tests (`docs/plans/96-m61-hotfixes.md` §96.23,
 * `docs/plans/100-m65-realtime-wall-and-session-parity.md` §3.5, §5 step
 * 100.1). No hardware is available here: every assertion below is against a
 * FAKE `AdbExecutor` that records the exact shell command(s) sent, per the
 * plan's own verifiable-result wording ("asserted with a fake/mock adb
 * executor recording the exact shell command sent, since no hardware is
 * available here").
 */

/** A minimal, in-memory `AdbExecutor` that records every command it is asked to run. */
function createFakeAdb(opts: { execImpl?: (cmd: string) => Promise<string> } = {}): AdbExecutor & { execCalls: string[] } {
  const execCalls: string[] = []
  return {
    serial: 'fake-serial',
    execCalls,
    async exec(cmd: string) {
      execCalls.push(cmd)
      return opts.execImpl ? opts.execImpl(cmd) : ''
    },
    async hostAdb(args: string[]) {
      return args.join(' ')
    },
  }
}

describe('parseScrcpyServerList', () => {
  test('reads pid + scid pairs out of `ps -A -o pid,args` output', () => {
    const psOutput = [
      '  1234 CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.1 scid=0199ccbe log_level=info',
      '  1240 com.genymobile.scrcpy.CleanUp 0199ccbe',
      '  9999 some/other/process --unrelated-flag',
      '',
    ].join('\n')
    expect(parseScrcpyServerList(psOutput)).toEqual([{ pid: 1234, scid: '0199ccbe' }])
  })

  test('finds every scid-carrying line, not just the ones naming Server explicitly', () => {
    // Per the function's own doc comment: process names get truncated/renamed
    // inconsistently across OEMs, so the match is on the `scid=` token in the
    // full argument list, not on a fixed process name.
    const psOutput = '  55 CleanUpAgent scid=7f00abcd extra=1\n  56 app_process scid=7f00abcd\n'
    expect(parseScrcpyServerList(psOutput)).toEqual([
      { pid: 55, scid: '7f00abcd' },
      { pid: 56, scid: '7f00abcd' },
    ])
  })

  test('skips lines with no PID, and lines with no recognisable scid', () => {
    const psOutput = ['not a process line', '  42 app_process no-scid-here', '  '].join('\n')
    expect(parseScrcpyServerList(psOutput)).toEqual([])
  })

  test('empty output yields an empty list', () => {
    expect(parseScrcpyServerList('')).toEqual([])
  })
})

describe('sweepStrayScrcpyServers', () => {
  test('kills processes whose scid is NOT in the known set, and reports which scids it killed', async () => {
    const calls: string[] = []
    const exec = async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'ps -A -o pid,args') {
        return [
          `  100 app_process scid=${SCID_MARKER_PREFIX}0000aa`,
          `  200 app_process scid=${SCID_MARKER_PREFIX}0000bb`,
          `  300 app_process scid=${SCID_MARKER_PREFIX}0000cc`,
        ].join('\n')
      }
      return ''
    }
    const result = await sweepStrayScrcpyServers(exec, new Set([`${SCID_MARKER_PREFIX}0000bb`]))
    expect(result.killedScids.sort()).toEqual([`${SCID_MARKER_PREFIX}0000aa`, `${SCID_MARKER_PREFIX}0000cc`].sort())
    expect(calls).toEqual(['ps -A -o pid,args', 'kill -9 100 300'])
  })

  test('never touches a process whose scid IS in the known set — the "leave sibling sessions alone" property', async () => {
    const calls: string[] = []
    const scid = `${SCID_MARKER_PREFIX}deadbe`
    const exec = async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'ps -A -o pid,args') return `  1 app_process scid=${scid}\n`
      return ''
    }
    const result = await sweepStrayScrcpyServers(exec, new Set([scid]))
    expect(result.killedScids).toEqual([])
    // Only the listing ran — no kill command was ever sent.
    expect(calls).toEqual(['ps -A -o pid,args'])
  })

  test('an empty known set (the boot-time call shape) kills everything `ps` finds that carries the reserved marker byte', async () => {
    const scid = `${SCID_MARKER_PREFIX}111111`
    const exec = async (cmd: string) => (cmd === 'ps -A -o pid,args' ? `  7 app_process scid=${scid}\n` : '')
    const result = await sweepStrayScrcpyServers(exec, new Set())
    expect(result.killedScids).toEqual([scid])
  })

  test('never touches a process whose scid lacks the reserved marker byte, even with an empty known set — a foreign process merely coincidentally carrying a scid= token must survive the boot sweep', async () => {
    const calls: string[] = []
    const exec = async (cmd: string) => {
      calls.push(cmd)
      // '11' is deliberately not SCID_MARKER_PREFIX.
      if (cmd === 'ps -A -o pid,args') return '  9 some/other/process scid=11223344\n'
      return ''
    }
    const result = await sweepStrayScrcpyServers(exec, new Set())
    expect(result.killedScids).toEqual([])
    expect(calls).toEqual(['ps -A -o pid,args'])
  })

  test('is best-effort: a device that cannot answer `ps` yields an empty result, not a throw', async () => {
    const exec = async () => {
      throw new Error('device offline')
    }
    await expect(sweepStrayScrcpyServers(exec, new Set())).resolves.toEqual({ killedScids: [] })
  })

  test('is best-effort: a failing kill command still resolves with the scids it attempted', async () => {
    const scid = `${SCID_MARKER_PREFIX}111111`
    const exec = async (cmd: string) => {
      if (cmd === 'ps -A -o pid,args') return `  7 app_process scid=${scid}\n`
      throw new Error('device vanished mid-kill')
    }
    await expect(sweepStrayScrcpyServers(exec, new Set())).resolves.toEqual({ killedScids: [scid] })
  })
})

describe('close() sends a scid-scoped device-side stop (96.23)', () => {
  /**
   * Drives a REAL `startScrcpySession()` end to end against a fake local TCP
   * server standing in for the device — no hardware, no real `adb`, but the
   * actual video/control socket handshake `openForward`/`connectVideoSocket`/
   * `connectWithRetry` all run for real against `127.0.0.1`. This is the only
   * way to reach the real `close()` closure (the scid it captures is private
   * to `startScrcpySession`'s own scope) rather than re-implementing what it
   * does and asserting against the reimplementation.
   */
  async function withFakeDevice(
    run: (opts: {
      close: () => Promise<void>
      adb: ReturnType<typeof createFakeAdb>
      scid: string
      port: number
      serverPort: number
    }) => Promise<void>,
    execOpts: { execImpl?: (cmd: string) => Promise<string> } = {},
  ) {
    let connectionCount = 0
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(socket) {
          connectionCount += 1
          // The FIRST connection is the video socket: `connectVideoSocket`
          // only resolves once it has seen a byte, standing in for the real
          // server's tunnel_forward dummy byte.
          if (connectionCount === 1) socket.write(new Uint8Array([0]))
          // The second connection is the control socket — `connectWithRetry`
          // resolves on connect alone, no data required.
        },
        data() {},
        close() {},
        error() {},
      },
    })
    try {
      let capturedScid: string | null = null
      let capturedSocketName: string | null = null
      const fakeAdb = createFakeAdb(execOpts)
      const adb: AdbExecutor = {
        serial: fakeAdb.serial,
        exec: fakeAdb.exec,
        async hostAdb(args: string[]) {
          if (args.includes('push')) return ''
          if (args.includes('--remove')) return ''
          if (args.includes('--list')) {
            return `${adb.serial}\ttcp:${server.port}\t${capturedSocketName}`
          }
          if (args.includes('forward')) {
            // args: ['-s', serial, 'forward', 'tcp:0', 'localabstract:scrcpy_<scid>']
            // Real `adb forward tcp:0 <socket>` prints just the bound port
            // number on stdout — `openForward` parses the last whitespace-
            // separated token as that number.
            capturedSocketName = args[args.length - 1] ?? null
            return `${server.port}`
          }
          return ''
        },
        spawnLongLived(args) {
          // args: ['-s', serial, 'shell', 'CLASSPATH=... app_process ... scid=<hex> ...']
          const joined = args.join(' ')
          const m = /scid=([0-9a-f]+)/.exec(joined)
          capturedScid = m?.[1] ?? null
          return { pid: 1, tail: () => '', kill: () => {}, exited: new Promise<number>(() => {}) }
        },
      }
      const session = await startScrcpySession(adb, { jarPath: '/fake/scrcpy-server.jar' })
      if (!capturedScid) throw new Error('test setup: never captured a scid from spawnLongLived')
      await run({
        close: () => session.close(),
        adb: fakeAdb,
        scid: capturedScid,
        port: session.port,
        serverPort: server.port,
      })
    } finally {
      server.stop(true)
    }
  }

  test("close() runs `pkill -f 'scid=<this session's own scid>'`, targeting only its own process", async () => {
    await withFakeDevice(async ({ close, adb, scid }) => {
      await close()
      expect(adb.execCalls).toEqual([`pkill -f 'scid=${scid}'`])
    })
  })

  test('close() is best-effort: a device that cannot answer the pkill still lets close() resolve, not throw', async () => {
    await withFakeDevice(
      async ({ close, adb, scid }) => {
        await expect(close()).resolves.toBeUndefined()
        expect(adb.execCalls).toEqual([`pkill -f 'scid=${scid}'`])
      },
      {
        execImpl: async () => {
          throw new Error('device vanished mid-close')
        },
      },
    )
  })

  test("startScrcpySession's returned session exposes port and scid", async () => {
    await withFakeDevice(async ({ close, scid, port, serverPort }) => {
      expect(port).toBe(serverPort)
      expect(scid).toMatch(new RegExp(`^${SCID_MARKER_PREFIX}[0-9a-f]{6}$`))
      await close()
    })
  })
})

describe('isOwnScrcpyForwardRemote', () => {
  test('matches a well-formed scrcpy remote', () => {
    expect(isOwnScrcpyForwardRemote(`localabstract:scrcpy_${SCID_MARKER_PREFIX}0000aa`)).toBe(true)
  })

  test('rejects a remote with the wrong scid prefix', () => {
    expect(isOwnScrcpyForwardRemote('localabstract:scrcpy_110000aa')).toBe(false)
  })

  test('rejects a remote of the wrong length', () => {
    expect(isOwnScrcpyForwardRemote(`localabstract:scrcpy_${SCID_MARKER_PREFIX}0000aaff`)).toBe(false)
    expect(isOwnScrcpyForwardRemote(`localabstract:scrcpy_${SCID_MARKER_PREFIX}00aa`)).toBe(false)
  })

  test('rejects an unrelated localabstract remote', () => {
    expect(isOwnScrcpyForwardRemote('localabstract:some_other_socket')).toBe(false)
  })
})

/**
 * Step 125.9 (plan 125 §3.9, §4.5; acceptance criterion 13 — "`packages/
 * scrcpy/src/session.ts` spawns no `adb.exe` process for push or forward").
 *
 * Every test above drives the CLI wiring, which is still the fallback and
 * still what `packages/node/src/hosts.ts` uses — they keep it honest. These
 * drive the PROTOCOL wiring `packages/core/src/daemon.ts` now supplies, and
 * the countable claim is `calls.hostAdb`: it must be empty, because the four
 * process spawns a session used to cost (`push`, `forward`, `forward --list`,
 * and `forward --remove` on close) are now four protocol calls on the adb
 * server's existing socket. The FIFTH — the long-lived `adb shell` running
 * scrcpy-server itself — stays a spawn by nature and is counted separately so
 * that "zero spawns" cannot be read as "nothing was launched".
 */
describe('the video path spawns no adb.exe for push or forward (plan 125 step 125.9)', () => {
  interface ForwardEntry {
    serial: string
    local: string
    remote: string
  }

  interface HarnessOptions {
    /** Ask for a fixed host port instead of letting "adb" pick one (`opts.port`). */
    preferredPort?: boolean
    /** Stand in for `host:list-forward`; the default reports this session's own forward, bound to this device. */
    listForward?: (ctx: { serial: string; socketName: string; port: number }) => ForwardEntry[]
    /** Drop the fake device's listener the moment the video socket is up, so the CONTROL connect can never succeed. */
    breakControlSocket?: boolean
    /**
     * Make the protocol ADD reject — an adb server that does not answer
     * `host-serial:<serial>:forward:tcp:0;...` the way plan 119 §4.1 inferred
     * it would. The one shape in this path nobody has exercised against real
     * hardware.
     */
    forwardRejects?: boolean
  }

  function createHarness(opts: HarnessOptions = {}) {
    const serial = 'fake-serial'
    const calls = {
      /** Every `adb.exe` argv this session asked for. Criterion 13 wants this empty. */
      hostAdb: [] as string[][],
      /** The one spawn that legitimately remains: the long-lived scrcpy-server shell. */
      spawnLongLived: [] as string[][],
      push: [] as { localPath: string; remotePath: string }[],
      forward: [] as { serial: string; local: string; remote: string }[],
      listForward: 0,
      killForward: [] as { serial: string; local: string }[],
      exec: [] as string[],
      logs: [] as string[],
    }
    let serverChildKills = 0
    let capturedScid: string | null = null
    let capturedSocketName: string | null = null

    let connectionCount = 0
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(socket) {
          connectionCount += 1
          // Video first, control second — so every ODD connection is a video
          // socket, and a harness reused for two sequential sessions (the
          // G13 push test) still answers the second one's handshake.
          if (connectionCount % 2 === 1) {
            socket.write(new Uint8Array([0]))
            // `connectVideoSocket` has resolved by the time this listener is
            // gone; `connectWithRetry`'s 20 attempts then all get refused.
            if (opts.breakControlSocket) server.stop(true)
          }
        },
        data() {},
        close() {},
        error() {},
      },
    })

    const adb: AdbExecutor = {
      serial,
      async exec(cmd) {
        calls.exec.push(cmd)
        return ''
      },
      async hostAdb(args) {
        // Recorded AND answered: the CLI fallback has to be able to actually
        // complete when a test drives it (`forwardRejects`), while every other
        // test's `expect(calls.hostAdb).toEqual([])` proves it was never asked.
        calls.hostAdb.push(args)
        if (args.includes('--list')) return `${serial}\ttcp:${server.port}\t${capturedSocketName}`
        if (args.includes('forward') && !args.includes('--remove')) {
          capturedSocketName = args[args.length - 1] ?? null
          return `${server.port}`
        }
        return ''
      },
      spawnLongLived(args) {
        calls.spawnLongLived.push(args)
        capturedScid = /scid=([0-9a-f]+)/.exec(args.join(' '))?.[1] ?? null
        return {
          pid: 1,
          tail: () => '',
          kill: () => {
            serverChildKills += 1
          },
          exited: new Promise<number>(() => {}),
        }
      },
      async push(localPath, remotePath) {
        calls.push.push({ localPath, remotePath })
      },
      async forward(fwdSerial, local, remote) {
        if (opts.forwardRejects) throw new Error('E_ADB_FAIL: unknown host service')
        // A real `tcp:0` ADD binds an ephemeral port the caller does not learn
        // from this reply — `openForwardOverProtocol` reads it back out of the
        // listing instead, which is what the fake port below models.
        calls.forward.push({ serial: fwdSerial, local, remote })
        capturedSocketName = remote
      },
      async listForward() {
        calls.listForward += 1
        const ctx = { serial, socketName: capturedSocketName ?? '', port: server.port }
        return opts.listForward
          ? opts.listForward(ctx)
          : [{ serial, local: `tcp:${server.port}`, remote: ctx.socketName }]
      },
      async killForward(killSerial, local) {
        calls.killForward.push({ serial: killSerial, local })
      },
    }

    return {
      calls,
      serial,
      port: () => server.port,
      scid: () => capturedScid,
      serverChildKills: () => serverChildKills,
      start: () =>
        startScrcpySession(adb, {
          jarPath: '/fake/scrcpy-server.jar',
          onLog: (level, msg) => calls.logs.push(`${level}: ${msg}`),
          ...(opts.preferredPort ? { port: server.port } : {}),
        }),
      stop: () => server.stop(true),
    }
  }

  test('a whole session start issues ZERO adb.exe spawns: the push and the forward pair go over the protocol client instead', async () => {
    const h = createHarness()
    try {
      const session = await h.start()
      // The countable result criterion 13 asks for: four spawns before this
      // step, none now.
      expect(h.calls.hostAdb).toEqual([])
      // …and not because nothing happened: each one has a protocol call in
      // its place.
      expect(h.calls.push).toEqual([{ localPath: '/fake/scrcpy-server.jar', remotePath: '/data/local/tmp/scrcpy-server.jar' }])
      expect(h.calls.forward).toEqual([{ serial: h.serial, local: 'tcp:0', remote: `localabstract:scrcpy_${h.scid()}` }])
      expect(h.calls.listForward).toBe(1)
      // The one spawn that must remain: `app_process` is a process, and this
      // is the shell holding it (plan 125's own carve-out).
      expect(h.calls.spawnLongLived).toHaveLength(1)
      expect(h.calls.spawnLongLived[0]?.join(' ')).toContain('app_process')
      await session.close()
      expect(h.calls.hostAdb).toEqual([])
    } finally {
      h.stop()
    }
  })

  test('the jar is pushed on EVERY session, never cached or skipped (plan 100 G13)', async () => {
    const h = createHarness()
    try {
      const first = await h.start()
      await first.close()
      const second = await h.start()
      await second.close()
      // scrcpy-server `unlinkSelf()`s the jar as it loads, so a second session
      // that trusted the first one's push would find nothing and die with a
      // bare `Aborted`.
      expect(h.calls.push).toHaveLength(2)
    } finally {
      h.stop()
    }
  })

  test('close() removes the forward over the protocol client, with no `forward --remove` spawn', async () => {
    const h = createHarness()
    try {
      const session = await h.start()
      expect(h.calls.killForward).toEqual([])
      await session.close()
      expect(h.calls.killForward).toEqual([{ serial: h.serial, local: `tcp:${h.port()}` }])
      expect(h.calls.exec).toEqual([`pkill -f 'scid=${h.scid()}'`])
      expect(h.serverChildKills()).toBe(1)
      expect(h.calls.hostAdb).toEqual([])
    } finally {
      h.stop()
    }
  })

  /**
   * The exit routes that leaked before this step. In a sealed phone-farm box
   * (plan 125 §0.2) a leaked forward plus an orphaned server is not a tidy-up
   * item: §96.23 measured one still encoding video 7m42s after the core had
   * given up on it, and nothing short of taking the box apart reaches it.
   */
  test('a forward that comes back owned by ANOTHER device is removed, and the server it would have fed is killed', async () => {
    const h = createHarness({
      listForward: ({ socketName, port }) => [
        { serial: h.serial, local: `tcp:${port}`, remote: socketName },
        // adb cannot really bind one port twice; the check exists because
        // "video from one phone, taps landing on the other" is expensive
        // enough to be worth refusing on sight.
        { serial: 'some-other-phone', local: `tcp:${port}`, remote: 'localabstract:scrcpy_deadbeef' },
      ],
    })
    try {
      await expect(h.start()).rejects.toThrow('refusing to drive another device')
      expect(h.calls.killForward).toEqual([{ serial: h.serial, local: `tcp:${h.port()}` }])
      expect(h.calls.exec).toEqual([`pkill -f 'scid=${h.scid()}'`])
      expect(h.serverChildKills()).toBe(1)
      expect(h.calls.hostAdb).toEqual([])
    } finally {
      h.stop()
    }
  })

  test('a forward that does not come back at all still kills the server, on a preferred port also removes the forward', async () => {
    const h = createHarness({ preferredPort: true, listForward: () => [] })
    try {
      await expect(h.start()).rejects.toThrow('adb lost the forward')
      expect(h.calls.killForward).toEqual([{ serial: h.serial, local: `tcp:${h.port()}` }])
      expect(h.serverChildKills()).toBe(1)
    } finally {
      h.stop()
    }
  })

  test('a socket handshake that never completes releases the forward, the adb child AND the device-side server', async () => {
    // The failure class behind the screencap-loop fallback (§96.22): the
    // forward and the server exist, the sockets never come up, and before this
    // step the throw left all three behind — `close()` was never reachable,
    // since it is part of the object `startScrcpySession` never returned.
    const h = createHarness({ breakControlSocket: true })
    try {
      await expect(h.start()).rejects.toThrow()
      expect(h.calls.killForward).toEqual([{ serial: h.serial, local: `tcp:${h.port()}` }])
      expect(h.calls.exec).toEqual([`pkill -f 'scid=${h.scid()}'`])
      expect(h.serverChildKills()).toBe(1)
      expect(h.calls.hostAdb).toEqual([])
    } finally {
      h.stop()
    }
  }, 15_000)

  test('an adb server that refuses the protocol forward falls back to the CLI once, loudly — never to a farm with no video', async () => {
    const h = createHarness({ forwardRejects: true })
    try {
      const session = await h.start()
      // The push still went over the protocol path: only the ADD fell back.
      expect(h.calls.push).toHaveLength(1)
      const verbs = h.calls.hostAdb.map((args) => args.filter((a) => a === 'forward' || a === '--list').join(' '))
      expect(verbs).toEqual(['forward', 'forward --list'])
      expect(h.calls.logs.some((l) => l.startsWith('warn: the adb server refused a protocol-level forward'))).toBe(true)
      await session.close()
      // The remove follows the same mechanism the trio is wired with, not the
      // path the ADD happened to fall back to — `killForward` is a separate
      // service and its own refusal is already tolerated.
      expect(h.calls.killForward).toEqual([{ serial: h.serial, local: `tcp:${h.port()}` }])
    } finally {
      h.stop()
    }
  })

  test('with no protocol client supplied the CLI path is still there, spawn for spawn — the fallback plan 125 §8 keeps one line away', async () => {
    // `packages/node/src/hosts.ts` runs on exactly this shape today.
    const spawns: string[][] = []
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(socket) {
          socket.write(new Uint8Array([0]))
        },
        data() {},
        close() {},
        error() {},
      },
    })
    try {
      let socketName = ''
      const adb: AdbExecutor = {
        serial: 'fake-serial',
        async exec() {
          return ''
        },
        async hostAdb(args) {
          spawns.push(args)
          if (args.includes('--list')) return `fake-serial\ttcp:${server.port}\t${socketName}`
          if (args.includes('forward') && !args.includes('--remove')) {
            socketName = args[args.length - 1] ?? ''
            return `${server.port}`
          }
          return ''
        },
        spawnLongLived() {
          return { pid: 1, tail: () => '', kill: () => {}, exited: new Promise<number>(() => {}) }
        },
      }
      const session = await startScrcpySession(adb, { jarPath: '/fake/scrcpy-server.jar' })
      await session.close()
      const verbs = spawns.map((args) => args.filter((a) => a === 'push' || a === 'forward' || a === '--list' || a === '--remove').join(' '))
      expect(verbs).toEqual(['push', 'forward', 'forward --list', 'forward --remove'])
    } finally {
      server.stop(true)
    }
  })
})
