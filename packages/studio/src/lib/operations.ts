'use client'

import { useSyncExternalStore } from 'react'
import {
  BatchesPageResponseSchema,
  CommandRunsPageResponseSchema,
  JobsPageResponseSchema,
  TransfersResponseSchema,
  type BatchInfo,
  type CommandRunSummary,
  type DeviceInfo,
  type JobInfo,
  type TransferKind,
  type TransferRecord,
} from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { fetchDevices } from './api'
import { ws } from './ws'

/**
 * Plan 107 (M72) §3.1–§3.4, §4, steps 107.3/107.4 — one shared, farm-wide
 * view of every long operation Studio can discover, read by `useOperations`
 * (below) and by `OperationTray` (`components/operations/OperationTray.tsx`)
 * plus the two dialogs that re-attach to a running one instead of offering a
 * fresh start (`InstallBatchDialog`, `BulkTransferDialog`, plan 107 §3.6,
 * step 107.5).
 *
 * §3.2's two classes, kept visibly distinct (`Operation.durable`):
 *
 * - **durable** — jobs, batches, command runs: already have a row and a list
 *   endpoint (`GET /api/jobs|batches|command-runs`), reload-safe. This file
 *   adds no new state for them — only reads the endpoints that already
 *   exist, per 107.4's own instruction.
 * - **ephemeral** — transfers (install/push/pull): `GET /api/transfers`
 *   (step 107.2) answers "what is this core process aware of right now",
 *   and forgets everything on a restart (see that file's own doc comment).
 *
 * Device preparation (plan 106) is the one G4 kind this file only partially
 * covers, stated rather than silently skipped: there is no farm-wide list
 * endpoint for it (only `GET /:id/preparation`, one device at a time), and
 * building one is out of this pass's scope (`packages/core/**` is another
 * agent's file allowlist for this plan, and 107.4 itself says "add no new
 * state"). The one farm-wide-visible signal that already exists —
 * `DeviceInfo.agent` (the guest agent's own `AgentState`, already returned
 * by `GET /api/devices`) — is used for a `'preparation'` tray entry while
 * `agent === 'provisioning'`. Every OTHER preparation component (plan 106
 * §3.2's open-ended registry) has no farm-wide signal to read at all, so it
 * never appears here; an operator still finds it on that device's own
 * popup. See plan 107 §9 for this recorded as an open item rather than a
 * silently partial claim.
 *
 * **Plan 106 §5 step 106.8 narrowed this gap for the ONE component that now
 * routes its install through the transfer machinery**: a `ui-server`
 * preparation pass appears here for free, as an ordinary `kind: 'transfer'`
 * row with `origin: 'preparation'` (`toTransferOperation`'s own comment
 * below) — `GET /api/transfers` is already farm-wide (§3.4), so no new
 * per-device fetch was needed for this ONE case. This is still not the
 * general farm-wide preparation summary the paragraph above describes: it
 * covers exactly the install PHASE of `ui-server`'s pass (the phase that now
 * has a transferId), never its verify-only phase, never any future
 * registered component that does not (yet) route through this same
 * machinery, and never the guest agent's own install (deliberately not
 * converted — plan 106 §9 Q5).
 *
 * ### §3.3 — subscription, never a restored farm-wide per-chunk broadcast
 *
 * `transfer.progress`/`transfer.done` are scoped server-side to VIEWERS of
 * the device (F27, closed by plan 93 step 93.9) — a farm-wide subscription
 * would restore exactly the fan-out that hotfix closed. This store never
 * asks for one. Discovery of a NEW ephemeral transfer (one this tab was not
 * already watching) comes from periodically re-reading the bounded,
 * snapshot-only `GET /api/transfers` list (`POLL_MS`, currently 5s) — cheap
 * and never per-chunk, matching §3.4's own description of that endpoint's
 * shape. LIVE byte-level progress for a transfer this store already knows
 * about is then carried by `transfer.progress`/`transfer.done`, reached by
 * sending `log.subscribe` for that ONE device's `input` stream — the exact
 * mechanism `TerminalPane.tsx` already uses to become a "viewer" for
 * `shell.echo`/`shell.result` (`ws-handlers.ts`'s `deviceTargets`, which
 * counts a `log.subscribe` the same as an open video session). Reusing an
 * already-audited per-device presence signal, rather than inventing a new
 * one, is deliberate — see that file's own comment for the precedent.
 *
 * `job.status`/`batch.status` are already broadcast farm-wide (unscoped) —
 * `AppShell.tsx`'s own sidebar counts already rely on this — so this store
 * reacts to them directly with no extra subscription. `command.*` events
 * are scoped like transfers (`commandTargets(runId)`, a stated exception in
 * `ws-handlers.ts`'s own comment), and this store does not subscribe to any
 * one run: command-run rows refresh on the same bounded poll as everything
 * else, so a running command's OWN counts can lag up to `POLL_MS` — an
 * accepted, bounded trade rather than a fifth kind of live subscription.
 */

// ---- Operation shape ----

export type OperationKind = 'transfer' | 'job' | 'batch' | 'command-run' | 'preparation'

export type OperationAction = 'install' | 'push' | 'pull'

export interface OperationCounts {
  ok: number
  failed: number
  skipped: number
  total: number
}

export interface OperationTransfer {
  sent: number
  total: number | null
  ok: boolean | null
  kind: TransferKind
}

export interface Operation {
  /** Stable, unique across every kind — `"<kind>:<id>"`. */
  key: string
  kind: OperationKind
  /**
   * False only for `kind: 'transfer'` — the one kind an in-memory registry
   * can forget on a core restart (plan 107 §3.2, §3.4). `OperationTray`
   * renders this distinctly rather than treating every row the same way —
   * §3.2's own rule: showing durable and ephemeral identically teaches a
   * reload rule that is false for half of them.
   */
  durable: boolean
  label: string
  deviceIds: string[]
  status: string
  /** Unix seconds. `0` when the source has no start time to report (a preparation entry — `DeviceInfo` carries no timestamp for it). */
  startedAt: number
  finishedAt: number | null
  /**
   * True once this operation has reached a status it will never leave —
   * success/failed/cancelled/expired for a job or a batch, ok/failed/
   * cancelled for a command run, `state: 'done'` for a transfer. Always
   * `false` for `kind: 'preparation'`, which has no terminal state of its
   * own to reach (it simply stops appearing once `DeviceInfo.agent` is no
   * longer `'provisioning'`). Governs `withinGrace` below — the owner's own
   * ask that a finished operation "otomatis hilang" (auto-dismisses) a few
   * seconds after showing, rather than never appearing at all (the old
   * behaviour) or sitting in the tray forever (the `stopping`-batch bug this
   * pass fixed on the core side).
   */
  terminal: boolean
  /**
   * Only meaningful when `terminal` — `null` otherwise. Governs HOW LONG a
   * terminal row stays visible (`SUCCESS_GRACE_MS` vs `SETTLED_GRACE_MS`,
   * below): a clean success is confirmed at a glance, while anything else
   * keeps its device names and counts on screen long enough to actually be
   * read.
   */
  succeeded: boolean | null
  /** Batch / command-run only — an `OutcomeSummary`-shaped rollup, rendered through that SAME component (plan 107's "reuse, do not reinvent"). */
  counts?: OperationCounts
  /** Transfer only — the point-in-time byte snapshot `GET /api/transfers` returns, refined live once this device is `log.subscribe`d. */
  transfer?: OperationTransfer
  /** Where to open the full surface, or `null` when there is none (a transfer has no page of its own; a command-run links to the console, not a specific run — see that file's own note). */
  href: string | null
  /**
   * `internal:install`/`internal:push`/`internal:pull` for a batch or an
   * ephemeral transfer that maps to one of those three actions — what
   * `operationMatchesAction` compares against. `null` for a job/command-run/
   * preparation entry, which can never match an install/push/pull re-attach
   * check.
   */
  actionScriptId: string | null
}

const ACTION_SCRIPT_ID: Record<OperationAction, string> = {
  install: 'internal:install',
  push: 'internal:push',
  pull: 'internal:pull',
}

const SCRIPT_ID_BY_TRANSFER_KIND: Record<TransferKind, string> = {
  install: ACTION_SCRIPT_ID.install,
  push: ACTION_SCRIPT_ID.push,
  pull: ACTION_SCRIPT_ID.pull,
}

const TRANSFER_LABEL: Record<TransferKind, string> = {
  install: 'Install apk',
  push: 'Push file',
  pull: 'Pull file',
}

export function operationMatchesAction(op: Operation, action: OperationAction): boolean {
  return op.actionScriptId === ACTION_SCRIPT_ID[action]
}

// ---- Target resolution (shared by the tray's reattach check and by whichever dialog asks) ----

export interface TargetLike {
  target: 'single' | 'cluster' | 'devices'
  deviceId: string
  deviceIds: readonly string[]
  clusterId: string
}

/** Mirrors just enough of `DeviceInfo` to resolve a cluster target without importing the whole schema twice. */
interface DeviceClusterRef {
  id: string
  cluster: { id: string } | null
}

/** A target picker's resolved selection, turned into a concrete device-id list — `'cluster'` reads the CURRENT membership from `pool`, never a cached count. */
export function resolveTargetDeviceIds(sel: TargetLike, pool: readonly DeviceClusterRef[]): string[] {
  if (sel.target === 'single') return sel.deviceId ? [sel.deviceId] : []
  if (sel.target === 'devices') return [...sel.deviceIds]
  return pool.filter((d) => d.cluster?.id === sel.clusterId).map((d) => d.id)
}

// ---- Re-attach (plan 107 §3.6, step 107.5) ----

export type ReattachOverlap = 'none' | 'partial' | 'full'

export interface ReattachResult {
  overlap: ReattachOverlap
  /**
   * Populated only when `overlap === 'full'` AND exactly one running/queued
   * operation accounts for the whole target — the one case a dialog can
   * silently re-attach to. Every other case (partial, or several operations
   * together covering a full target) is named instead, never merged
   * (§3.6: "say so explicitly and let the operator decide").
   */
  operation: Operation | null
  /** Every non-terminal operation of this action whose target intersects the requested set. */
  overlapping: Operation[]
}

const NONTERMINAL_OP_STATUS = new Set(['queued', 'running', 'pending'])

/**
 * Whether `targetDeviceIds` overlaps an already-running operation of
 * `action` — the check `InstallBatchDialog`/`BulkTransferDialog` run on
 * open, and again whenever the operator edits the target while the dialog
 * stays open. Pure, so it is tested directly (`operations.test.ts`) without
 * mounting either dialog.
 */
export function findReattach(operations: readonly Operation[], action: OperationAction, targetDeviceIds: readonly string[]): ReattachResult {
  if (targetDeviceIds.length === 0) return { overlap: 'none', operation: null, overlapping: [] }
  const running = operations.filter((op) => operationMatchesAction(op, action) && NONTERMINAL_OP_STATUS.has(op.status))
  const targetSet = new Set(targetDeviceIds)
  const overlapping = running.filter((op) => op.deviceIds.some((id) => targetSet.has(id)))
  if (overlapping.length === 0) return { overlap: 'none', operation: null, overlapping: [] }
  const covered = new Set(overlapping.flatMap((op) => op.deviceIds))
  const full = targetDeviceIds.every((id) => covered.has(id))
  if (full && overlapping.length === 1) return { overlap: 'full', operation: overlapping[0] ?? null, overlapping }
  return { overlap: full ? 'full' : 'partial', operation: null, overlapping }
}

// ---- Building the operation list from the raw fetched/patched pieces ----

export interface RawOperationsData {
  transfers: TransferRecord[]
  jobs: JobInfo[]
  batches: BatchInfo[]
  commandRuns: CommandRunSummary[]
}

export const EMPTY_RAW: RawOperationsData = { transfers: [], jobs: [], batches: [], commandRuns: [] }

/**
 * Which statuses of each kind are TERMINAL — mirrors each kind's own
 * protocol enum (`BatchStatusSchema`/`JobStatusSchema`/
 * `CommandRunStatusSchema`, `@enkaku/protocol`). Duplicated here rather than
 * imported from the core: the core's own single source of truth for "which
 * of these are terminal" (`clusters/status.ts`'s `TERMINAL_BATCH_STATUSES`)
 * is a server-internal export `packages/studio` cannot reach (00-overview
 * §4.1 — cross-package imports go through a package name, and
 * `packages/core` is not one Studio depends on). Drives `terminal`/
 * `succeeded` on the built `Operation` below, which `withinGrace` reads.
 */
const TERMINAL_BATCH = new Set<BatchInfo['status']>(['success', 'failed', 'cancelled'])
const TERMINAL_JOB = new Set<JobInfo['status']>(['success', 'failed', 'cancelled', 'expired'])
const TERMINAL_COMMAND_RUN = new Set<CommandRunSummary['status']>(['ok', 'failed', 'cancelled'])

/**
 * Plan 107 §1, this pass's own fix (`docs/plans/96-m61-hotfixes.md` §96.30;
 * `docs/plans/107-m72-long-running-operations.md` §5 step 107.7) — the
 * owner's own words: *"minimal yang lagi progress gitu yang muncul"*
 * (at minimum, only what's currently progressing should appear). A `queued`
 * batch has not started — nothing is happening on any device yet — so it is
 * excluded outright, never merely delayed by `withinGrace` below.
 *
 * Scoped to BATCHES specifically, not standalone jobs (`toJobOperation`
 * keeps every status, unchanged from plan 107 step 107.4's own deliberate
 * choice, still pinned by `operations.test.ts`'s "running/queued" case): a
 * `queued` batch is the one shape this investigation found can get stuck
 * non-terminal FOREVER at the core level — every one of a batch's job rows
 * can be deleted out from under it after creation (a forgotten device,
 * §96.30), and nothing re-derives a fresh `queued` batch's status again once
 * that happens. Excluding it here removes a whole class of staleness risk,
 * not just cosmetic noise. A standalone queued job carries no equivalent
 * risk — `device/lifecycle.ts`'s `forget` deletes the WHOLE job row, never
 * leaves an empty parent behind — so there is no forcing reason to revisit
 * that design here; changing it would also silently reverse a previous,
 * deliberate, tested decision outside this fix's own scope.
 */
function batchBelongsInTray(status: BatchInfo['status']): boolean {
  return status !== 'queued'
}

/**
 * How long a just-finished operation stays in the tray before it
 * auto-dismisses — the owner's own second ask: *"pas sukses/fail terus
 * beberapa detik setelahnya otomatis hilang"* (on success/fail, a few
 * seconds later it disappears on its own). A clean success is confirmed at
 * a glance; anything else (`failed`/`cancelled`/`expired`, or a transfer's
 * own `ok: false`) keeps the row — device names and outcome counts included
 * — on screen three times longer, on the general principle that a failure
 * needs more time to actually be read than a success needs to be noticed
 * (this codebase's own `OutcomeSummary`/`SkippedGroups` convention,
 * `docs/design.md`, already treats a non-clean outcome as needing MORE
 * surface, not less). Studio's own toasts (`components/ui/sonner.tsx`,
 * `sonner`'s shared default) do not vary duration by kind today, so this is
 * a new, deliberate distinction made specifically for the tray — justified
 * by a tray row carrying far more to read (device names, ok/failed/skipped
 * counts) than a toast's one line.
 */
const SUCCESS_GRACE_MS = 5_000
const SETTLED_GRACE_MS = 15_000

/**
 * Whether a terminal operation is still within its own dismiss window.
 * Always `true` for a non-terminal (still progressing) operation. No
 * `setTimeout`/`setInterval` anywhere in this file for this: `finishedAt`
 * is a wall-clock instant already on the operation, so "still within its
 * grace window" is recomputed fresh every time `buildOperations` runs — on
 * the store's own bounded poll and on every WS-triggered refresh
 * (`OperationsStore`, below) — rather than through a per-entry timer that
 * would need to be cleared on unmount and re-created on every re-render.
 * `finishedAt: null` on a terminal operation (should not happen for a real
 * row, but a defensive fixture or a not-yet-backfilled source could produce
 * one) hides it rather than showing it indefinitely — the safe default.
 */
function withinGrace(op: Pick<Operation, 'terminal' | 'succeeded' | 'finishedAt'>, nowMs: number): boolean {
  if (!op.terminal) return true
  if (op.finishedAt == null) return false
  const graceMs = op.succeeded ? SUCCESS_GRACE_MS : SETTLED_GRACE_MS
  return nowMs - op.finishedAt * 1000 < graceMs
}

function batchLabel(b: BatchInfo): string {
  if (b.scriptId === 'internal:install') return 'Install apk'
  if (b.scriptId === 'internal:push') return 'Push file'
  if (b.scriptId === 'internal:pull') return 'Pull file'
  return b.scriptName ?? b.scriptId
}

function toBatchOperation(b: BatchInfo, jobs: readonly JobInfo[]): Operation {
  const deviceIds = [...new Set(jobs.filter((j) => j.batchId === b.id).map((j) => j.deviceId))]
  const terminal = TERMINAL_BATCH.has(b.status)
  return {
    key: `batch:${b.id}`,
    kind: 'batch',
    durable: true,
    label: batchLabel(b),
    deviceIds,
    status: b.status,
    startedAt: b.createdAt,
    finishedAt: b.finishedAt,
    terminal,
    succeeded: terminal ? b.status === 'success' : null,
    counts: { ok: b.counts.success, failed: b.counts.failed, skipped: b.skipped.length, total: b.counts.total + b.skipped.length },
    href: `/batches/detail?id=${b.id}`,
    actionScriptId: b.scriptId,
  }
}

function toJobOperation(j: JobInfo): Operation {
  const terminal = TERMINAL_JOB.has(j.status)
  return {
    key: `job:${j.jobId}`,
    kind: 'job',
    durable: true,
    label: j.scriptName ?? j.scriptId,
    deviceIds: [j.deviceId],
    status: j.status,
    startedAt: j.createdAt,
    finishedAt: j.finishedAt,
    terminal,
    succeeded: terminal ? j.status === 'success' : null,
    href: `/jobs/detail?id=${j.jobId}`,
    actionScriptId: null,
  }
}

function toCommandRunOperation(r: CommandRunSummary): Operation {
  const deviceIds = 'deviceIds' in r.target ? r.target.deviceIds : []
  const terminal = TERMINAL_COMMAND_RUN.has(r.status)
  return {
    key: `command-run:${r.id}`,
    kind: 'command-run',
    durable: true,
    label: r.cmd,
    deviceIds,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    terminal,
    succeeded: terminal ? r.status === 'ok' : null,
    counts: { ok: r.counts.ok, failed: r.counts.failed, skipped: r.counts.skipped, total: r.counts.total },
    // `/console` has no per-run URL yet (that page's own scope, not this
    // plan's file allowlist) — still a real, useful destination: the run is
    // findable there from its own history.
    href: '/console',
    actionScriptId: null,
  }
}

/**
 * Plan 106 §5 step 106.8 — `t.origin === 'preparation'` is a transfer the
 * device-preparation runner started (`ui-server-component.ts`'s install),
 * never an operator's own `POST /:id/install`/`internal:install`/
 * `ctx.device.install`. Labelled distinctly ("Device preparation — Install
 * apk" vs a bare "Install apk") — the row's own `namesText` line already
 * names the device, so the label itself does not repeat it.
 *
 * `actionScriptId` is `null` for a preparation-origin row on purpose, NOT
 * `SCRIPT_ID_BY_TRANSFER_KIND[t.kind]` like an operator-origin one:
 * `findReattach` (§3.6) matches on `actionScriptId`, and a preparation
 * install is installing a DIFFERENT apk (the toolchain's own UI server) than
 * whatever an operator is trying to install on that same device — letting it
 * satisfy a re-attach check would hide the Install button and show the
 * WRONG operation's progress, the exact silent-merge §3.6 exists to prevent.
 */
function toTransferOperation(t: TransferRecord): Operation {
  const isPreparation = t.origin === 'preparation'
  const terminal = t.state === 'done'
  return {
    key: `transfer:${t.transferId}`,
    kind: 'transfer',
    durable: false,
    label: isPreparation ? `Device preparation — ${TRANSFER_LABEL[t.kind]}` : TRANSFER_LABEL[t.kind],
    deviceIds: [t.deviceId],
    status: t.state === 'running' ? 'running' : t.ok ? 'success' : 'failed',
    startedAt: t.startedAt,
    finishedAt: terminal ? t.updatedAt : null,
    terminal,
    succeeded: terminal ? t.ok === true : null,
    transfer: { sent: t.sent, total: t.total, ok: t.ok, kind: t.kind },
    href: null,
    actionScriptId: isPreparation ? null : SCRIPT_ID_BY_TRANSFER_KIND[t.kind],
  }
}

function toPreparationOperation(d: DeviceInfo): Operation {
  return {
    key: `preparation:${d.id}`,
    kind: 'preparation',
    durable: true,
    label: 'Guest agent — provisioning',
    deviceIds: [d.id],
    status: 'running',
    startedAt: 0,
    finishedAt: null,
    // Never terminal — this entry's own source (`DeviceInfo.agent`) carries
    // no finished state; it simply stops appearing once `agent` moves off
    // `'provisioning'`, one poll cycle later. Nothing for `withinGrace` to
    // decide here.
    terminal: false,
    succeeded: null,
    href: null,
    actionScriptId: null,
  }
}

/**
 * Every transfer NOT already accounted for by a non-terminal batch that
 * targets the same device for the same action — `internal:install`'s own
 * per-device job calls `runTransfer` too (plan 107 §3.4's "the one seam
 * every one of `runTransfer`'s nine call sites shares"), so a batch-driven
 * install would otherwise show TWICE: once as its own batch row, once more
 * per device as a raw transfer row. The batch row already carries the
 * aggregate outcome (`OutcomeSummary`); the redundant per-device transfer
 * rows would be exactly the noise §3.5 warns against, not extra signal.
 * Exported for its own unit test.
 */
export function visibleTransfers(raw: RawOperationsData): TransferRecord[] {
  const covered = new Set<string>()
  for (const b of raw.batches) {
    if (!batchBelongsInTray(b.status)) continue
    for (const j of raw.jobs) {
      if (j.batchId === b.id) covered.add(`${b.scriptId}:${j.deviceId}`)
    }
  }
  return raw.transfers.filter((t) => !covered.has(`${SCRIPT_ID_BY_TRANSFER_KIND[t.kind]}:${t.deviceId}`))
}

/**
 * Pure, exported for its own unit test (`operations.test.ts`) — no network,
 * no store. `nowMs` defaults to `Date.now()`, the same pattern
 * `lib/format.ts`'s `duration`/`relativeTime` already use, so every existing
 * call site keeps working unchanged while a test can inject a fixed clock.
 *
 * Jobs and command runs need no status filter at all beyond "is this row
 * even a candidate" (a standalone job / any command run): every status
 * either kind's own protocol enum defines is EITHER progressing or terminal
 * — `withinGrace` below is what actually decides whether a terminal one is
 * still shown. Batches are the one kind with a THIRD bucket, `queued`,
 * excluded outright by `batchBelongsInTray` (see its own comment) rather
 * than ever entering `withinGrace` at all.
 */
export function buildOperations(raw: RawOperationsData, devices: readonly DeviceInfo[], nowMs: number = Date.now()): Operation[] {
  const batchOps = raw.batches
    .filter((b) => batchBelongsInTray(b.status))
    .map((b) => toBatchOperation(b, raw.jobs))
    // Belt-and-suspenders for §96.30's own core-side fix: a REAL batch
    // always has >= 1 job row (`clusters/dispatch.ts`'s `createBatch`
    // inserts both atomically, in the same transaction) — `deviceIds: []`
    // here can only mean the exact defect this pass fixed on the core side
    // (every job row deleted out from under a still-open batch). Never
    // render a target-less "no device" row for one, whichever side reads it
    // first.
    .filter((op) => op.deviceIds.length > 0)
  const jobOps = raw.jobs.filter((j) => j.batchId === null).map(toJobOperation)
  const commandOps = raw.commandRuns.map(toCommandRunOperation)
  const transferOps = visibleTransfers(raw).map(toTransferOperation)
  const prepOps = devices.filter((d) => d.agent === 'provisioning').map(toPreparationOperation)
  return [...batchOps, ...jobOps, ...commandOps, ...transferOps, ...prepOps]
    .filter((op) => withinGrace(op, nowMs))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Which devices need a live `log.subscribe` right now — every device with a currently-RUNNING, not-batch-covered transfer (see `visibleTransfers`). */
export function wantedTransferSubscriptions(raw: RawOperationsData): Set<string> {
  return new Set(visibleTransfers(raw).filter((t) => t.state === 'running').map((t) => t.deviceId))
}

// ---- The shared store ----

const POLL_MS = 5000
const REFRESH_DEBOUNCE_MS = 300

export interface OperationsState {
  operations: Operation[]
  devices: DeviceInfo[]
  loading: boolean
}

const EMPTY_STATE: OperationsState = { operations: [], devices: [], loading: true }

/**
 * One shared, ref-counted subscription — every `useOperations()` caller
 * (the tray, plus any dialog checking for a re-attach) reads the SAME
 * underlying fetch/poll/subscribe lifecycle rather than each starting its
 * own. Modelled on `WsClient`'s own singleton shape (`lib/ws.ts`): `start()`
 * on the first subscriber, `stop()` (clearing every timer and every
 * `log.subscribe`) on the last one leaving, so a page with no dialog and no
 * tray mounted costs nothing.
 */
export class OperationsStore {
  private state: OperationsState = EMPTY_STATE
  private raw: RawOperationsData = EMPTY_RAW
  private listeners = new Set<() => void>()
  private refCount = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null
  private offWs: (() => void) | null = null
  private subscribedDeviceIds = new Set<string>()

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    this.refCount += 1
    if (this.refCount === 1) this.start()
    return () => {
      this.listeners.delete(cb)
      this.refCount -= 1
      if (this.refCount === 0) this.stop()
    }
  }

  getSnapshot = (): OperationsState => this.state

  getServerSnapshot = (): OperationsState => EMPTY_STATE

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  private start(): void {
    this.offWs = ws.on((msg) => {
      if (msg.type === 'job.status' || msg.type === 'batch.status' || msg.type === 'device.added' || msg.type === 'device.removed' || msg.type === 'device.status') {
        this.scheduleRefresh()
      } else if (msg.type === 'transfer.progress' && this.subscribedDeviceIds.has(msg.payload.deviceId)) {
        this.patchTransferProgress(msg.payload)
      } else if (msg.type === 'transfer.done' && this.subscribedDeviceIds.has(msg.payload.deviceId)) {
        this.patchTransferDone(msg.payload)
      }
    })
    void this.refresh()
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS)
  }

  private stop(): void {
    this.offWs?.()
    this.offWs = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce)
    this.refreshDebounce = null
    for (const id of this.subscribedDeviceIds) ws.send({ type: 'log.unsubscribe', payload: { deviceId: id } })
    this.subscribedDeviceIds = new Set()
    this.raw = EMPTY_RAW
    this.state = EMPTY_STATE
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounce) return
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null
      void this.refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  private async refresh(): Promise<void> {
    const [transfersRes, jobsRes, batchesRes, commandRunsRes, devices] = await Promise.all([
      api('/api/transfers', TransfersResponseSchema).catch(() => ({ transfers: this.raw.transfers })),
      api('/api/jobs?limit=200', JobsPageResponseSchema).catch(() => ({ items: this.raw.jobs })),
      api('/api/batches?limit=50', BatchesPageResponseSchema).catch(() => ({ items: this.raw.batches })),
      api('/api/command-runs?limit=50', CommandRunsPageResponseSchema).catch(() => ({ items: this.raw.commandRuns })),
      fetchDevices().catch(() => this.state.devices),
    ])
    this.raw = { transfers: transfersRes.transfers, jobs: jobsRes.items, batches: batchesRes.items, commandRuns: commandRunsRes.items }
    this.applyDeviceSubscriptions()
    this.state = { operations: buildOperations(this.raw, devices), devices, loading: false }
    this.notify()
  }

  private applyDeviceSubscriptions(): void {
    const wanted = wantedTransferSubscriptions(this.raw)
    for (const id of wanted) {
      if (!this.subscribedDeviceIds.has(id)) ws.send({ type: 'log.subscribe', payload: { deviceId: id, streams: ['input'] } })
    }
    for (const id of this.subscribedDeviceIds) {
      if (!wanted.has(id)) ws.send({ type: 'log.unsubscribe', payload: { deviceId: id } })
    }
    this.subscribedDeviceIds = wanted
  }

  private patchTransferProgress(payload: { deviceId: string; transferId: string; kind: TransferKind; sent: number; total: number | null }): void {
    const now = Math.floor(Date.now() / 1000)
    const idx = this.raw.transfers.findIndex((t) => t.transferId === payload.transferId)
    const transfers = [...this.raw.transfers]
    if (idx === -1) {
      transfers.push({
        transferId: payload.transferId,
        deviceId: payload.deviceId,
        kind: payload.kind,
        state: 'running',
        startedAt: now,
        updatedAt: now,
        // `transfer.progress`'s WS payload deliberately never carries
        // `origin` (plan 106 §5 step 106.8's own comment in
        // `transfer-dispatch.ts` — it is a registry-only fact, not put on
        // the wire). `'operator'` is the schema's own default and the
        // correct guess for the overwhelmingly common case (this synthetic
        // entry only exists because a tick arrived for a transferId the last
        // poll had not seen yet) — corrected within one `POLL_MS` either way,
        // once `GET /api/transfers` reports the real value.
        origin: 'operator',
        sent: payload.sent,
        total: payload.total,
        ok: null,
        error: null,
      })
    } else {
      const existing = transfers[idx]
      if (existing) transfers[idx] = { ...existing, sent: payload.sent, total: payload.total, updatedAt: now }
    }
    this.raw = { ...this.raw, transfers }
    this.state = { ...this.state, operations: buildOperations(this.raw, this.state.devices) }
    this.notify()
  }

  private patchTransferDone(payload: { deviceId: string; transferId: string; kind: TransferKind; ok: boolean; error?: string }): void {
    const idx = this.raw.transfers.findIndex((t) => t.transferId === payload.transferId)
    // Never saw a `transfer.progress` for it (a fast transfer) — nothing to
    // patch; the next poll picks it up from the registry's own retention
    // window if it is still there.
    if (idx === -1) return
    const now = Math.floor(Date.now() / 1000)
    const transfers = [...this.raw.transfers]
    const existing = transfers[idx]
    if (existing) transfers[idx] = { ...existing, state: 'done', ok: payload.ok, error: payload.error ?? null, updatedAt: now }
    this.raw = { ...this.raw, transfers }
    this.state = { ...this.state, operations: buildOperations(this.raw, this.state.devices) }
    this.notify()
    // A finished transfer no longer needs a live subscription for its
    // device — re-evaluate immediately rather than waiting for the next
    // poll or an unrelated WS event.
    this.applyDeviceSubscriptions()
  }
}

/** The one instance every `useOperations()` call reads — see the class doc comment for why a singleton, not one store per caller. */
export const operationsStore = new OperationsStore()

export interface UseOperationsResult {
  operations: Operation[]
  devices: DeviceInfo[]
  loading: boolean
  deviceLabel: (id: string) => string
}

/**
 * Plan 107 §3.1, §4, step 107.3 — "one hook, mounted once at the shell,
 * that reads the endpoint on mount and then follows WS events." `OperationTray`
 * is the one component that mount is meant for; this hook is also called
 * directly by `InstallBatchDialog`/`BulkTransferDialog` for their own
 * re-attach check (step 107.5) — safe because the underlying fetch/poll/
 * subscribe lifecycle is the shared singleton above, ref-counted, not
 * duplicated per caller.
 */
export function useOperations(store: OperationsStore = operationsStore): UseOperationsResult {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  const deviceLabel = (id: string): string => state.devices.find((d) => d.id === id)?.label ?? id
  return { operations: state.operations, devices: state.devices, loading: state.loading, deviceLabel }
}
