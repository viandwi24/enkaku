import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { virtualDevices, type VirtualDeviceRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { nextFreeConsolePort } from './ports'
import { VmSpecSchema, type VmHandle, type VmProvider, type VmRecord, type VmSpec } from './types'

/**
 * The VM manager (plan 401 §4.4) — the one place a `virtual_devices` row is
 * created, started, stopped, removed, or adopted. It owns the boot-polling
 * loop and the in-memory `VmHandle` for each running VM; the handle is a
 * runtime field only and is never persisted (plan 400 D8, plan 401 §3.3).
 */

/** Every 2s, ask the emulator whether it finished booting. */
const BOOT_POLL_INTERVAL_MS = 2_000

/** How long a graceful stop waits before a kill. */
const STOP_GRACE_MS = 5_000

export interface VmManagerDeps {
  db: Db
  provider: VmProvider
  /** `getprop sys.boot_completed` against `emulator-<port>`, through the core's existing AdbClient. */
  shell: (serial: string, command: string) => Promise<string>
  probePort: (port: number) => Promise<boolean>
  maxConcurrent: () => number
  /** Seconds a cold boot may take before the VM is failed and the child stopped. Read live, not captured once. */
  bootTimeoutSec: () => number
  log: Logger
  now?: () => Date
  /** Test seam for the boot-poll interval — defaults to a real `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
}

export interface VmManager {
  list(): VmRecord[]
  create(spec: VmSpec): Promise<VmRecord>
  start(id: string): Promise<VmRecord>
  stop(id: string): Promise<VmRecord>
  remove(id: string): Promise<void>
  /** Plan 400 D8 — called once at boot. Never trusts a stored handle. */
  adopt(): Promise<void>
}

function rowToRecord(row: VirtualDeviceRow): VmRecord {
  return {
    id: row.id,
    name: row.name,
    state: row.state as VmRecord['state'],
    consolePort: row.consolePort,
    serial: `emulator-${row.consolePort}`,
    // Never `as`-cast a JSON column (CLAUDE.md) — re-validate on every read.
    spec: VmSpecSchema.parse(row.spec),
    message: row.message,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
  }
}

export function createVmManager(deps: VmManagerDeps): VmManager {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  /** Running child handles, keyed by row id. A runtime map only — never persisted. */
  const handles = new Map<string, VmHandle>()

  function getRow(id: string): VirtualDeviceRow {
    const row = deps.db.select().from(virtualDevices).where(eq(virtualDevices.id, id)).get()
    if (!row) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
    return row
  }

  function setRow(id: string, patch: Partial<VirtualDeviceRow>): VirtualDeviceRow {
    deps.db.update(virtualDevices).set(patch).where(eq(virtualDevices.id, id)).run()
    return getRow(id)
  }

  async function pollUntilBooted(id: string, serial: string): Promise<void> {
    const timeoutMs = deps.bootTimeoutSec() * 1000
    const deadline = now().getTime() + timeoutMs
    for (;;) {
      if (now().getTime() >= deadline) {
        const handle = handles.get(id)
        handle?.kill('SIGKILL')
        handles.delete(id)
        setRow(id, { state: 'failed', message: `boot did not complete within ${deps.bootTimeoutSec()}s` })
        return
      }
      let booted = false
      try {
        const out = await deps.shell(serial, 'getprop sys.boot_completed')
        booted = out.trim() === '1'
      } catch (err) {
        deps.log.debug(`vm ${id}: boot poll failed, retrying: ${String(err)}`)
      }
      if (booted) {
        setRow(id, { state: 'running', startedAt: now() })
        return
      }
      await sleep(BOOT_POLL_INTERVAL_MS)
    }
  }

  async function stopImpl(id: string): Promise<VmRecord> {
    setRow(id, { state: 'stopping' })
    const handle = handles.get(id)
    if (handle) {
      await deps.provider.stop(handle, STOP_GRACE_MS)
      handles.delete(id)
    }
    return rowToRecord(setRow(id, { state: 'stopped', message: null }))
  }

  return {
    list(): VmRecord[] {
      return deps.db.select().from(virtualDevices).all().map(rowToRecord)
    },

    async create(specInput: VmSpec): Promise<VmRecord> {
      const spec = VmSpecSchema.parse(specInput)
      const running = deps.db
        .select()
        .from(virtualDevices)
        .all()
        .filter((r) => r.state !== 'stopped' && r.state !== 'failed')
      const cap = deps.maxConcurrent()
      if (running.length >= cap) {
        throw new EnkakuError('E_VM_LIMIT', `${cap} virtual device(s) already running or in progress (ENKAKU_VM_MAX_CONCURRENT)`)
      }

      const taken = new Set(deps.db.select().from(virtualDevices).all().map((r) => r.consolePort))
      const consolePort = await nextFreeConsolePort({ taken, probe: deps.probePort })

      const id = crypto.randomUUID()
      const row: VirtualDeviceRow = {
        id,
        name: spec.name,
        state: 'creating',
        consolePort,
        spec,
        message: null,
        createdAt: now(),
        startedAt: null,
      }
      deps.db.insert(virtualDevices).values(row).run()

      try {
        await deps.provider.create(spec)
      } catch (err) {
        setRow(id, { state: 'failed', message: err instanceof Error ? err.message : String(err) })
        throw err
      }

      return rowToRecord(getRow(id))
    },

    async start(id: string): Promise<VmRecord> {
      const row = getRow(id)
      const spec = VmSpecSchema.parse(row.spec)
      setRow(id, { state: 'starting', message: null })

      const handle = await deps.provider.start(spec, row.consolePort)
      handles.set(id, handle)

      // `VmProvider.start` itself returns once spawned, not once booted (its own
      // contract) — the manager's `start` waits out the whole boot-poll loop so a
      // caller sees the terminal `running`/`failed` state directly.
      await pollUntilBooted(id, `emulator-${row.consolePort}`)

      return rowToRecord(getRow(id))
    },

    async stop(id: string): Promise<VmRecord> {
      return await stopImpl(id)
    },

    async remove(id: string): Promise<void> {
      const row = getRow(id)
      if (row.state === 'running' || row.state === 'starting') {
        await stopImpl(id)
      }
      const spec = VmSpecSchema.parse(getRow(id).spec)
      await deps.provider.destroy(spec)
      deps.db.delete(virtualDevices).where(eq(virtualDevices.id, id)).run()
    },

    async adopt(): Promise<void> {
      const rows = deps.db.select().from(virtualDevices).all()
      for (const row of rows) {
        if (row.state === 'stopped' || row.state === 'failed') continue
        if (row.state === 'creating') {
          setRow(row.id, { state: 'failed', message: 'the core restarted while this VM was being created' })
          continue
        }
        const live = await deps.probePort(row.consolePort)
        if (live) {
          setRow(row.id, { state: 'running', message: 'adopted after a core restart' })
        } else {
          setRow(row.id, { state: 'stopped', message: null })
        }
      }
    },
  }
}
