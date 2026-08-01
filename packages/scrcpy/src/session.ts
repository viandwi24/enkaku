import type { Socket } from 'bun'
import {
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouch,
  encodeUhidCreate,
  encodeUhidDestroy,
  encodeUhidInput,
} from './control/messages'
import { VideoDemuxer, type ScrcpyPacket, type VideoMeta } from './demuxer'
import { DEVICE_JAR_PATH, SCRCPY_VERSION } from './version'

export interface AdbExecutor {
  /** Shell exec per-device (lewat queue Plan 01). */
  exec(cmd: string): Promise<string>
  /** adb CLI-level: push jar, forward port. */
  hostAdb(args: string[]): Promise<string>
  serial: string
}

export interface ScrcpySessionOptions {
  jarPath: string
  /** Port host untuk forward (dari PortAllocator core). */
  port: number
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
 * Start scrcpy-server di device dan sambungkan socket video + control.
 *
 * Mode `tunnel_forward=true`: host membuka koneksi ke localabstract lewat
 * `adb forward`. Socket PERTAMA yang tersambung = video, kedua = control
 * (urutan ini bagian dari protokol internal — TODO-verify saat uji device).
 */
export async function startScrcpySession(adb: AdbExecutor, opts: ScrcpySessionOptions): Promise<ScrcpySession> {
  const log = opts.onLog ?? (() => {})
  const scid = Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, '0')

  // 1. Push jar (versi di-pin ke core).
  await adb.hostAdb(['-s', adb.serial, 'push', opts.jarPath, DEVICE_JAR_PATH])

  // 2. Jalankan server (argumen key=value sejak scrcpy 2.x).
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
  void adb.exec(cmd).catch((err) => log('debug', `scrcpy server berakhir: ${String(err)}`))

  // 3. Forward localabstract → port host.
  await adb.hostAdb(['-s', adb.serial, 'forward', `tcp:${opts.port}`, `localabstract:scrcpy_${scid}`])

  // 4. Sambungkan dua socket: video lalu control.
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

  const videoSocket = await connectWithRetry(opts.port, (data) => demuxer.push(new Uint8Array(data)), (reason) => {
    for (const cb of closeHandlers) cb(reason)
  })
  const controlSocket = await connectWithRetry(opts.port, () => {}, () => {})

  const write = (bytes: Uint8Array) => {
    try {
      controlSocket.write(bytes)
    } catch (err) {
      log('warn', `gagal kirim control message: ${String(err)}`)
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
    },
    async close() {
      try {
        videoSocket.end()
        controlSocket.end()
      } catch {
        // sudah tertutup
      }
      await adb.hostAdb(['-s', adb.serial, 'forward', '--remove', `tcp:${opts.port}`]).catch(() => undefined)
    },
  }
}

/** Server butuh waktu sesaat untuk listen — retry singkat. */
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
          close: () => onClose('socket ditutup'),
          error: (_s, err) => onClose(String(err)),
        },
      })
    } catch (err) {
      lastErr = err
      await Bun.sleep(100)
    }
  }
  throw new Error(`tidak bisa connect ke scrcpy server di port ${port}: ${String(lastErr)}`)
}
