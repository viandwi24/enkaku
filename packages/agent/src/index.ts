import { AdbClient, type TrackerEvent } from '@enkaku/adb'
import type { DeviceInfo } from '@enkaku/protocol'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from '@enkaku/toolchain'
import { probeDeviceIdentity, type DeviceSnapshot } from '@enkaku/session'
import { createAgentHosts, type AgentHosts } from './hosts'
import { createTunnel, type Tunnel } from './tunnel'
import { enroll, loadState, saveState, type AgentState } from './state'

export { createTunnel, type Tunnel } from './tunnel'
export { enroll, loadState, saveState, type AgentState } from './state'

const AGENT_VERSION = '0.0.1'

/**
 * Mini-core untuk mode cloud (plan 11 §4.1): adb + toolchain + driver +
 * sesi lokal, TANPA Studio, queue/scheduler, users, atau script storage.
 * Keputusan scheduling & lease tetap milik control plane; agent yang
 * memegang device dan menjalankan runner (dekat device = inspector cepat).
 */
export interface AgentOptions {
  dataDir: string
  controlPlaneUrl: string
  enrollToken?: string
  name?: string
  log?: (msg: string) => void
}

export interface Agent {
  start(): Promise<void>
  stop(): Promise<void>
}

/** Store in-memory: agent tidak punya DB (state tool tetap di disk). */
function createMemoryToolStore(): ToolInstallStore {
  const rows: ToolInstallRecord[] = []
  return {
    list: () => [...rows],
    listByTool: (toolId) => rows.filter((r) => r.toolId === toolId),
    insert: (rec) => void rows.push(rec),
    delete: (toolId, version) => {
      const idx = rows.findIndex((r) => r.toolId === toolId && r.version === version)
      if (idx >= 0) rows.splice(idx, 1)
    },
    setActive: (toolId, version) => {
      for (const r of rows) if (r.toolId === toolId) r.active = r.version === version
    },
  }
}

export function createAgent(opts: AgentOptions): Agent {
  const log = opts.log ?? ((msg: string) => console.error(`[agent] ${msg}`))
  let tunnel: Tunnel | null = null
  let adb: AdbClient | null = null
  let hosts: AgentHosts | null = null
  let unsubscribe: (() => void) | null = null
  const devices = new Map<string, DeviceInfo>()
  const snapshots = new Map<string, DeviceSnapshot>()

  return {
    async start() {
      let state: AgentState | null = await loadState(opts.dataDir)
      if (!state) {
        if (!opts.enrollToken) {
          throw new Error('agent belum ter-enroll: jalankan dengan ENKAKU_ENROLL_TOKEN sekali')
        }
        state = await enroll({
          controlPlaneUrl: opts.controlPlaneUrl,
          token: opts.enrollToken,
          name: opts.name ?? `agent-${process.platform}`,
        })
        await saveState(opts.dataDir, state)
        log(`ter-enroll sebagai ${state.agentId}`)
      }

      // Toolchain sama persis dengan core: adb & scrcpy-server ter-provision
      // otomatis dengan verifikasi sha256.
      const toolchain = new ToolchainManager({
        dataDir: opts.dataDir,
        coreVersion: AGENT_VERSION,
        store: createMemoryToolStore(),
        onLog: (_level, msg) => log(msg),
      })
      await toolchain.init()
      await toolchain.ensureRequiredTools(['adb'])

      adb = new AdbClient({ adbPath: await toolchain.resolveToolPath('adb'), onLog: (_l, m) => log(m) })
      await adb.ensureServer()
      await toolchain.ensureRequiredTools(['ui-server', 'ui-server-test', 'scrcpy-server']).catch((err) => {
        log(`tool opsional gagal di-provision: ${String(err)} — sebagian engine akan turun ke fallback`)
      })

      const agentLogger = {
        debug: (m: string) => log(m),
        info: (m: string) => log(m),
        warn: (m: string) => log(m),
        error: (m: string) => log(m),
        child() {
          return agentLogger
        },
      }
      hosts = createAgentHosts({
        client: adb,
        toolchain,
        tunnel: () => tunnel,
        dataDir: opts.dataDir,
        log: agentLogger,
      })

      tunnel = createTunnel(
        state,
        {
          onConnected: () => {
            tunnel?.send({
              type: 'agent.hello',
              payload: { agentVersion: AGENT_VERSION, platform: `${process.platform}-${process.arch}`, toolVersions: {} },
            })
            // Snapshot penuh tiap reconnect: control plane tidak perlu
            // menebak apa yang terlewat saat tunnel putus.
            tunnel?.send({ type: 'agent.devices', payload: { devices: [...devices.values()] } })
          },
          onDisconnected: (reason) => log(`tunnel terputus: ${reason}`),
          onMessage: (msg) => void hosts?.handle(msg).catch((err) => log(`handle ${msg.type} gagal: ${String(err)}`)),
        },
        log,
      )
      tunnel.start()

      const tracker = adb.trackDevices()
      const client = adb
      unsubscribe = tracker.on((ev: TrackerEvent) => {
        void (async () => {
          if (ev.kind === 'remove') {
            const gone = [...snapshots.values()].find((d) => d.serial === ev.serial)
            if (gone) {
              snapshots.delete(gone.id)
              devices.delete(gone.id)
            }
          } else if (ev.state === 'device') {
            // Probe identitas stabil di agent: control plane tidak punya adb.
            const probe = await probeDeviceIdentity(client, ev.serial).catch(() => null)
            if (!probe) return
            const snapshot: DeviceSnapshot = {
              id: probe.stableId,
              stableId: probe.stableId,
              serial: ev.serial,
              label: probe.model ?? probe.stableId,
              status: 'idle',
              androidVersion: probe.androidVersion,
              apiLevel: probe.apiLevel,
              screenW: probe.screenW,
              screenH: probe.screenH,
              transport: 'adb-usb',
              display: 'scrcpy',
              input: 'scrcpy-uhid',
              inspection: 'ui-server',
              preferredInputMode: 'uhid',
            }
            snapshots.set(snapshot.id, snapshot)
            devices.set(snapshot.id, {
              id: snapshot.id,
              stableId: snapshot.stableId,
              serial: snapshot.serial,
              label: snapshot.label,
              androidVersion: snapshot.androidVersion,
              apiLevel: snapshot.apiLevel,
              screenW: snapshot.screenW,
              screenH: snapshot.screenH,
              density: null,
              status: 'idle',
              lastSeen: Math.floor(Date.now() / 1000),
            })
          }
          hosts?.updateDevices([...snapshots.values()])
          tunnel?.send({ type: 'agent.devices', payload: { devices: [...devices.values()] } })
        })()
      })
      await tracker.start()
      log('agent siap')
    },

    async stop() {
      unsubscribe?.()
      unsubscribe = null
      await hosts?.closeAll()
      hosts = null
      tunnel?.stop()
      tunnel = null
      await adb?.dispose()
      adb = null
    },
  }
}
