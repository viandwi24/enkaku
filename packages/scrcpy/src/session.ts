import type { Socket } from 'bun'
import { createClipboardControl } from './control'
import { createDeviceMessageReader, type DeviceMessage } from './control/device-messages'
import {
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouch,
  encodeResetVideo,
  encodeSetDisplayPower,
  encodeUhidCreate,
  encodeUhidDestroy,
  encodeUhidInput,
} from './control/messages'
import { VideoDemuxer, type ScrcpyPacket, type VideoMeta } from './demuxer'
import { DEVICE_JAR_PATH, SCRCPY_VERSION } from './version'

/**
 * A long-lived adb CLI child (the scrcpy server's `adb shell`), returned by
 * `AdbExecutor.spawnLongLived` (plan 85 §3.4, §4.5, fixes F12). Structurally
 * identical to `packages/core/src/device/host-adb.ts`'s `LongLivedChild` —
 * this package cannot import that type directly (core depends on scrcpy,
 * never the reverse), so the shape is declared locally and the core's real
 * `hostAdb.spawnLongLived` satisfies it by matching structure alone.
 */
export interface LongLivedAdbChild {
  readonly pid: number | null
  /** The last 64 KB of combined stdout+stderr, for diagnostics — bounded, never the whole session. */
  tail(): string
  kill(): void
  exited: Promise<number>
}

export interface AdbExecutor {
  /** Per-device shell exec (through the Plan 01 queue). */
  exec(cmd: string): Promise<string>
  /** adb CLI-level, one-shot: push jar, forward port. */
  hostAdb(args: string[]): Promise<string>
  /**
   * adb CLI-level, long-lived: the `adb shell` that runs the scrcpy server
   * itself (plan 85 §3.4, §4.5, fixes F12). Optional: `packages/core/src/
   * daemon.ts` always supplies it (bound to its one shared `hostAdb`
   * instance), but `packages/node/src/hosts.ts` — the cloud node's own,
   * separate wiring, out of scope for plan 85 step 85.3 — does not yet.
   * `startScrcpySession` falls back to the old fire-and-forget `hostAdb`
   * launch when this is absent, so that caller keeps working unchanged.
   */
  spawnLongLived?(args: string[], opts?: { onExit?: (code: number, tail: string) => void }): LongLivedAdbChild
  serial: string
}

export interface ScrcpySessionOptions {
  jarPath: string
  /**
   * Host port for the forward. Omit it — the default asks adb to pick, which is
   * the only allocation that cannot collide. See `openForward`.
   */
  port?: number
  maxSize?: number
  bitRate?: number
  maxFps?: number
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

export interface ScrcpyControl {
  injectTouch(action: 'down' | 'up' | 'move', x: number, y: number, w: number, h: number): void
  injectKeycode(action: 'down' | 'up', keycode: number, meta?: number): void
  injectText(text: string): void
  uhidCreate(id: number, name: string, reportDesc: Uint8Array): void
  uhidInput(id: number, report: Uint8Array): void
  uhidDestroy(id: number): void
  /** Blank or restore the device's physical panel; the video stream is unaffected (Plan 17 §3.5). */
  setDisplayPower(on: boolean): void
  /** Force the encoder to emit a fresh keyframe, for a viewer that just joined (Plan 17 §3.6). */
  resetVideo(): void
  /**
   * Read the device clipboard (plan 38 §4.3). Resolves on the next
   * `clipboard` device message; rejects `E_CLIPBOARD_TIMEOUT` after
   * `timeoutMs` (default 2s) with no reply.
   */
  getClipboard(opts?: { copyKey?: 'none' | 'copy' | 'cut'; timeoutMs?: number }): Promise<string>
  /**
   * Write the device clipboard (plan 38 §3.4, §4.3). Resolves once the
   * server's `ACK_CLIPBOARD` echoes back the sequence this call sent;
   * rejects `E_CLIPBOARD_TIMEOUT` after `timeoutMs` (default 2s) with none.
   * `paste` defaults to false.
   */
  setClipboard(text: string, opts?: { paste?: boolean; timeoutMs?: number }): Promise<void>
}

export interface ScrcpySession {
  readonly meta: VideoMeta | null
  onPacket(cb: (p: ScrcpyPacket) => void): void
  onMetaChange(cb: (m: VideoMeta) => void): void
  onClose(cb: (reason: string) => void): void
  /**
   * Device→host messages on the control socket (plan 38 §3.2, §4.2) —
   * clipboard replies today, UHID output reports in future work. `control`'s
   * `getClipboard`/`setClipboard` are built on this same channel; most
   * callers never need to subscribe directly.
   */
  onDeviceMessage(cb: (m: DeviceMessage) => void): void
  control: ScrcpyControl
  close(): Promise<void>
}

/**
 * Start scrcpy-server on the device and connect the video and control sockets.
 *
 * With `tunnel_forward=true` the host opens a connection to the localabstract
 * socket via `adb forward`. The FIRST socket to connect is video, the second
 * is control (this ordering is part of the internal protocol — TODO-verify on
 * a real device).
 */
/**
 * Reserved top byte of every `scid` this codebase mints. Cuts the random
 * part from 31 to 24 bits — still ~16.7M values, far more entropy than this
 * farm's handful of concurrent sessions ever needs — so that
 * `sweepStrayScrcpyServers`'s boot-time pass (which runs with an empty
 * `knownScids`, i.e. "kill anything unrecognised") can tell "an orphan of
 * OUR OWN prior session" apart from any other process that merely happens
 * to carry a `scid=<hex>` token on its command line, and never kill the
 * latter. Without this, an empty `knownScids` made the sweep indistinguishable
 * from "kill every process matching this pattern, ours or not."
 *
 * MUST stay `<= 0x7f`: scrcpy's server parses `scid` with Java's
 * `Integer.parseInt(scid, 16)` — SIGNED 32-bit, not `parseUnsignedInt`. A top
 * byte with its high bit set (anything `>= 0x80`, e.g. the `0xec` this was
 * shipped with) makes every `scid` this process mints exceed
 * `Integer.MAX_VALUE` (0x7fffffff), and the server throws
 * `NumberFormatException` before it ever starts — 100% of sessions falling
 * back to screencap-loop, not an occasional one. `0x7f` keeps the marker
 * distinctive while staying inside the signed range.
 */
const SCID_MARKER_BYTE = 0x7f
export const SCID_MARKER_PREFIX = SCID_MARKER_BYTE.toString(16).padStart(2, '0')

export async function startScrcpySession(adb: AdbExecutor, opts: ScrcpySessionOptions): Promise<ScrcpySession> {
  const log = opts.onLog ?? (() => {})
  const scidRandomBytes = new Uint8Array(3)
  crypto.getRandomValues(scidRandomBytes)
  const scid =
    SCID_MARKER_PREFIX + Array.from(scidRandomBytes, (b) => b.toString(16).padStart(2, '0')).join('')

  // 1. Push the jar (its version is pinned to the core).
  await adb.hostAdb(['-s', adb.serial, 'push', opts.jarPath, DEVICE_JAR_PATH])

  // 2. Start the server (key=value arguments since scrcpy 2.x).
  const args = [
    `scid=${scid}`,
    'log_level=info',
    'video=true',
    'audio=false',
    'control=true',
    'tunnel_forward=true',
    'video_codec=h264',
    `max_size=${opts.maxSize ?? 1600}`,
    `video_bit_rate=${opts.bitRate ?? 4_000_000}`,
    `max_fps=${opts.maxFps ?? 30}`,
    'cleanup=true',
    'raw_stream=false',
  ]
  const cmd = `CLASSPATH=${DEVICE_JAR_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ${args.join(' ')}`
  // Launched through the adb CLI, deliberately NOT through `adb.exec`.
  //
  // Per-device adb access is serialised through a queue, and this command runs
  // for as long as the session lives — routing it through the queue parked a
  // slot forever, so every later shell command on that device queued behind a
  // process that never exits. Volume keys did nothing, the ui-server inspector
  // timed out and fell back, and none of it reported an error: the commands
  // were not failing, they were never running.
  //
  // `spawnLongLived` (plan 85 §3.4, §4.5, fixes F12), not the fire-and-forget
  // `hostAdb` this used to go through: something now actually HOLDS this
  // child — `close()` below kills it, and `daemon.stop()`'s `hostAdb.killAll()`
  // is the backstop if `close()` is never reached. Its stdout/stderr are
  // drained into a bounded 64 KB ring buffer instead of accumulated forever.
  // `closedDeliberately` distinguishes an operator-initiated `close()` from
  // the server dying on its own — only the latter is worth a `warn`: a
  // server that dies unexpectedly takes the whole stream with it, and when
  // that was invisible the only symptom was a session that opened and
  // produced nothing, with no explanation anywhere in the log.
  let closedDeliberately = false
  const serverChild: LongLivedAdbChild | null = adb.spawnLongLived
    ? adb.spawnLongLived(['-s', adb.serial, 'shell', cmd], {
        onExit: (code, tail) => {
          if (closedDeliberately) return
          log('warn', `the scrcpy server exited unexpectedly (code ${code}): ${tail.trim() || '(no output captured)'}`)
        },
      })
    : null
  if (!serverChild) {
    void adb.hostAdb(['-s', adb.serial, 'shell', cmd]).catch((err) => log('warn', `the scrcpy server exited: ${String(err)}`))
  }

  // 3. Forward localabstract → host port, and prove it belongs to this device.
  const socketName = `localabstract:scrcpy_${scid}`
  const port = await openForward(adb, socketName, opts.port)

  // 4. Connect the two sockets: video first, then control.
  const packetHandlers = new Set<(p: ScrcpyPacket) => void>()
  const metaHandlers = new Set<(m: VideoMeta) => void>()
  const closeHandlers = new Set<(reason: string) => void>()
  let currentMeta: VideoMeta | null = null

  const demuxer = new VideoDemuxer({
    expectDummyByte: true,
    onMeta: (meta) => {
      currentMeta = meta
      for (const cb of metaHandlers) cb(meta)
    },
    onPacket: (packet) => {
      for (const cb of packetHandlers) cb(packet)
    },
  })

  const videoSocket = await connectVideoSocket(
    port,
    (data) => demuxer.push(data),
    (reason) => {
      for (const cb of closeHandlers) cb(reason)
    },
    log,
  )
  // Device→host messages (plan 38 §3.2): the control socket was write-only
  // until now — GET_CLIPBOARD is the first message that gets an answer back.
  // A parser error must never close this socket (plan 38 §8): input already
  // works through it via `write` below, and the reader is purely additive.
  const deviceMessageHandlers = new Set<(m: DeviceMessage) => void>()
  const deviceMessageReader = createDeviceMessageReader(
    (m) => {
      for (const cb of deviceMessageHandlers) cb(m)
    },
    (err) => log('warn', `device message reader stopped: ${String(err)}`),
  )

  // Safe now: the server has accepted the video socket, so it is listening and
  // the next connection lands on it rather than on a half-open forward.
  const controlSocket = await connectWithRetry(port, (data) => deviceMessageReader(data), () => {})

  const write = (bytes: Uint8Array) => {
    try {
      controlSocket.write(bytes)
    } catch (err) {
      log('warn', `failed to send control message: ${String(err)}`)
    }
  }

  const clipboardControl = createClipboardControl({
    write,
    onDeviceMessage: (cb) => {
      deviceMessageHandlers.add(cb)
      return () => deviceMessageHandlers.delete(cb)
    },
  })

  return {
    get meta() {
      return currentMeta
    },
    onPacket: (cb) => void packetHandlers.add(cb),
    onMetaChange: (cb) => void metaHandlers.add(cb),
    onClose: (cb) => void closeHandlers.add(cb),
    onDeviceMessage: (cb) => void deviceMessageHandlers.add(cb),
    control: {
      injectTouch: (action, x, y, w, h) =>
        write(encodeInjectTouch({ action, x, y, screenWidth: w, screenHeight: h })),
      injectKeycode: (action, keycode, meta = 0) => write(encodeInjectKeycode(action, keycode, meta)),
      injectText: (text) => write(encodeInjectText(text)),
      uhidCreate: (id, name, desc) => write(encodeUhidCreate(id, name, desc)),
      uhidInput: (id, report) => write(encodeUhidInput(id, report)),
      uhidDestroy: (id) => write(encodeUhidDestroy(id)),
      setDisplayPower: (on) => write(encodeSetDisplayPower(on)),
      resetVideo: () => write(encodeResetVideo()),
      getClipboard: (opts) => clipboardControl.getClipboard(opts),
      setClipboard: (text, opts) => clipboardControl.setClipboard(text, opts),
    },
    async close() {
      try {
        videoSocket.end()
        controlSocket.end()
      } catch {
        // already closed
      }
      closedDeliberately = true
      serverChild?.kill()
      await stopDeviceSide(adb, scid)
      await adb.hostAdb(['-s', adb.serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined)
    },
  }
}

/**
 * Best-effort, scid-scoped device-side stop (96.23 —
 * `docs/plans/96-m61-hotfixes.md`, promoted to a hard prerequisite by plan
 * 100 §3.5/§3.2). `serverChild?.kill()` above only terminates the HOST-side
 * `adb` CLI child; it never signals the `app_process` scrcpy actually
 * started on the device. Usually invisible — the server notices its sockets
 * close and exits on its own — but a session whose sockets never
 * successfully connected (the exact failure class behind the
 * screencap-loop fallback, §96.22) leaves nothing telling that process to
 * stop, and it keeps encoding video into a socket nobody is reading.
 * Observed directly on real hardware: a core-spawned server still alive
 * 7m42s after the core had given up on it (§96.23).
 *
 * `pkill -f 'scid=<scid>'` is not a guess: it is the literal command plan
 * 100's own G12 hardware probe used by hand to kill ONE of three concurrent
 * servers on the owner's phone (moto g06 power) and confirmed the other two
 * kept running undisturbed — exactly the "target this session's own
 * process, never every scrcpy process on the device" property a
 * two-concurrent-session design (plan 100 §3.2) depends on. `scid` is an 8
 * hex-digit token minted fresh per session above (`crypto.getRandomValues`-
 * derived — never `Math.random()`, per this codebase's own convention for
 * anything security- or identity-adjacent — never user input, never
 * re-used), so the substring is unique to this one process's command line —
 * and every device-side process this session could
 * have started (the `Server` itself, and its `CleanUp` companion, which is
 * only spawned once the server has accepted a connection) is launched with
 * that same token on its own command line, so one `pkill -f` reaches both.
 *
 * Best-effort and MUST NEVER fail (or meaningfully delay) `close()`: a
 * phone that has already vanished (USB unplugged, adb offline) cannot
 * usefully surface a second error here — the same reasoning
 * `packages/core/src/device/transfer.ts`'s `install()` documents in its own
 * `finally` block for a staged APK it could not delete.
 */
async function stopDeviceSide(adb: AdbExecutor, scid: string): Promise<void> {
  await adb.exec(`pkill -f 'scid=${scid}'`).catch(() => undefined)
}

/** One device-side scrcpy process, as read off `ps -A -o pid,args` (see `parseScrcpyServerList`). */
export interface DeviceScrcpyProcess {
  pid: number
  /** The `scid=<hex>` token carried on this process's own command line — every launch above sets it first. */
  scid: string
}

/**
 * Parses `ps -A -o pid,args` output into every process this package's own
 * sessions could have started, keyed by the `scid` each one's launch
 * arguments carry. A line that has no PID, or whose command line carries no
 * recognisable `scid=<hex>` token, is silently skipped rather than guessed
 * at — this deliberately does NOT filter on a process name (`app_process`,
 * `com.genymobile.scrcpy.Server`/`CleanUp`) because Android's own `ps`
 * truncates or renames comm strings inconsistently across OEMs and API
 * levels; the `scid=` token in the full argument list is the one thing
 * every process this codebase spawns is guaranteed to carry, and it is
 * this codebase's own random token, not something another app could
 * plausibly collide with.
 */
export function parseScrcpyServerList(psOutput: string): DeviceScrcpyProcess[] {
  const out: DeviceScrcpyProcess[] = []
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s+(.*)$/.exec(trimmed)
    if (!match) continue
    const [, pidStr, args] = match
    const scidMatch = /scid=([0-9a-f]+)/.exec(args ?? '')
    if (!scidMatch) continue
    const pid = Number.parseInt(pidStr ?? '', 10)
    if (!Number.isInteger(pid)) continue
    out.push({ pid, scid: scidMatch[1]! })
  }
  return out
}

/**
 * Kills every device-side scrcpy process whose `scid` is NOT in
 * `knownScids` — orphans left by a crash, an ungraceful shutdown, or any
 * session that never reached `close()` at all (96.23; plan 100 §3.5's
 * "startup sweep"). Never touches a process whose scid IS recognised —
 * the same "never touch a sibling session" property `stopDeviceSide`
 * guarantees for one session's own close().
 *
 * Meant to be called once per attached device at boot, before any session
 * is built, with `knownScids` empty — nothing is open yet in a fresh
 * process, so every scrcpy process `ps` still finds at that point is, by
 * definition, an orphan from whatever ran before this boot (a prior crash,
 * or an ungraceful shutdown that skipped every `close()`). The signature
 * also supports a narrower sweep later (a non-empty `knownScids`), but
 * nothing in step 100.1 calls it that way yet.
 *
 * Best-effort throughout, matching `stopDeviceSide`: a device that cannot
 * answer `ps` (offline, no permission, USB unplugged) is not this
 * function's problem to surface — it returns an empty result rather than
 * throwing, and boot must never fail because one attached phone could not
 * be swept.
 *
 * Also filters on `SCID_MARKER_PREFIX`: a process whose `scid=` token does
 * not carry our reserved top byte is never a candidate for `strays`, no
 * matter what `knownScids` says. This matters specifically for the
 * boot-time call shape (`knownScids` empty) — without it, "unrecognised"
 * would mean "everything," and a coincidental `scid=<hex>` token on some
 * unrelated process's command line would get killed on sight.
 */
export async function sweepStrayScrcpyServers(
  exec: (cmd: string) => Promise<string>,
  knownScids: ReadonlySet<string>,
): Promise<{ killedScids: string[] }> {
  let psOutput: string
  try {
    psOutput = await exec('ps -A -o pid,args')
  } catch {
    return { killedScids: [] }
  }
  const strays = parseScrcpyServerList(psOutput).filter(
    (p) => p.scid.startsWith(SCID_MARKER_PREFIX) && !knownScids.has(p.scid),
  )
  if (strays.length === 0) return { killedScids: [] }
  await exec(`kill -9 ${strays.map((p) => p.pid).join(' ')}`).catch(() => undefined)
  return { killedScids: [...new Set(strays.map((p) => p.scid))] }
}

/**
 * Bind a host port to this device's scrcpy socket, and refuse to continue
 * unless adb agrees the binding is ours.
 *
 * A host port maps to exactly ONE device. `adb forward` on a port another
 * device already holds silently rebinds it, so with two phones attached, one
 * device's session could end up talking to the other device's scrcpy server —
 * video from one phone, taps landing on the other. Nothing in the stack
 * reported an error; it simply controlled the wrong hardware.
 *
 * `tcp:0` asks adb to choose the port, which removes the collision at the
 * source. The listing check after it is what turns any remaining surprise into
 * a loud failure instead of a wrong phone reacting.
 */
async function openForward(adb: AdbExecutor, socketName: string, preferred?: number): Promise<number> {
  const requested = preferred ?? 0
  const out = await adb.hostAdb(['-s', adb.serial, 'forward', `tcp:${requested}`, socketName])
  const port = requested !== 0 ? requested : Number.parseInt(out.trim().split(/\s+/).pop() ?? '', 10)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`adb did not report a forwarded port for ${socketName} (got ${JSON.stringify(out)})`)
  }

  const list = await adb.hostAdb(['forward', '--list'])
  const owner = list
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, local]) => local === `tcp:${port}`)
  if (!owner) throw new Error(`adb lost the forward for tcp:${port} right after creating it`)
  if (owner[0] !== adb.serial || owner[2] !== socketName) {
    await adb.hostAdb(['-s', adb.serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined)
    throw new Error(
      `tcp:${port} is bound to ${owner[0]} → ${owner[2]}, not to ${adb.serial} → ${socketName}; ` +
        'refusing to drive another device',
    )
  }
  return port
}

/**
 * Connect the video socket, and only accept it once the server has proved it is
 * there by sending the tunnel_forward dummy byte.
 *
 * A plain connect is not enough. `adb forward` accepts our TCP connection
 * before it knows whether anything is listening on the localabstract socket, so
 * connecting a few milliseconds after spawning the server yields a socket that
 * looks fine and is closed a moment later. Retrying only on a thrown connect
 * meant we kept that dead socket, and the stream sat at zero frames forever
 * while the UI cheerfully reported `streaming · H.264` — the failure was
 * invisible because every step "succeeded".
 *
 * So: connect, wait for the first byte, and start over if the socket dies or
 * stays silent. The dummy byte is written the instant the server accepts, so a
 * healthy device answers well inside the per-attempt window.
 */
async function connectVideoSocket(
  port: number,
  onData: (data: Uint8Array) => void,
  onClose: (reason: string) => void,
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void,
): Promise<Socket> {
  const ATTEMPTS = 40
  const SILENCE_MS = 400
  let lastErr: unknown = null

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let live = false
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let socket: Socket
    try {
      socket = await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          data: (_s, data) => {
            if (!live) {
              live = true
              resolve()
            }
            onData(new Uint8Array(data))
          },
          // Before the handshake a close means "nothing was listening yet";
          // after it, the session has genuinely ended.
          close: () => (live ? onClose('socket closed') : reject(new Error('closed before the handshake'))),
          error: (_s, err) => (live ? onClose(String(err)) : reject(err)),
        },
      })
    } catch (err) {
      lastErr = err
      await Bun.sleep(150)
      continue
    }

    const timer = setTimeout(() => reject(new Error(`no data within ${SILENCE_MS}ms`)), SILENCE_MS)
    try {
      await promise
      clearTimeout(timer)
      if (attempt > 0) log('debug', `the video socket came up on attempt ${attempt + 1}`)
      return socket
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      socket.end()
      await Bun.sleep(150)
    }
  }
  throw new Error(`the scrcpy server never answered on port ${port}: ${String(lastErr)}`)
}

/** The server takes a moment to start listening — retry briefly. */
async function connectWithRetry(
  port: number,
  onData: (data: Uint8Array) => void,
  onClose: (reason: string) => void,
): Promise<Socket> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          data: (_s, data) => onData(new Uint8Array(data)),
          close: () => onClose('socket closed'),
          error: (_s, err) => onClose(String(err)),
        },
      })
    } catch (err) {
      lastErr = err
      await Bun.sleep(100)
    }
  }
  throw new Error(`could not connect to the scrcpy server on port ${port}: ${String(lastErr)}`)
}
