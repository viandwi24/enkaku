import { AdbClient, type TrackerEvent } from '@enkaku/adb'
import type { DeviceInfo } from '@enkaku/protocol'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from '@enkaku/toolchain'
import { probeDeviceIdentity, type DeviceSnapshot } from '@enkaku/session'
import { createNodeHosts, type NodeHosts } from './hosts'
import { createTunnel, type Tunnel } from './tunnel'
import { enroll, loadState, saveState, type NodeState } from './state'

export { createTunnel, type Tunnel } from './tunnel'
export { enroll, loadState, saveState, type NodeState } from './state'

const NODE_VERSION = '0.0.1'

/**
 * The `kind` half of `DeviceInfo.connection` (plan 88 §3.1), observable from
 * the serial shape alone — the same split
 * `packages/core/src/registry/device-registry.ts`'s `deriveConnection` uses.
 * That function is core-only (deliberately): `medium` needs a configured
 * farm network, which is control-plane state a node never has. Reported
 * here purely to keep this `DeviceInfo` honest and schema-valid; the control
 * plane recomputes `connection` from `serial` itself when it persists this
 * report (`packages/core/src/tunnel/registry.ts`'s `syncDevices` only reads
 * `serial`, never `connection`), so `medium`/`mediumSource` are always
 * `null`/`'unknown'` here rather than guessed.
 */
function connectionFromSerial(serial: string): DeviceInfo['connection'] {
  const m = /^(\[[0-9a-fA-F:]+\]|[^\s:]+):(\d{1,5})$/.exec(serial)
  if (!m) return { kind: 'usb', medium: null, mediumSource: 'unknown', address: null, port: null, networkLabel: null }
  const hostRaw = m[1]!
  const host = hostRaw.startsWith('[') ? hostRaw.slice(1, -1) : hostRaw
  return { kind: 'tcp', medium: null, mediumSource: 'unknown', address: host, port: Number(m[2]), networkLabel: null }
}

/**
 * A mini-core for cloud mode (plan 11 §4.1): adb, toolchain, drivers, and
 * local sessions — with NO Studio, queue/scheduler, users, or script storage.
 * Scheduling and activity-admission decisions stay with the control plane; the node holds
 * the devices and runs the runner (close to the device means a fast inspector).
 */
export interface NodeOptions {
  dataDir: string
  controlPlaneUrl: string
  enrollToken?: string
  name?: string
  log?: (msg: string) => void
}

export interface Node {
  start(): Promise<void>
  stop(): Promise<void>
}

/** In-memory store: the node has no DB (tool state still lives on disk). */
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

export function createNode(opts: NodeOptions): Node {
  const log = opts.log ?? ((msg: string) => console.error(`[node] ${msg}`))
  let tunnel: Tunnel | null = null
  let adb: AdbClient | null = null
  let hosts: NodeHosts | null = null
  let unsubscribe: (() => void) | null = null
  const devices = new Map<string, DeviceInfo>()
  const snapshots = new Map<string, DeviceSnapshot>()

  return {
    async start() {
      let state: NodeState | null = await loadState(opts.dataDir)
      if (!state) {
        if (!opts.enrollToken) {
          throw new Error('the node is not enrolled: run it once with ENKAKU_ENROLL_TOKEN')
        }
        state = await enroll({
          controlPlaneUrl: opts.controlPlaneUrl,
          token: opts.enrollToken,
          name: opts.name ?? `node-${process.platform}`,
        })
        await saveState(opts.dataDir, state)
        log(`enrolled as ${state.nodeId}`)
      }

      // The toolchain matches the core exactly: adb and scrcpy-server are
      // provisioned automatically with sha256 verification.
      const toolchain = new ToolchainManager({
        dataDir: opts.dataDir,
        coreVersion: NODE_VERSION,
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

      const nodeLogger = {
        debug: (m: string) => log(m),
        info: (m: string) => log(m),
        warn: (m: string) => log(m),
        error: (m: string) => log(m),
        child() {
          return nodeLogger
        },
      }
      hosts = createNodeHosts({
        client: adb,
        toolchain,
        tunnel: () => tunnel,
        dataDir: opts.dataDir,
        log: nodeLogger,
      })

      tunnel = createTunnel(
        state,
        {
          onConnected: () => {
            tunnel?.send({
              type: 'node.hello',
              payload: { nodeVersion: NODE_VERSION, platform: `${process.platform}-${process.arch}`, toolVersions: {} },
            })
            // A full snapshot on every reconnect: the control plane never has
            // to guess what it missed while the tunnel was down.
            tunnel?.send({ type: 'node.devices', payload: { devices: [...devices.values()] } })
          },
          onDisconnected: (reason) => log(`tunnel disconnected: ${reason}`),
          onMessage: (msg) => void hosts?.handle(msg).catch((err) => log(`handling ${msg.type} failed: ${String(err)}`)),
          // The cloud adb endpoint's core→node direction (plan 28 §4.1) —
          // the first binary channel data to ever flow this way; video and
          // shell channels only ever go node→core.
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
            // Stable identity is probed on the node: the control plane has no adb.
            const probe = await probeDeviceIdentity(client, ev.serial).catch(() => null)
            if (!probe) return
            const snapshot: DeviceSnapshot = {
              id: probe.stableId,
              stableId: probe.stableId,
              serial: ev.serial,
              label: probe.model ?? probe.stableId,
              status: 'online',
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
              status: 'online',
              lastSeen: Math.floor(Date.now() / 1000),
              // Battery, quarantine, tags, and group are tracked by the
              // core, not the node — the node only reports the identity of
              // devices attached to it (plan 19 §4.2, plan 22.0 §4.4, renamed
              // by plan 207: the control plane owns tags and group membership).
              battery: null,
              quarantineReason: null,
              tags: [],
              group: null,
              // Crash detection's badge field (plan 37 §4.5) is populated
              // only by the control plane's own fleet list — the node has
              // no `device_events` table of its own to aggregate here.
              lastCrashAt: null,
              // Readiness (plan 43 §9 open question #2) is local-devices-only
              // in this plan — a node-owned device always reports the
              // schema's own default rather than a manager-derived value; the
              // control plane's readiness manager never touches a device this
              // node owns.
              readiness: { desired: 'asleep', actual: 'asleep', blocked: null, since: Math.floor(Date.now() / 1000) },
              // A device's live activities and its last-control tail (plan
              // 205 §4.10, replacing the old per-holder/secondary-operator
              // fields) are control-plane state, exactly like
              // battery/quarantine/tags/group above — the node only
              // reports device IDENTITY. The control plane's own device
              // registry (`tunnel/registry.ts`'s `syncDevices`) overwrites
              // the DB row's activity-independent columns from this
              // snapshot but never touches its live activities.
              activities: [],
              lastControl: null,
              connection: connectionFromSerial(snapshot.serial),
              // The guest agent's provisioning state (plan 90 §3.8, §4.3) is
              // local-core-only, exactly like readiness/activities above — a
              // node-owned (cloud) device reports the schema's own default
              // rather than a live value; nothing here provisions an agent
              // for a device a node owns.
              agent: 'absent',
              // The device number (plan 89 §3.1, §3.2) is control-plane
              // state, exactly like activities/agent above — `device_numbers` is
              // a core-only table this node has no access to, so a
              // node-owned device always reports `null` here. The control
              // plane's own `/api/devices` response is (today) also `null`
              // for a cloud device: `tunnel/registry.ts`'s `syncDevices`
              // inserts the row directly rather than through `admitDevice`
              // (the one path plan 89 §3.1 wires the allocator into), so no
              // reservation is ever created for it. That gap predates this
              // plan and is not this step's file allowlist to close.
              number: null,
            })
          }
          hosts?.updateDevices([...snapshots.values()])
          tunnel?.send({ type: 'node.devices', payload: { devices: [...devices.values()] } })
        })()
      })
      await tracker.start()
      log('node ready')
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
