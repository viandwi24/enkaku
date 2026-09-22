import { eq } from 'drizzle-orm'
import {
  DevicePreparationSchema,
  type ActivityKind,
  type AgentStatus,
  type DeviceActivity,
  type DeviceUpdateComponent,
  type DeviceUpdateRow,
  type DeviceUpdatesResponse,
  type PreparationComponentStatus,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { loadDeviceNumbers } from '../registry/device-number'
import type { Logger } from '../util/logger'

/**
 * Devices → Update devices (0.2.74).
 *
 * Preparation installs what a phone LACKS on its own — the first time it connects, ui-server and
 * the guest agent go on without anyone asking. What it no longer does on its own is REPLACE a build
 * that is already there: a core upgrade used to reinstall both on every phone the moment it came
 * online, which on a seventy-phone farm is seventy uninstalls at once, each one killing whatever the
 * phone was doing. So a differing build is kept and used, and this module lists the phones that
 * carry one and updates them when an operator says so — a few at a time (`concurrency`), and never
 * a phone in the middle of a job.
 */

/** What an update waits for: anything an uninstall would break. A viewer's control session is not on the list — watching a phone is no reason to hold it back. */
const BUSY_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>(['job', 'workflow-job', 'install', 'transfer', 'network-apply'])

/** A finished row stays on the list this long, so the operator sees how it went. */
const FINISHED_TTL_MS = 10 * 60_000

export interface LatestBuilds {
  /** ui-server's pinned `versionCode`, or `null` when the manifest has none. */
  uiServer: number | null
  guestAgent: { versionCode: number | null; apkSha256: string | null }
}

/** The components of one device that differ from what this core ships. Pure. */
export function componentsToUpdate(input: {
  uiServer: PreparationComponentStatus | undefined
  agent: Pick<AgentStatus, 'state' | 'appVersion' | 'versionCode' | 'apkSha256'> | null
  latest: LatestBuilds
}): DeviceUpdateComponent[] {
  const out: DeviceUpdateComponent[] = []
  const ui = input.uiServer
  if (ui) {
    const latest = input.latest.uiServer
    const differs = latest !== null && ui.version !== null && ui.version !== String(latest)
    if (ui.state === 'outdated' || differs) {
      out.push({ id: 'ui-server', label: 'UI inspector (ui-server)', installed: ui.version, latest: latest === null ? null : String(latest) })
    }
  }
  const agent = input.agent
  if (agent && agent.state !== 'absent') {
    const { versionCode, apkSha256 } = input.latest.guestAgent
    const byVersion = versionCode !== null && agent.versionCode !== null && agent.versionCode !== versionCode
    const byBuild = versionCode === null && apkSha256 !== null && agent.apkSha256 !== null && agent.apkSha256 !== apkSha256
    if (agent.state === 'outdated' || byVersion || byBuild) {
      const installed = agent.appVersion ?? (agent.versionCode === null ? null : String(agent.versionCode))
      const latest = versionCode !== null ? String(versionCode) : apkSha256 !== null ? `local build ${apkSha256.slice(0, 8)}` : null
      out.push({ id: 'guest-agent', label: 'Guest agent', installed, latest })
    }
  }
  return out
}

/** What a queued row says while a phone's activity holds it back — an activity's own label can be a bare job id. */
export function waitingFor(activity: DeviceActivity): string {
  switch (activity.kind) {
    case 'job':
    case 'workflow-job':
      return 'Waiting for the job on this phone to finish'
    case 'install':
    case 'transfer':
      return 'Waiting for a file transfer to finish'
    default:
      return 'Waiting for a network change to finish'
  }
}

/** The first activity that holds an update back, or `null`. Pure. */
export function busyWith(activities: DeviceActivity[]): DeviceActivity | null {
  return activities.find((a) => BUSY_KINDS.has(a.kind)) ?? null
}

export interface DeviceUpdatesDeps {
  db: Db
  log: Logger
  /** How many devices update at once. */
  concurrency: number
  latest: () => Promise<LatestBuilds>
  agent: {
    status(deviceId: string): Promise<AgentStatus>
    ensure(deviceId: string, opts: { force: true; upgrade: true }): Promise<AgentStatus>
  }
  runner: { ensureComponent(deviceId: string, componentId: string, opts: { force: true; upgrade: true }): Promise<PreparationComponentStatus> }
  activities: (deviceId: string) => DeviceActivity[]
  /** How often a queue held back by busy phones looks again. */
  retryMs?: number
  now?: () => number
}

export interface DeviceUpdates {
  list(): Promise<DeviceUpdatesResponse>
  /** Queues the named devices, or every device with something to update. Returns how many were queued. */
  start(deviceIds?: string[]): Promise<number>
  stop(): void
}

interface Entry {
  state: 'queued' | 'running' | 'done' | 'failed'
  message: string | null
  components: DeviceUpdateComponent[]
  queuedAt: number
  finishedAt: number | null
}

export function createDeviceUpdates(deps: DeviceUpdatesDeps): DeviceUpdates {
  const now = deps.now ?? (() => Date.now())
  const retryMs = deps.retryMs ?? 5_000
  const entries = new Map<string, Entry>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function pending(): Promise<Array<{ id: string; label: string; components: DeviceUpdateComponent[] }>> {
    const latest = await deps.latest()
    const rows = deps.db.select({ id: devices.id, label: devices.label, status: devices.status, preparation: devices.preparation }).from(devices).all()
    const out: Array<{ id: string; label: string; components: DeviceUpdateComponent[] }> = []
    for (const row of rows) {
      if (row.status === 'offline') continue
      const prep = DevicePreparationSchema.safeParse(row.preparation ?? {})
      const agent = await deps.agent.status(row.id).catch(() => null)
      const components = componentsToUpdate({ uiServer: prep.success ? prep.data['ui-server'] : undefined, agent, latest })
      if (components.length > 0) out.push({ id: row.id, label: row.label, components })
    }
    return out
  }

  function running(): number {
    let n = 0
    for (const e of entries.values()) if (e.state === 'running') n++
    return n
  }

  function schedule(): void {
    if (timer || stopped) return
    timer = setTimeout(() => {
      timer = null
      pump()
    }, retryMs)
  }

  function pump(): void {
    if (stopped) return
    const queued = [...entries.entries()].filter(([, e]) => e.state === 'queued').sort((a, b) => a[1].queuedAt - b[1].queuedAt)
    let waiting = false
    for (const [id, entry] of queued) {
      if (running() >= deps.concurrency) {
        entry.message = `Waiting for a free slot (${deps.concurrency} at a time)`
        continue
      }
      const busy = busyWith(deps.activities(id))
      if (busy) {
        entry.message = waitingFor(busy)
        waiting = true
        continue
      }
      entry.state = 'running'
      entry.message = null
      void run(id, entry)
    }
    if (waiting) schedule()
  }

  async function run(id: string, entry: Entry): Promise<void> {
    const failures: string[] = []
    for (const component of entry.components) {
      entry.message = `Updating ${component.label}`
      try {
        if (component.id === 'ui-server') {
          const status = await deps.runner.ensureComponent(id, 'ui-server', { force: true, upgrade: true })
          if (status.state !== 'ready') failures.push(`${component.label}: ${status.reason ?? status.state}`)
        } else {
          const status = await deps.agent.ensure(id, { force: true, upgrade: true })
          if (status.state !== 'ready' && status.state !== 'consent-required') failures.push(`${component.label}: ${status.reason ?? status.state}`)
        }
      } catch (err) {
        failures.push(`${component.label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    entry.state = failures.length === 0 ? 'done' : 'failed'
    entry.message = failures.length === 0 ? null : failures.join(' · ')
    entry.finishedAt = now()
    deps.log.info(`device update ${id}: ${entry.state}${entry.message ? ` — ${entry.message}` : ''}`)
    pump()
  }

  return {
    async list() {
      const t = now()
      for (const [id, e] of entries) if (e.finishedAt !== null && t - e.finishedAt > FINISHED_TTL_MS) entries.delete(id)
      const numbers = loadDeviceNumbers(deps.db)
      const rows = new Map<string, DeviceUpdateRow>()
      for (const p of await pending()) {
        const e = entries.get(p.id)
        // A finished row that still differs failed to change it; one queued or running shows what it is doing.
        rows.set(p.id, { deviceId: p.id, label: p.label, number: null, components: e && e.state !== 'done' ? e.components : p.components, state: e && e.state !== 'done' ? e.state : 'idle', message: e && e.state !== 'done' ? e.message : null })
      }
      for (const [id, e] of entries) {
        if (rows.has(id)) continue
        const row = deps.db.select({ label: devices.label }).from(devices).where(eq(devices.id, id)).get()
        rows.set(id, { deviceId: id, label: row?.label ?? id, number: null, components: e.components, state: e.state, message: e.message })
      }
      const stable = new Map(deps.db.select({ id: devices.id, stableId: devices.stableId }).from(devices).all().map((r) => [r.id, r.stableId]))
      const out = [...rows.values()].map((r) => ({ ...r, number: numbers.get(stable.get(r.deviceId) ?? '') ?? null }))
      out.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label))
      let queued = 0
      for (const e of entries.values()) if (e.state === 'queued') queued++
      return { devices: out, concurrency: deps.concurrency, running: running(), queued }
    },

    async start(deviceIds) {
      const wanted = deviceIds ? new Set(deviceIds) : null
      let n = 0
      const t = now()
      for (const p of await pending()) {
        if (wanted && !wanted.has(p.id)) continue
        const e = entries.get(p.id)
        if (e && (e.state === 'queued' || e.state === 'running')) continue
        entries.set(p.id, { state: 'queued', message: null, components: p.components, queuedAt: t + n, finishedAt: null })
        n++
      }
      pump()
      return n
    },

    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
