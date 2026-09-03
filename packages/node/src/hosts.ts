import type { AdbClient } from '@enkaku/adb'
import { encodeTunnelFrame, type ControlToNode } from '@enkaku/protocol'
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
import { createAdbRawHost } from './adb-raw'
import { createClipboardHost } from './clipboard'
import { createShellHost } from './shell'
import type { Tunnel } from './tunnel'

/** Size limit for artifacts sent inline as base64 inside JSON. */
const INLINE_ARTIFACT_LIMIT = 256 * 1024

export interface NodeHosts {
  handle(msg: ControlToNode): Promise<void>
  /** Inbound binary tunnel frame (plan 28 §4.1) — the cloud adb endpoint's `adb-raw` channels are the first thing on the node side that needs core→node frame data; video/shell channels only ever flow the other way. */
  handleFrame(channelId: number, payload: Uint8Array): void
  /** The devices the node can see — the data source for sessions. */
  updateDevices(list: DeviceSnapshot[]): void
  closeAll(): Promise<void>
}

/**
 * Handling control-plane commands on the node side (plan 12 §4.3):
 * `session.start/stop`, `input.forward`, `job.dispatch`, `job.cancel.forward`.
 *
 * Every policy decision (control activities, busy status, queue priority) was already made
 * by the control plane before a message reaches here. The node re-checks only
 * what it alone knows — the device is still present, the session still alive —
 * as a second layer, never as a competing policy.
 */
export function createNodeHosts(deps: {
  client: AdbClient
  toolchain: ToolchainManager
  tunnel: () => Tunnel | null
  dataDir: string
  log: Logger
}): NodeHosts {
  const devices = new Map<string, DeviceSnapshot>()
  const source: DeviceSnapshotSource = { get: (id) => devices.get(id) ?? null }
  const ports = new PortAllocator(parsePortRange(process.env.ENKAKU_UI_SERVER_PORT_RANGE))
  /** deviceId → the video channelId the control plane opened. */
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
        {
          toolchain: deps.toolchain,
          ports,
          log: deps.log.child('inspector'),
          hostAdb,
          // The forward/listForward/killForward trio (plan 119 §4.1, §4.2),
          // bound to this node's own adb client — off the `adb.exe`
          // process-spawn path the old `hostAdb(['forward', ...])` calls used
          // before this plan, same as the core's local wiring in `daemon.ts`.
          forward: (serial, local, remote) => deps.client.forward(serial, local, remote),
          listForward: () => deps.client.listForward(),
          killForward: (serial, local) => deps.client.killForward(serial, local),
          // The Plan 24 streaming lane, bound to this node's own adb client
          // (plan 34 §4.1) — same as the core's local wiring in `daemon.ts`.
          execStream: (serial, cmd, streamOpts) => deps.client.execStream(serial, cmd, streamOpts),
        },
        { deviceId, transport, requested },
      ),
    makeScrcpy: async (deviceId, transport, profile) => {
      const jarPath = await deps.toolchain.resolveToolPath('scrcpy-server').catch(() => null)
      if (!jarPath) return null
      const port = await ports.claim(`scrcpy:${deviceId}`)
      // The Wall's low-rate profile (Plan 42 §3.5, §4.5) — not reachable
      // today over the tunnel (the control-plane side does not send a
      // `quality` yet), but the node's own SessionManager already honours
      // it, so this stays correct rather than silently ignoring the param.
      // `profile` (plan 92 §3.5, §4.2) is already resolved by
      // `createSession`'s own fallback — the node has no farm settings
      // store to supply `SessionManagerDeps.resolveProfile` (00-overview.md
      // §4.1's `node` boundary), so this is always the schema-default
      // profile for whichever quality was requested: byte-identical to the
      // pre-plan-92 `QUALITY_PROFILES` constants.
      return startScrcpySession(
        { serial: transport.serial, exec: (cmd) => transport.exec(cmd, { profile: 'default' }).then((r) => r.stdout), hostAdb },
        {
          jarPath,
          port,
          maxSize: profile.maxSize,
          maxFps: profile.maxFps,
          bitRate: profile.bitRate,
          onLog: (level, msg) => deps.log.child('scrcpy')[level](msg),
        },
      )
    },
  })

  const send = (msg: Parameters<NonNullable<ReturnType<typeof deps.tunnel>>['send']>[0]) => deps.tunnel()?.send(msg)

  // The Monitor tab's cloud parity (plan 25 §4.4): `shell.exec.request` and
  // `shell.stream.request` run through the SAME `AdbClient` the local session
  // work already uses — nothing adb-specific is different for a cloud device.
  const shellHost = createShellHost({
    client: deps.client,
    devices: source,
    send,
    sendFrame: (channelId, payload) => deps.tunnel()?.sendFrame(channelId, payload),
    bufferedAmount: () => deps.tunnel()?.bufferedAmount() ?? 0,
    log: deps.log.child('shell'),
  })

  // The clipboard's cloud parity (plan 38 §4.5): rides the SAME
  // `SessionManager` the video/input path already builds — a device's
  // `DeviceSession.clipboard` already knows whether to use scrcpy's real
  // round trip or the adb fallback, so nothing clipboard-specific differs
  // for a cloud device here either.
  const clipboardHost = createClipboardHost({ sessions, send })

  // The cloud adb endpoint's node side (plan 28 §4.3): `AdbClient.openRaw`
  // against the SAME `AdbClient` shell/session work already uses — nothing
  // adb-specific differs for a cloud device here either.
  const adbRawHost = createAdbRawHost({
    client: deps.client,
    devices: source,
    send,
    sendFrame: (channelId, payload) => deps.tunnel()?.sendFrame(channelId, payload),
    log: deps.log.child('adb-raw'),
  })

  /** Artifacts are sent to the control plane, not stored on the node. */
  const artifactSink = (jobId: string): ArtifactSink => ({
    async save({ kind, label, data, ext }) {
      // Plan 115 §3.6 — `SavedArtifact.id` is required (it is what
      // `ctx.artifact.file()` hands back to the script), but the REAL row
      // for a node-owned device is only minted once the control plane
      // processes the `job.progress` artifact message below — there is no
      // synchronous round trip here to learn that id. This local id keeps
      // the contract type-honest (never `undefined`, never a cast) without
      // pretending to be the control plane's own row: a script that then
      // calls `ctx.device.push({ artifactId })` for a node-owned device gets
      // an honest "not found" from the control plane rather than silently
      // doing nothing. Giving a node-owned device job the SAME id the
      // control plane assigns is a real gap this step does not close — it
      // would need an acknowledgement round trip over the tunnel, which is
      // out of scope here (plan 115 §3.6 only covers the local/core path).
      const id = crypto.randomUUID()
      if (data.length > INLINE_ARTIFACT_LIMIT) {
        // Large artifacts take the binary channel so they do not clog the JSON.
        const channel = videoChannels.get(`artifact:${jobId}`)
        if (channel !== undefined) {
          deps.tunnel()?.sendFrame(channel, data)
        } else {
          deps.log.warn(`artifact "${label}" (${data.length}B) exceeds the inline limit and no binary channel is open`)
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
      // The real path is decided by the control plane when it stores the file.
      return { id, path: `remote/${jobId}/${label}`, sizeBytes: data.length }
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
      // Already sent by artifactSink at save time.
    },
    onPhase: (jobId, attempt, phase) =>
      send({ type: 'job.progress', payload: { jobId, kind: 'phase', phase, attempt } }),
    heartbeat: () => {
      // The control plane owns the job heartbeat; every job.progress doubles as one.
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
      // Stream frames into the video channel the control plane opened.
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
      deps.log.warn(`session.start failed for ${deviceId}: ${message}`)
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
          // Defence in depth (plan 25 §4.5, plan 28 §4.3): if the control
          // plane ever closes a `shell`/`adb-raw` channel without going
          // through `shell.stream.stop`/`adb.close` first, the stream
          // feeding it must not become an orphaned process — or an orphaned
          // smartsocket connection — on the device.
          shellHost.channelClosed(msg.payload.channelId)
          adbRawHost.channelClosed(msg.payload.channelId)
          return
        }

        case 'shell.exec.request':
          await shellHost.execRequest(msg)
          return

        case 'shell.stream.request':
          await shellHost.streamRequest(msg)
          return

        case 'shell.stream.stop':
          shellHost.streamStop(msg.payload)
          return

        case 'clipboard.get.request':
          await clipboardHost.getRequest(msg)
          return

        case 'clipboard.set.request':
          await clipboardHost.setRequest(msg)
          return

        case 'adb.open.request':
          await adbRawHost.openRequest(msg)
          return

        case 'adb.close':
          adbRawHost.close(msg.payload)
          return

        case 'input.forward': {
          const session = sessions.get(msg.payload.deviceId)
          if (!session) {
            send({
              type: 'session.failed',
              payload: { deviceId: msg.payload.deviceId, code: 'no_session', message: 'no active session' },
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
          const { jobId, deviceId, bundle, params, scriptExportId } = msg.payload
          try {
            if (!bundle) throw new Error('no bundle was included (bundleUrl is not supported yet)')
            // The bundle is written to the node's disk so the child process can import it.
            const bundlePath = `${deps.dataDir}/cache/job-${jobId}.mjs`
            await Bun.write(bundlePath, bundle)
            // `scriptExportId` (plan 82 §3.2) selects which member of a plugin
            // bundle to run — undefined for a bundle with no `scripts` array, exactly the
            // same optional field the local executor threads through.
            const result = await runner.execute({ id: jobId, deviceId, bundlePath, params, ...(scriptExportId ? { scriptExportId } : {}) })
            send({
              type: 'job.progress',
              payload: {
                jobId,
                kind: 'result',
                result: {
                  ok: result.ok,
                  ...(result.value !== undefined ? { value: result.value } : {}),
                  ...(result.error
                    ? { error: { code: result.error.code, message: result.error.message, phase: result.error.phase } }
                    : {}),
                  // Plan 97 §3.3, §4.3, F6 — the same verdict `JobRunner.execute()`
                  // now carries locally, mirrored over the tunnel.
                  ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
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

    handleFrame(channelId, payload) {
      // Only `adb-raw` channels ever carry a core→node frame today (plan 28
      // §4.1) — video and shell channels are node→core only, so there is
      // nothing else to route this to.
      adbRawHost.handleFrame(channelId, payload)
    },

    async closeAll() {
      for (const unsub of frameUnsubs.values()) unsub()
      frameUnsubs.clear()
      await shellHost.closeAll()
      await adbRawHost.closeAll()
      await sessions.closeAll()
    },
  }
}
