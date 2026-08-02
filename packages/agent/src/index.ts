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
 * A mini-core for cloud mode (plan 11 §4.1): adb, toolchain, drivers, and
 * local sessions — with NO Studio, queue/scheduler, users, or script storage.
 * Scheduling and lease decisions stay with the control plane; the agent holds
 * the devices and runs the runner (close to the device means a fast inspector).
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

/** In-memory store: the agent has no DB (tool state still lives on disk). */
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
          throw new Error('the agent is not enrolled: run it once with ENKAKU_ENROLL_TOKEN')
        }
        state = await enroll({
          controlPlaneUrl: opts.controlPlaneUrl,
          token: opts.enrollToken,
          name: opts.name ?? `agent-${process.platform}`,
        })
        await saveState(opts.dataDir, state)
        log(`enrolled as ${state.agentId}`)
      }

      // The toolchain matches the core exactly: adb and scrcpy-server are
      // provisioned automatically with sha256 verification.
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
        log(`optional tool failed to provision: ${String(err)} — some engines will fall back`)
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
            // A full snapshot on every reconnect: the control plane never has
            // to guess what it missed while the tunnel was down.
            tunnel?.send({ type: 'agent.devices', payload: { devices: [...devices.values()] } })
          },
          onDisconnected: (reason) => log(`tunnel disconnected: ${reason}`),
          onMessage: (msg) => void hosts?.handle(msg).catch((err) => log(`handling ${msg.type} failed: ${String(err)}`)),
          // The cloud adb endpoint's core→agent direction (plan 28 §4.1) —
          // the first binary channel data to ever flow this way; video and
          // shell channels only ever go agent→core.
          onFrame: (channelId, payload) => hosts?.handleFrame(channelId, payload),
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
            // Stable identity is probed on the agent: the control plane has no adb.
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
              // Battery, quarantine, tags, and cluster are tracked by the
              // core, not the agent — the agent only reports the identity of
              // devices attached to it (plan 19 §4.2, plan 22.0 §4.4: the
              // control plane owns tags and cluster membership).
              battery: null,
              quarantineReason: null,
              tags: [],
              cluster: null,
            })
          }
          hosts?.updateDevices([...snapshots.values()])
          tunnel?.send({ type: 'agent.devices', payload: { devices: [...devices.values()] } })
        })()
      })
      await tracker.start()
      log('agent ready')
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
