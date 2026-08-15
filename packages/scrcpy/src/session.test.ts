import { describe, expect, test } from 'bun:test'
import type { AdbExecutor } from './session'
import { parseScrcpyServerList, sweepStrayScrcpyServers, startScrcpySession, SCID_MARKER_PREFIX } from './session'

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
    run: (opts: { close: () => Promise<void>; adb: ReturnType<typeof createFakeAdb>; scid: string }) => Promise<void>,
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
      await run({ close: () => session.close(), adb: fakeAdb, scid: capturedScid })
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
})
