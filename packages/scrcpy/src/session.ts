import type { Socket } from 'bun'
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

export interface AdbExecutor {
  /** Per-device shell exec (through the Plan 01 queue). */
  exec(cmd: string): Promise<string>
  /** adb CLI-level: push jar, forward port. */
  hostAdb(args: string[]): Promise<string>
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
}

export interface ScrcpySession {
  readonly meta: VideoMeta | null
  onPacket(cb: (p: ScrcpyPacket) => void): void
  onMetaChange(cb: (m: VideoMeta) => void): void
  onClose(cb: (reason: string) => void): void
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
export async function startScrcpySession(adb: AdbExecutor, opts: ScrcpySessionOptions): Promise<ScrcpySession> {
  const log = opts.onLog ?? (() => {})
  const scid = Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, '0')

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
  // warn, not debug: a server that dies takes the whole stream with it, and
  // when this was invisible the only symptom was a session that opened and
  // produced nothing, with no explanation anywhere in the log.
  void adb
    .hostAdb(['-s', adb.serial, 'shell', cmd])
    .catch((err) => log('warn', `the scrcpy server exited: ${String(err)}`))

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
  // Safe now: the server has accepted the video socket, so it is listening and
  // the next connection lands on it rather than on a half-open forward.
  const controlSocket = await connectWithRetry(port, () => {}, () => {})

  const write = (bytes: Uint8Array) => {
    try {
      controlSocket.write(bytes)
    } catch (err) {
      log('warn', `failed to send control message: ${String(err)}`)
    }
  }

  return {
    get meta() {
      return currentMeta
    },
    onPacket: (cb) => void packetHandlers.add(cb),
    onMetaChange: (cb) => void metaHandlers.add(cb),
    onClose: (cb) => void closeHandlers.add(cb),
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
    },
    async close() {
      try {
        videoSocket.end()
        controlSocket.end()
      } catch {
        // already closed
      }
      await adb.hostAdb(['-s', adb.serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined)
    },
  }
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
