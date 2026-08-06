/**
 * The dev slot (plan 82 §3.5, §4.2 "Dev slots are not rows"): at most one
 * per plugin name, holding a built bundle plus its verification report,
 * owned by a session — and deliberately NEVER a database row, so a dev
 * build cannot survive a core restart (criterion 19). An operator
 * restarting the farm gets the published state back, never a
 * half-finished pack from yesterday.
 *
 * Not a database-backed store; a plain in-memory map is the whole
 * implementation, and that absence of persistence is the feature.
 */

export interface DevSlotScript {
  /** The id inside the plugin bundle — `login`, not `tiktok/login`. */
  exportId: string
  paramsSchema: unknown
}

export interface DevSessionOwner {
  kind: 'workspace' | 'cli'
  /** A workspace path (`/scripts/tiktok`) or a `user@host` label for `enkaku dev` (§3.5). */
  label: string
}

export interface DevSlot {
  pluginName: string
  /** The version the source itself declares — no `+dev.N` suffix. */
  declaredVersion: string
  /** `declaredVersion` suffixed `+dev.<n>` (§3.6) — what a job pinned against a dev run actually records. */
  buildVersion: string
  buildN: number
  bundlePath: string
  scripts: DevSlotScript[]
  owner: DevSessionOwner
  createdAt: number
  lastBuildAt: number
  lastBuildOk: boolean
  lastError: string | null
  expiresAt: number
}

export interface PutDevSlotInput {
  pluginName: string
  declaredVersion: string
  bundlePath: string
  scripts: DevSlotScript[]
  owner: DevSessionOwner
  /** Overrides the default TTL for this put (mainly for tests). */
  ttlSec?: number
}

export interface DevSlotStore {
  /** Overwrites any existing slot for this plugin name (§3.5 "hot reload is slot replacement") — `buildN` increments across the plugin's lifetime in this slot, reset once the slot is dropped. */
  put(input: PutDevSlotInput): DevSlot
  /** Records a failed rebuild without dropping the slot — the last GOOD build stays runnable (matches §3.8's "a broken plugin never becomes active", applied to dev too). */
  putFailed(pluginName: string, error: string): void
  get(pluginName: string): DevSlot | null
  drop(pluginName: string): boolean
  list(): DevSlot[]
  /** Extends a slot's TTL (a CLI heartbeat, or any activity worth resetting the idle clock for). No-op if the slot does not exist. */
  touch(pluginName: string): void
  /** Drops every slot past its `expiresAt`. Returns how many were dropped. */
  sweep(): number
}

const DEFAULT_TTL_SEC = 30 * 60 // 30 min (§3.5 "front-end B")

export function createDevSlotStore(opts?: { ttlSec?: number; now?: () => number }): DevSlotStore {
  const ttlSec = opts?.ttlSec ?? DEFAULT_TTL_SEC
  const now = opts?.now ?? (() => Math.floor(Date.now() / 1000))
  const slots = new Map<string, DevSlot>()
  const buildCounters = new Map<string, number>()

  return {
    put(input) {
      const n = (buildCounters.get(input.pluginName) ?? 0) + 1
      buildCounters.set(input.pluginName, n)
      const existing = slots.get(input.pluginName)
      const t = now()
      const slot: DevSlot = {
        pluginName: input.pluginName,
        declaredVersion: input.declaredVersion,
        buildVersion: `${input.declaredVersion}+dev.${n}`,
        buildN: n,
        bundlePath: input.bundlePath,
        scripts: input.scripts,
        owner: input.owner,
        createdAt: existing?.createdAt ?? t,
        lastBuildAt: t,
        lastBuildOk: true,
        lastError: null,
        expiresAt: t + (input.ttlSec ?? ttlSec),
      }
      slots.set(input.pluginName, slot)
      return slot
    },

    putFailed(pluginName, error) {
      const existing = slots.get(pluginName)
      if (!existing) return
      existing.lastBuildAt = now()
      existing.lastBuildOk = false
      existing.lastError = error
    },

    get(pluginName) {
      return slots.get(pluginName) ?? null
    },

    drop(pluginName) {
      buildCounters.delete(pluginName)
      return slots.delete(pluginName)
    },

    list() {
      return [...slots.values()]
    },

    touch(pluginName) {
      const slot = slots.get(pluginName)
      if (slot) slot.expiresAt = now() + ttlSec
    },

    sweep() {
      const t = now()
      let dropped = 0
      for (const [name, slot] of slots) {
        if (slot.expiresAt <= t) {
          slots.delete(name)
          buildCounters.delete(name)
          dropped++
        }
      }
      return dropped
    },
  }
}
