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
  /**
   * adb CLI-level, one-shot: push jar, forward port. **The fallback**, not the
   * first choice, since plan 125 step 125.9: `push`/`forward`/`listForward`/
   * `killForward` below do the same four things over the adb server's own
   * `host:` protocol with no `adb.exe` process spawn at all. A caller that
   * supplies none of them still works exactly as it did before that step —
   * every use of this field below sits one `if` away from the protocol path,
   * deliberately (plan 125 §8's "the fallback to `hostAdb.run` stays one line
   * away"). `packages/node/src/hosts.ts` is that caller today.
   */
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
  /**
   * Push a local file to the device over the adb server's own `sync:` service
   * — `adb push` without the `adb.exe` process (plan 125 §3.9, step 125.9).
   * `packages/adb`'s `pushFile` is the implementation the core hands in here;
   * this package declares the shape structurally rather than importing it,
   * for the same reason `LongLivedAdbChild` above is declared locally.
   *
   * This replaces the SPAWN around the jar push, never the push itself: plan
   * 100 G13 is explicit that scrcpy-server `unlinkSelf()`s the jar as it
   * starts, so EVERY session must push it fresh, and a cached/skipped push
   * shows up as an `Aborted` with no further output from the next
   * `app_process` launch — a signature that already cost two false diagnoses.
   * Nothing below caches, conditionalises, or skips it.
   */
  push?(localPath: string, remotePath: string): Promise<void>
  /**
   * The forward trio, protocol-level: `host-serial:<serial>:forward:...`,
   * `host:list-forward` and `host-serial:<serial>:killforward:...` (plan 119
   * §4.1). Plan 119 built and shipped these on `AdbClient` and wired them into
   * the guest-agent and ui-server launchers; plan 125 step 125.9 brings the
   * video path — the one hot path 119 left out — onto the same mechanism
   * rather than reimplementing it. Supplied together or not at all: the CLI
   * fallback in `openForward` needs both `forward` and `listForward` to be
   * absent to make sense, and it checks for exactly that.
   *
   * `client.ts`'s own doc comments record which of these wire shapes were
   * verified against a real device and which were inferred by analogy (plan
   * 119 acceptance criterion 5). This file does not re-derive that judgment,
   * it only consumes the three methods — the same stance
   * `guest-agent/launcher.ts` takes.
   */
  forward?(serial: string, local: string, remote: string): Promise<void>
  listForward?(): Promise<{ serial: string; local: string; remote: string }[]>
  killForward?(serial: string, local: string): Promise<void>
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
 * is control (this ordering is part of the internal protocol).
 * verified against v3.3.1 server/src/main/java/com/genymobile/scrcpy/device/DesktopConnection.java
 * on 2026-09-03: `DesktopConnection.open`'s `tunnelForward` branch accepts in
 * the fixed order video, then audio (if enabled), then control — this
 * package never enables audio, so the effective order is video then control,
 * exactly as assumed.
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
const SCID_MARKER_PREFIX = SCID_MARKER_BYTE.toString(16).padStart(2, '0')

export async function startScrcpySession(adb: AdbExecutor, opts: ScrcpySessionOptions): Promise<ScrcpySession> {
  const log = opts.onLog ?? (() => {})
  const scidRandomBytes = new Uint8Array(3)
  crypto.getRandomValues(scidRandomBytes)
  const scid =
    SCID_MARKER_PREFIX + Array.from(scidRandomBytes, (b) => b.toString(16).padStart(2, '0')).join('')

  // 1. Push the jar (its version is pinned to the core).
  //
  // EVERY session pushes it, unconditionally — see `AdbExecutor.push`'s own
  // comment and plan 100 G13. What changed in plan 125 step 125.9 is only HOW
  // the bytes get there: the `sync:` service over the adb server's existing
  // socket when the caller supplied `push`, an `adb.exe` spawn when it did not.
  await pushJar(adb, opts.jarPath)

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
  // Per-device adb access is serialised through a queue, and this process runs
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

  /**
   * Everything this session owns OFF the host: the device-side `app_process`,
   * the host-side `adb` child holding its shell, and (once there is one) the
   * forward. Called from `close()` on the normal route and from BOTH failure
   * routes below — plan 125's own constraint is that a session gives its
   * device-side resources back on every exit route, not only the happy one.
   *
   * Before this, anything thrown between the server launch above and the
   * returned object below leaked all three. A `connectVideoSocket` that
   * exhausts its 40-attempt ladder is not a hypothetical: it is the exact
   * failure class behind the screencap-loop fallback (§96.22), and it threw
   * straight out of `startScrcpySession` with nothing killing the server,
   * nothing removing the forward, and nothing running `stopDeviceSide`. The
   * caller had no handle to run `close()` with either — `close()` is part of
   * the object this function never got to return. That is precisely the leak
   * §96.23 measured on real hardware: a server still alive 7m42s after the
   * core had given up on it, encoding video into a socket nobody was reading.
   * In a sealed phone-farm box (plan 125 §0.2) that is not recoverable by hand.
   *
   * `port` is null on the one route where no forward exists yet. Every step is
   * best-effort and must never throw: it runs on a path already carrying
   * someone else's error, and a second failure here would replace the real
   * diagnosis with a worse one.
   */
  const releaseDeviceResources = async (port: number | null): Promise<void> => {
    closedDeliberately = true
    serverChild?.kill()
    await stopDeviceSide(adb, scid)
    if (port !== null) await removeForward(adb, port)
  }

  // 3. Forward localabstract → host port, and prove it belongs to this device.
  const socketName = `localabstract:scrcpy_${scid}`
  // `openForward` already removes any forward IT created on the routes where
  // it knows the port; what it cannot reach is the server spawned in step 2,
  // which by now is running on the device with nobody left to stop it.
  const port = await openForward(adb, socketName, opts.port, log).catch(async (err: unknown) => {
    await releaseDeviceResources(null)
    throw err
  })

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

  const connectSockets = async (): Promise<{ video: Socket; control: Socket }> => {
    const video = await connectVideoSocket(
      port,
      (data) => demuxer.push(data),
      (reason) => {
        for (const cb of closeHandlers) cb(reason)
      },
      log,
    )
    try {
      // Safe now: the server has accepted the video socket, so it is listening
      // and the next connection lands on it rather than on a half-open forward.
      const control = await connectWithRetry(port, (data) => deviceMessageReader(data), () => {})
      return { video, control }
    } catch (err) {
      // The video socket is live and the server is streaming into it; a
      // control socket we never got means this session is dead, so hand the
      // video half back too rather than leaving the encoder fed.
      try {
        video.end()
      } catch {
        // already closed
      }
      throw err
    }
  }

  const opened = await connectSockets().catch(async (err: unknown) => {
    await releaseDeviceResources(port)
    throw err
  })
  const videoSocket = opened.video
  const controlSocket = opened.control

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
      await releaseDeviceResources(port)
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
 * Push the version-locked scrcpy-server jar to the device (plan 125 §3.9,
 * step 125.9).
 *
 * The protocol path (`adb.push`, the adb server's own `sync:` service) when
 * the caller supplied one; the `adb.exe` spawn otherwise. The fallback is
 * deliberately kept exactly one `if` away and is what
 * `packages/node/src/hosts.ts` still runs on — plan 125 §8's mitigation for
 * "the protocol forward path regresses video where it worked for the agent"
 * is that the old mechanism stays reachable, not that it is deleted.
 *
 * The push itself is unconditional on both paths. Plan 100 G13: scrcpy-server
 * calls `unlinkSelf()` on `/data/local/tmp/scrcpy-server.jar` as it starts, so
 * a second session finds no jar and its `app_process` dies with a bare
 * `Aborted` and no further output — a signature that cost two false diagnoses
 * during the investigation plan 100 was built on. Nothing here caches it,
 * skips it, or checks whether it is "already there".
 */
async function pushJar(adb: AdbExecutor, jarPath: string): Promise<void> {
  if (adb.push) {
    await adb.push(jarPath, DEVICE_JAR_PATH)
    return
  }
  await adb.hostAdb(['-s', adb.serial, 'push', jarPath, DEVICE_JAR_PATH])
}

/**
 * Drop this session's forward. Best-effort on both paths and on every exit
 * route: a forward that is already gone (the device vanished, the adb server
 * was cycled) is not an error worth surfacing — the same tolerate-failure
 * behaviour `guest-agent/launcher.ts`'s `removeForward` keeps, and the same
 * reasoning `stopDeviceSide` above documents.
 */
async function removeForward(adb: AdbExecutor, port: number): Promise<void> {
  if (adb.killForward) {
    await adb.killForward(adb.serial, `tcp:${port}`).catch(() => undefined)
    return
  }
  await adb.hostAdb(['-s', adb.serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined)
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
 *
 * Two mechanisms, one meaning (plan 125 §3.9, step 125.9): the protocol path
 * when the caller supplied `forward` + `listForward` (plan 119's own methods,
 * reused rather than reimplemented), the two `adb.exe` spawns otherwise. The
 * ownership check is not weakened by the swap — see `openForwardOverProtocol`.
 */
async function openForward(
  adb: AdbExecutor,
  socketName: string,
  preferred: number | undefined,
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void,
): Promise<number> {
  const requested = preferred ?? 0
  const { forward, listForward } = adb
  if (forward && listForward) {
    return openForwardOverProtocol(adb, { forward, listForward }, socketName, requested, log)
  }
  return openForwardOverCli(adb, socketName, requested)
}

/**
 * The protocol path: `host-serial:<serial>:forward:...` + `host:list-forward`,
 * no process spawned (plan 119 §4.1, brought here by plan 125 step 125.9).
 *
 * The ephemeral port is read back OUT OF THE LISTING rather than out of the
 * ADD reply, and that is the one real design decision in this function.
 * `adb forward tcp:0 <socket>` prints the port the server picked because the
 * CLI reads an OPTIONAL extra protocol string after the reply; plan 119's
 * `client.forward()` deliberately reads the status and nothing else (its own
 * doc comment: "`OKAY` is never assumed to be followed by a block just because
 * some other method has one"), and its success shape is inferred rather than
 * device-verified. Teaching it to read a body this file happens to want would
 * be building on the least-verified part of that plan. The listing carries the
 * same number, on the one service of the family plan 119 §0.2 confirmed live
 * really is `OKAY` + a length-prefixed body — and it is the call the ownership
 * check needs anyway, so the port costs no extra round trip. Its PER-LINE
 * format is still inferred from the CLI's own `--list` output (plan 119 §0.2's
 * named gap: no device was attached when that plan ran, and none is attached
 * here either), which is why a listing that does not name this session's own
 * forward fails loudly below rather than being guessed past.
 *
 * `remote` is the lookup key, not `local`: `localabstract:scrcpy_<scid>` is
 * minted fresh per session from `crypto.getRandomValues`, so it names THIS
 * session's socket and nothing else. The CLI path below has to search by port
 * because that is all it knows; here, finding the entry that carries our
 * serial AND our socket name makes "the port belongs to another device"
 * unrepresentable rather than merely detected. The extra scan for a second
 * entry on the same local port is belt-and-braces: adb cannot bind one port
 * twice, but "video from one phone, taps landing on the other" is expensive
 * enough to check for anyway.
 */
async function openForwardOverProtocol(
  adb: AdbExecutor,
  client: {
    forward: (serial: string, local: string, remote: string) => Promise<void>
    listForward: () => Promise<{ serial: string; local: string; remote: string }[]>
  },
  socketName: string,
  requested: number,
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void,
): Promise<number> {
  // The ADD is the one call in this file whose wire shape nobody has exercised
  // against a real device in THIS form: plan 119 §0.2 verified `forward`'s FAIL
  // reply live and inferred its success reply, and no launcher before this one
  // ever asked for `tcp:0` (both existing callers name a fixed port). A server
  // that refuses the request outright therefore falls back to the CLI ADD once,
  // loudly, instead of costing the farm its video — plan 125 §8's mitigation
  // taken literally. The fallback covers THIS call only: an ownership check
  // that fails below is a safety refusal (plan 44 §4.4) and must never be
  // retried by another mechanism until it happens to pass.
  try {
    await client.forward(adb.serial, `tcp:${requested}`, socketName)
  } catch (err) {
    log('warn', `the adb server refused a protocol-level forward (${String(err)}) — falling back to the adb CLI for this session`)
    return openForwardOverCli(adb, socketName, requested)
  }
  // From here on a forward exists on the host. Anything thrown below has to
  // give it back before it leaves, or the session that never started keeps a
  // port bound to a device forever (plan 125's every-exit-route rule).
  let bound: number | null = requested !== 0 ? requested : null
  try {
    const list = await client.listForward()
    const mine = list.filter((f) => f.serial === adb.serial && f.remote === socketName)
    if (mine.length === 0) {
      // `bound` is still null on the `tcp:0` route here, so this one throw
      // cannot clean up after itself: the port adb chose is exactly what the
      // listing failed to tell us. Removing whatever OTHER entry claims this
      // socket name instead would mean killing a forward the listing says
      // belongs to a different device, which is the failure this whole
      // function exists to prevent — and a leaked ephemeral forward is the
      // smaller harm by a wide margin: the caller's own catch around
      // `openForward` still kills the server child and `pkill`s the device-side
      // process, so nothing is left listening at the far end of it, and
      // `daemon.ts`'s boot-time forward cleanup deliberately leaves
      // `tcp:0`-allocated scrcpy entries alone anyway (plan 85 §4.8) precisely
      // because it cannot tell them from another tool's.
      const others = list.filter((f) => f.remote === socketName)
      throw new Error(
        others.length > 0
          ? `${socketName} is bound to ${others.map((f) => f.serial).join(', ')}, not to ${adb.serial}; refusing to drive another device`
          : `adb lost the forward for ${adb.serial} → ${socketName} right after creating it`,
      )
    }
    if (mine.length > 1) {
      throw new Error(`adb reports ${mine.length} forwards for ${adb.serial} → ${socketName}; refusing to guess which one is this session's`)
    }
    const local = mine[0]!.local
    const port = Number.parseInt(/^tcp:(\d+)$/.exec(local)?.[1] ?? '', 10)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`adb did not report a forwarded port for ${socketName} (got ${JSON.stringify(local)})`)
    }
    bound = port
    const conflict = list.find((f) => f.local === local && (f.serial !== adb.serial || f.remote !== socketName))
    if (conflict) {
      throw new Error(
        `${local} is bound to ${conflict.serial} → ${conflict.remote} as well as to ${adb.serial} → ${socketName}; ` +
          'refusing to drive another device',
      )
    }
    return port
  } catch (err) {
    if (bound !== null) await removeForward(adb, bound)
    throw err
  }
}

/**
 * The `adb.exe` path, unchanged in behaviour since before plan 125 step 125.9
 * — kept as the fallback for a caller with no protocol client (today:
 * `packages/node/src/hosts.ts`), not as dead code.
 */
async function openForwardOverCli(adb: AdbExecutor, socketName: string, requested: number): Promise<number> {
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
    await removeForward(adb, port)
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
