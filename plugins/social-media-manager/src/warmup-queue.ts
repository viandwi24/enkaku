import { isDeviceFree, type RouterDevice } from './posts'
import type { WarmupRow } from './warmup-rows'

/**
 * A warm-up run as a QUEUE with a fixed number of places (0.64.0).
 *
 * ## What it replaces
 *
 * Every row used to carry absolute times drawn when the run was made — phone A at 17:02:10, phone B
 * at 17:03:40 — and the router sent whatever had fallen due. That holds only on a farm whose phones
 * are all connected for the whole run, and the owner's is not: groups of twenty are plugged in and
 * out through the day. A phone that was offline since the morning had its whole schedule fall due
 * behind it, so the moment it came back it went at once; on 2026-09-21 eighteen phones of group PFB2
 * were plugged in at 17:53:54 and all eighteen started a warm-up at 17:54:13. There was no cap on how
 * many ran together — the start jitter was the only spread, and it had long since been spent.
 *
 * What the owner asked for instead: *"per kelompok misalnya 8 devices dulu jalan, kalau sudah satu
 * selesai first in first out … langsung lanjut lagi yang lain. jadi biar menjaga paralelnya"*.
 *
 * ## The rules
 *
 * - An **item** is one row — one phone's work for one phase. It is WAITING until the router lets it
 *   out of the queue (`admittedAt`), RUNNING while it is out and has work left, and OVER after.
 * - At most `maxParallel` items of a run are running at once.
 * - Items are let out in queue order — phase first, then the run's shuffled `queueSeq` — and one that
 *   cannot go (phone offline, busy, or its earlier phase not finished) is passed over without holding
 *   up the ones behind it.
 * - Two items never start closer together than a gap drawn from `startGapSec`, so eight free places
 *   are filled over minutes, not in one tick.
 * - A phone's later phase waits for its earlier one to finish, and then for a gap of its own.
 *
 * Letting an item out re-times its activities from NOW, keeping their gaps (`admitRow`). A phone
 * never inherits a backlog, however long it was away.
 *
 * Pure: no storage, no farm. `index.ts` reads, calls this, and writes.
 */

export const WARMUP_MAX_PARALLEL_DEFAULT = 8

/**
 * A phone this many drop-and-returns inside the core's window (10 min) is unsteady (0.64.0). A
 * phone on a good cable flaps rarely if ever — PFB1's twenty read 0 on 2026-09-21 — while one on a
 * failing hub read 17 to 25 in fifteen minutes. Three is well clear of both.
 */
export const UNSTABLE_FLAPS = 3

/** The status the router gives an unsteady phone for the tick, so every `online` test passes it over. */
export const UNSTABLE_STATUS = 'unstable'

export function isUnstable(device: { flaps?: { recent: number } | null }): boolean {
  return (device.flaps?.recent ?? 0) >= UNSTABLE_FLAPS
}
export const WARMUP_START_GAP_DEFAULT: readonly [number, number] = [20, 60]

export interface QueueSettings {
  maxParallel: number
  startGapSec: readonly [number, number]
}

/** What this module needs of a row — a structural subset of `WarmupRow`. */
export interface QueueStep {
  state: WarmupRow['steps'][number]['state']
  notBeforeAt: number
  startedAt?: number | null
  settledAt?: number | null
}

export interface QueueRow {
  deviceId: string
  phase: number
  steps: readonly QueueStep[]
  queueSeq?: number | null
  admittedAt?: number | null
  platform?: string | null
}

export type BlockReason = 'offline' | 'unstable' | 'busy' | 'earlier-phase' | 'held' | 'account'

/** Anything left for this row to do. */
export function hasWork(row: QueueRow): boolean {
  return row.steps.some((step) => step.state === 'pending' || step.state === 'queued')
}

/**
 * Has this row been let out of the queue?
 *
 * A row written before 0.64.0 has neither field. It counts as let out only while a job of its is
 * actually OUT; anything else it still owes goes through the queue like a new row. Counting every
 * row that had ever started as running would have put the owner's 73-phone run of 2026-09-21 —
 * dozens of half-done rows with retried steps — straight past the cap, the very burst this exists
 * to stop.
 */
export function isAdmitted(row: QueueRow): boolean {
  if (row.admittedAt !== undefined && row.admittedAt !== null) return true
  const legacy = row.queueSeq === undefined || row.queueSeq === null
  return legacy && row.steps.some((step) => step.state === 'queued')
}

export function isRunning(row: QueueRow): boolean {
  return isAdmitted(row) && hasWork(row)
}

export function isWaiting(row: QueueRow): boolean {
  return !isAdmitted(row) && hasWork(row)
}

/** When this row was let out: its own stamp, or — before 0.64.0 — its first activity's start. */
function admittedAtOf(row: QueueRow): number | null {
  if (row.admittedAt !== undefined && row.admittedAt !== null) return row.admittedAt
  const started = row.steps.map((step) => step.startedAt ?? null).filter((at): at is number => at !== null)
  return started.length === 0 ? null : Math.min(...started)
}

/** The order the queue lets rows out in. */
export function queueOrder<R extends QueueRow>(rows: readonly R[]): R[] {
  const earliest = (row: QueueRow): number => Math.min(...row.steps.filter((s) => s.state === 'pending').map((s) => s.notBeforeAt), Number.MAX_SAFE_INTEGER)
  return [...rows].sort(
    (a, b) =>
      a.phase - b.phase ||
      (a.queueSeq ?? Number.MAX_SAFE_INTEGER) - (b.queueSeq ?? Number.MAX_SAFE_INTEGER) ||
      earliest(a) - earliest(b) ||
      a.deviceId.localeCompare(b.deviceId),
  )
}

/**
 * A gap drawn from `range`, the same every time it is asked with the same `key`.
 *
 * The router asks every fifteen seconds; a gap drawn fresh each time would be a new number on every
 * tick, and the smallest of them would win. Keyed on the run and the count of items already let out,
 * it is one draw per start, stable across ticks and restarts, with no state to store.
 */
export function stableGap(range: readonly [number, number], key: string): number {
  const lo = Math.min(range[0], range[1])
  const hi = Math.max(range[0], range[1])
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return lo + Math.floor((h / 0x1_0000_0000) * (hi - lo + 1))
}

export interface AdmissionPlan<R> {
  /** Rows to let out this tick, in order. */
  admit: R[]
  running: number
  waiting: number
  /** Why each waiting row that could not go was passed over, by device. */
  blocked: Map<string, BlockReason>
  /** When the next start is allowed by the gap, or `null` when nothing holds it. */
  nextStartAt: number | null
}

/**
 * Which of ONE run's rows to let out this tick.
 *
 * `holding` are phones already given work that is not finished — an admitted row of any run, a job
 * out, a post this tick — so a phone never carries two warm-up items at once.
 */
export function planAdmissions<R extends QueueRow>(input: {
  rows: readonly R[]
  devices: ReadonlyMap<string, RouterDevice>
  holding: ReadonlySet<string>
  now: number
  settings: QueueSettings
  /** Stable per run: `groupId:runId`. */
  runKey: string
  /** Is this phone's device group paused within the run (`hold:` key)? Absent means none is. */
  held?: (deviceId: string) => boolean
  /** Does this row's account on its phone need a person (`account-status.ts`)? */
  accountBlocked?: (row: R) => boolean
}): AdmissionPlan<R> {
  const { rows, devices, now, settings, runKey } = input
  const holding = new Set(input.holding)
  const blocked = new Map<string, BlockReason>()
  let running = rows.filter(isRunning).length
  const waiting = queueOrder(rows.filter(isWaiting))
  const admit: R[] = []

  let started = rows.filter((row) => admittedAtOf(row) !== null).length
  let last = Math.max(0, ...rows.map((row) => admittedAtOf(row) ?? 0))
  let nextStartAt: number | null = null

  for (const row of waiting) {
    if (running >= Math.max(1, settings.maxParallel)) break
    const gap = stableGap(settings.startGapSec, `${runKey}:${started}`)
    if (last > 0 && now < last + gap) {
      nextStartAt = last + gap
      break
    }
    if (input.held?.(row.deviceId) === true) {
      blocked.set(row.deviceId, 'held')
      continue
    }
    if (input.accountBlocked?.(row) === true) {
      blocked.set(row.deviceId, 'account')
      continue
    }
    const device = devices.get(row.deviceId)
    if (!device || device.status !== 'online') {
      blocked.set(row.deviceId, device?.status === UNSTABLE_STATUS ? 'unstable' : 'offline')
      continue
    }
    if (holding.has(row.deviceId) || !isDeviceFree(device)) {
      blocked.set(row.deviceId, 'busy')
      continue
    }
    // A phone's later phase waits for its earlier ones to finish, then for a gap of its own.
    const earlier = rows.filter((other) => other.deviceId === row.deviceId && other.phase < row.phase)
    if (earlier.some(hasWork)) {
      blocked.set(row.deviceId, 'earlier-phase')
      continue
    }
    const settled = Math.max(0, ...earlier.flatMap((other) => other.steps.map((step) => step.settledAt ?? 0)))
    if (settled > 0 && now < settled + stableGap(settings.startGapSec, `${runKey}:${row.deviceId}:${row.phase}`)) {
      blocked.set(row.deviceId, 'earlier-phase')
      continue
    }
    admit.push(row)
    holding.add(row.deviceId)
    running += 1
    started += 1
    last = now
  }
  return { admit, running, waiting: waiting.length - admit.length, blocked, nextStartAt }
}

/**
 * Let a row out: stamp it, and re-time what it still owes from now, keeping the gaps between its
 * activities. Anything already answered keeps its stamps.
 */
export function admitRow<R extends QueueRow>(row: R, now: number): R {
  const pending = row.steps.filter((step) => step.state === 'pending')
  const earliest = Math.min(...pending.map((step) => step.notBeforeAt))
  const shift = pending.length === 0 ? 0 : now - earliest
  return {
    ...row,
    admittedAt: now,
    steps: row.steps.map((step) => (step.state === 'pending' ? { ...step, notBeforeAt: step.notBeforeAt + shift } : step)),
  }
}

/** A run's queue in numbers, for the page. */
export function queueCounts(rows: readonly QueueRow[]): { running: number; waiting: number; over: number } {
  let running = 0
  let waiting = 0
  let over = 0
  for (const row of rows) {
    if (isRunning(row)) running += 1
    else if (isWaiting(row)) waiting += 1
    else over += 1
  }
  return { running, waiting, over }
}

/**
 * A PHONE's place in its run, in words the page shows (0.64.0).
 *
 * One answer per phone, across its phases: what it is doing now, or why it is not. The page has no
 * router state to read, so this re-derives it from the same rows and the same order the router uses.
 * `busy` (a job of some other session on the phone) is the one thing it cannot see; such a phone
 * reads as queued, and the router passes over it until it is free.
 */
export type PhoneQueueStatus =
  | { kind: 'running'; phase: number }
  | { kind: 'queued'; position: number }
  | { kind: 'blocked'; reason: 'offline' | 'unstable' | 'resting' }
  | { kind: 'account'; platform: string }
  | { kind: 'held' }
  | { kind: 'ready' }
  | { kind: 'paused' }
  | { kind: 'done'; failed: number; skipped: number }

export function phoneQueueStatus(input: {
  deviceId: string
  /** Every row of the run — the position is counted across all of them. */
  rows: readonly QueueRow[]
  online: boolean
  /** Online, but dropping off and coming back too often to be sent anything (`isUnstable`). */
  unstable?: boolean
  run: 'ready' | 'paused' | 'running'
  held: boolean
  now: number
  startGapSec: readonly [number, number]
  runKey: string
  /** Platforms whose account on this phone needs a person. */
  accountBlocked?: ReadonlySet<string>
}): PhoneQueueStatus {
  const own = input.rows.filter((row) => row.deviceId === input.deviceId).sort((a, b) => a.phase - b.phase)
  const running = own.find(isRunning)
  if (running) return { kind: 'running', phase: running.phase }
  const next = own.find(isWaiting)
  if (!next) {
    const failed = own.reduce((n, row) => n + row.steps.filter((step) => step.state === 'failed').length, 0)
    const skipped = own.reduce((n, row) => n + row.steps.filter((step) => step.state === 'skipped').length, 0)
    return { kind: 'done', failed, skipped }
  }
  if (input.run === 'ready') return { kind: 'ready' }
  if (input.run === 'paused') return { kind: 'paused' }
  if (input.held) return { kind: 'held' }
  if (next.platform !== null && next.platform !== undefined && input.accountBlocked?.has(next.platform) === true) return { kind: 'account', platform: next.platform }
  if (!input.online) return { kind: 'blocked', reason: 'offline' }
  if (input.unstable === true) return { kind: 'blocked', reason: 'unstable' }
  const earlier = own.filter((row) => row.phase < next.phase)
  const settled = Math.max(0, ...earlier.flatMap((row) => row.steps.map((step) => step.settledAt ?? 0)))
  if (settled > 0 && input.now < settled + stableGap(input.startGapSec, `${input.runKey}:${input.deviceId}:${next.phase}`)) return { kind: 'blocked', reason: 'resting' }
  const order = queueOrder(input.rows.filter(isWaiting))
  return { kind: 'queued', position: order.indexOf(next) + 1 }
}
