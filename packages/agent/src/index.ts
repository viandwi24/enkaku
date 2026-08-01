import { AdbClient, type TrackerEvent } from '@enkaku/adb'
import type { DeviceInfo } from '@enkaku/protocol'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from '@enkaku/toolchain'
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
  let unsubscribe: (() => void) | null = null
  const devices = new Map<string, DeviceInfo>()

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
          onMessage: (msg) => {
            // session.start/stop & job.dispatch di-handle sub-fase berikutnya
            // (M8b/M8c) — di M8a cukup dicatat supaya jelas belum diimplement.
            log(`message dari control plane belum ditangani: ${msg.type}`)
          },
        },
        log,
      )
      tunnel.start()

      const tracker = adb.trackDevices()
      unsubscribe = tracker.on((ev: TrackerEvent) => {
        if (ev.kind === 'remove') devices.delete(ev.serial)
        // Probe identity/dimensi = tanggung jawab control plane di M8a;
        // agent mengirim apa yang terlihat dari track-devices.
        tunnel?.send({ type: 'agent.devices', payload: { devices: [...devices.values()] } })
      })
      await tracker.start()
      log('agent siap')
    },

    async stop() {
      unsubscribe?.()
      unsubscribe = null
      tunnel?.stop()
      tunnel = null
      await adb?.dispose()
      adb = null
    },
  }
}
