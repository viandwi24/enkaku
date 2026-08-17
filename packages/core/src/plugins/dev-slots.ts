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
import type { PluginSurface, RuntimeEnvelope } from '@enkaku/protocol'

export interface DevSlotScript {
  /** The id inside the plugin bundle — `login`, not `tiktok/login`. */
  exportId: string
  paramsSchema: unknown
  /**
   * Plan 98 §3.1, §5 step 98.4 — a dev slot has no `scripts` row at all
   * (this file's own doc comment above), so THIS is the "row" a dev script's
   * runner compares its `ready` envelope against — the one legitimate case
   * where the bundle and the "row" are allowed to differ moment to moment
   * (a rebuild can change it), which is exactly why plan 98 §3.1 calls a dev
   * slot out by name as the reason the reconciliation warning exists at all.
   */
  runtime: RuntimeEnvelope | null
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
  /**
   * Plan 108 §5 step 108.6 — the screen this dev build contributes, already
   * re-validated by the verify child (`VerifyReport.surface`). A dev slot is
   * not a `plugins` row (this file's own doc comment above), so there is no
   * `manifest` column for it to ride in and it lives here instead. `null` for
   * a build that declares no surface — the ordinary case, and every build
   * before this plan.
   */
  surface: PluginSurface | null
  owner: DevSessionOwner
  /**
   * Plan 111 §5 step 111.6 — the key this slot's `ui/` assets are stored under
   * in the content-addressed asset store (`plugins/asset-store.ts`), which
   * keys everything else by a `plugins.id` UUID.
   *
   * A slot is deliberately never a database row (this file's own opening
   * comment), so it has no `plugins.id` to borrow — and it cannot key on the
   * plugin NAME either, because the store refuses anything that is not a UUID
   * this process minted (a caller-chosen string as a filename is the one thing
   * that module will not do). So the slot mints one, and keeps it across
   * rebuilds: a re-push REPLACES the assets under the same key rather than
   * leaking a new index file per keystroke.
   *
   * It is the runtime's job to delete what this key points at when the slot is
   * dropped or swept — the store owns bytes, this module owns none.
   */
  assetKey: string
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
  /** Optional so every caller written before plan 108 keeps compiling — omitted is `null`, "this build declares no screen". */
  surface?: PluginSurface | null
  owner: DevSessionOwner
  /**
   * Reuses an existing asset key rather than minting a fresh one — how the
   * runtime writes a rebuild's assets BEFORE replacing the slot (see
   * `DevSlot.assetKey`). Omitted keeps the current slot's key, or mints one.
   */
  assetKey?: string
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
        surface: input.surface ?? null,
        owner: input.owner,
        // Stable across rebuilds, exactly like `createdAt` above — a re-push
        // replaces what is stored under the key, it does not orphan it.
        assetKey: input.assetKey ?? existing?.assetKey ?? crypto.randomUUID(),
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
