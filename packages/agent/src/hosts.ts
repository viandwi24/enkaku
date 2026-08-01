import type { AdbClient } from '@enkaku/adb'
import { encodeTunnelFrame, type ControlToAgent } from '@enkaku/protocol'
import {
  createInspectorForSession,
  createJobRunner,
  createSessionManager,
  PortAllocator,
  parsePortRange,
  type ArtifactSink,
  type DeviceSnapshot,
  type DeviceSnapshotSource,
  type Logger,
  type SessionManager,
} from '@enkaku/session'
import { startScrcpySession } from '@enkaku/scrcpy'
import type { ToolchainManager } from '@enkaku/toolchain'
import type { Tunnel } from './tunnel'

/** Batas artifact yang boleh dikirim inline sebagai base64 di JSON. */
const INLINE_ARTIFACT_LIMIT = 256 * 1024

export interface AgentHosts {
  handle(msg: ControlToAgent): Promise<void>
  /** Device yang terlihat agent — sumber data untuk session. */
  updateDevices(list: DeviceSnapshot[]): void
  closeAll(): Promise<void>
}

/**
 * Penanganan perintah control plane di sisi agent (plan 12 §4.3):
 * `session.start/stop`, `input.forward`, `job.dispatch`, `job.cancel.forward`.
 *
 * Semua keputusan kebijakan (lease, status busy, prioritas antrian) sudah
 * diambil control plane sebelum pesan sampai ke sini. Agent memvalidasi ulang
 * hal-hal yang hanya dia ketahui — device masih ada, sesi masih hidup —
 * sebagai lapis kedua, bukan sebagai kebijakan tandingan.
 */
export function createAgentHosts(deps: {
  client: AdbClient
  toolchain: ToolchainManager
  tunnel: () => Tunnel | null
  dataDir: string
  log: Logger
}): AgentHosts {
  const devices = new Map<string, DeviceSnapshot>()
  const source: DeviceSnapshotSource = { get: (id) => devices.get(id) ?? null }
  const ports = new PortAllocator(parsePortRange(process.env.ENKAKU_UI_SERVER_PORT_RANGE))
  /** deviceId → channelId video yang dibuka control plane. */
  const videoChannels = new Map<string, number>()
  /** deviceId → pelepas subscriber frame. */
  const frameUnsubs = new Map<string, () => void>()

  const hostAdb = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn([deps.client.binaryPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    const exit = await proc.exited
    if (exit !== 0) throw new Error(`adb ${args.join(' ')} exit ${exit}: ${out.trim()}`)
    return out
  }

  const sessions: SessionManager = createSessionManager({
    client: deps.client,
    devices: source,
    log: deps.log.child('session'),
    makeInspector: (deviceId, transport, requested) =>
      createInspectorForSession(
        { toolchain: deps.toolchain, ports, log: deps.log.child('inspector'), hostAdb },
        { deviceId, transport, requested },
      ),
    makeScrcpy: async (deviceId, transport) => {
      const jarPath = await deps.toolchain.resolveToolPath('scrcpy-server').catch(() => null)
      if (!jarPath) return null
      const port = await ports.claim(`scrcpy:${deviceId}`)
      return startScrcpySession(
        { serial: transport.serial, exec: (cmd) => transport.exec(cmd), hostAdb },
        { jarPath, port, onLog: (level, msg) => deps.log.child('scrcpy')[level](msg) },
      )
    },
  })

  const send = (msg: Parameters<NonNullable<ReturnType<typeof deps.tunnel>>['send']>[0]) => deps.tunnel()?.send(msg)

  /** Artifact dikirim ke control plane, bukan disimpan di agent. */
  const artifactSink = (jobId: string): ArtifactSink => ({
    async save({ kind, label, data, ext }) {
      if (data.length > INLINE_ARTIFACT_LIMIT) {
        // Artifact besar lewat channel biner supaya tidak menyumbat JSON.
        const channel = videoChannels.get(`artifact:${jobId}`)
        if (channel !== undefined) {
          deps.tunnel()?.sendFrame(channel, data)
        } else {
          deps.log.warn(`artifact "${label}" (${data.length}B) melebihi batas inline dan channel biner belum dibuka`)
        }
      } else {
        send({
          type: 'job.progress',
          payload: {
            jobId,
            kind: 'artifact',
            artifact: {
              label,
              kind,
              ...(ext ? { ext } : {}),
              dataBase64: Buffer.from(data).toString('base64'),
            },
          },
        })
      }
      // Path sesungguhnya ditentukan control plane saat menyimpan.
      return { path: `remote/${jobId}/${label}`, sizeBytes: data.length }
    },
  })

  const runner = createJobRunner({
    logDir: deps.dataDir,
    sessions,
    artifacts: artifactSink,
    log: deps.log.child('runner'),
    onLog: (entry) =>
      send({
        type: 'job.progress',
        payload: {
          jobId: entry.jobId,
          kind: 'log',
          log: { level: entry.level, source: entry.source, msg: entry.msg, ts: entry.ts },
        },
      }),
    onArtifact: () => {
      // Sudah dikirim oleh artifactSink saat menyimpan.
    },
    onPhase: (jobId, attempt, phase) =>
      send({ type: 'job.progress', payload: { jobId, kind: 'phase', phase, attempt } }),
    heartbeat: () => {
      // Lease dipegang control plane; setiap job.progress berfungsi sebagai heartbeat.
    },
  })

  async function startSession(deviceId: string): Promise<void> {
    const noop = () => {}
    try {
      const session = await sessions.acquire(deviceId, noop)
      send({
        type: 'session.started',
        payload: {
          deviceId,
          codec: session.displayEngineId === 'scrcpy' ? 'h264' : 'png',
          width: session.frameSize.width,
          height: session.frameSize.height,
          displayEngine: session.displayEngineId,
          inputEngine: session.inputEngineId,
          inspectorEngine: session.inspectorEngineId,
        },
      })
      // Alirkan frame ke channel video yang dibuka control plane.
      const onFrame = (chunk: Uint8Array) => {
        const channel = videoChannels.get(deviceId)
        const tunnel = deps.tunnel()
        if (channel === undefined || !tunnel) return
        tunnel.sendFrame(channel, chunk)
      }
      await sessions.acquire(deviceId, onFrame)
      frameUnsubs.set(deviceId, () => sessions.release(deviceId, onFrame))
      sessions.release(deviceId, noop)
      await session.display.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'session_failed'
      deps.log.warn(`session.start ${deviceId} gagal: ${message}`)
      send({ type: 'session.failed', payload: { deviceId, code, message } })
    }
  }

  return {
    updateDevices(list) {
      devices.clear()
      for (const d of list) devices.set(d.id, d)
    },

    async handle(msg) {
      switch (msg.type) {
        case 'session.start':
          await startSession(msg.payload.deviceId)
          return

        case 'session.stop': {
          frameUnsubs.get(msg.payload.deviceId)?.()
          frameUnsubs.delete(msg.payload.deviceId)
          await sessions.closeDevice(msg.payload.deviceId)
          return
        }

        case 'tunnel.channel.open':
          videoChannels.set(msg.payload.deviceId, msg.payload.channelId)
          return

        case 'tunnel.channel.close': {
          for (const [deviceId, ch] of [...videoChannels]) {
            if (ch === msg.payload.channelId) videoChannels.delete(deviceId)
          }
          return
        }

        case 'input.forward': {
          const session = sessions.get(msg.payload.deviceId)
          if (!session) {
            send({
              type: 'session.failed',
              payload: { deviceId: msg.payload.deviceId, code: 'no_session', message: 'tidak ada sesi aktif' },
            })
            return
          }
          const a = msg.payload.action
          try {
            if (a.kind === 'tap') await session.input.tap(a.point)
            else if (a.kind === 'swipe') await session.input.swipe(a.from, a.to, a.durationMs)
            else if (a.kind === 'key') await session.input.key(a.keycode)
            else await session.input.text(a.text)
          } catch (err) {
            send({
              type: 'session.failed',
              payload: {
                deviceId: msg.payload.deviceId,
                code: 'input_failed',
                message: err instanceof Error ? err.message : String(err),
              },
            })
          }
          return
        }

        case 'job.dispatch': {
          const { jobId, deviceId, bundle, params } = msg.payload
          try {
            if (!bundle) throw new Error('bundle tidak disertakan (bundleUrl belum didukung)')
            // Bundle ditulis ke disk agent supaya child process bisa mengimpornya.
            const bundlePath = `${deps.dataDir}/cache/job-${jobId}.mjs`
            await Bun.write(bundlePath, bundle)
            const result = await runner.execute({ id: jobId, deviceId, bundlePath, params })
            send({
              type: 'job.progress',
              payload: {
                jobId,
                kind: 'result',
                result: {
                  ok: result.ok,
                  ...(result.value !== undefined ? { value: result.value } : {}),
                  ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
                },
              },
            })
          } catch (err) {
            send({
              type: 'job.progress',
              payload: {
                jobId,
                kind: 'result',
                result: {
                  ok: false,
                  error: { code: 'RUNNER_FAILED', message: err instanceof Error ? err.message : String(err) },
                },
              },
            })
          }
          return
        }

        case 'job.cancel.forward':
          runner.abort(msg.payload.jobId, 'cancelled')
          return

        default:
          return
      }
    },

    async closeAll() {
      for (const unsub of frameUnsubs.values()) unsub()
      frameUnsubs.clear()
      await sessions.closeAll()
    },
  }
}
