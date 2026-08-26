import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Combobox,
  DeviceName,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  formatDeviceName,
  matchesDeviceQuery,
  useAction,
} from '@enkaku/ui'
import { DEFAULT_GROUP_ID } from '../../shared'
import {
  clearAssignment,
  fetchFleet,
  isRefusal,
  previewApplyPlan,
  runApply,
  saveAssignment,
  type ApplyResult,
  type FleetDeviceRow,
  type Path,
  type PathHealth,
  type PlanPreviewResult,
  type PlanRow,
  type StoredAssignment,
} from './api'
import { isFirstLoad, pathOptions, useLoader, UNASSIGNED_PATH } from './bits'
import { buildPairings, type BulkPairing, type PairingNote, type PairingRow } from './bulk-builder'

/**
 * Assignments — the owner's stated goal, step 122.6: a device is assigned to
 * a modem from Studio, and the router is the only thing that changes.
 *
 * Two acts, deliberately kept apart (`apply.ts`'s own header): choosing a
 * path or typing a manual LAN IP writes a NOTE (the `assignment` KV, plain
 * and device-scoped) and changes nothing on the router; "Preview & apply"
 * computes and shows the exact §4.4 diff, and only Confirm inside that dialog
 * ever reaches the router.
 *
 * Stage 2 only — every assignment made here lives in the implicit `default`
 * group (§9 Q1); named groups that activate/deactivate as a unit are
 * 122.7/122.8's job, not this one's.
 */

/**
 * The "no path at all" sentinel. Moved to `bits.tsx` (as `UNASSIGNED_PATH`)
 * in plan 124 step 124.7 so the group editor's picker and this one agree on
 * it; kept aliased here because this file reads it a dozen times and `NONE`
 * is what those reads have always said.
 */
const NONE = UNASSIGNED_PATH

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function looksLikeIpv4(value: string): boolean {
  const match = IPV4_RE.exec(value.trim())
  if (!match) return false
  return match.slice(1).every((octet) => Number(octet) <= 255)
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * The one place a `StoredAssignment` write is built from a device row and a
 * target path — factored out of `assignPath` (step 122.6's original body,
 * unchanged in behaviour) so the bulk builder (§3.1, step 131.2) and the
 * bulk bar (§3.2, step 131.4) write through the EXACT same rule a single-row
 * assign does, rather than a second, drifting copy of it.
 */
function buildAssignmentPatch(row: FleetDeviceRow, pathId: string): StoredAssignment {
  const lan = row.lan.state === 'resolved' ? { lanIp: row.lan.lanIp, lanIpSource: row.lan.lanIpSource, leaseKind: row.lan.leaseKind } : { lanIp: row.assignment.lanIp, lanIpSource: row.assignment.lanIpSource, leaseKind: row.assignment.leaseKind }
  return { ...row.assignment, ...lan, groupId: row.assignment.groupId || DEFAULT_GROUP_ID, pathId, since: row.assignment.since || nowSec() }
}

// ---------------------------------------------------------------------------
// Plan 131 §3.1/§4.1, step 131.2 — the bulk builder's own logic beyond
// `buildPairings` itself (which lives in `bulk-builder.tsx`, 131.1). Kept
// here, not there, because 131.1 is already landed and this task's scope is
// this file alone — see this file's own git history for the split.
// ---------------------------------------------------------------------------

/**
 * Which of `buildPairings`' rows are actually written on commit: exactly the
 * ones with a real device AND a real path (`note: 'ok'` or
 * `'already-assigned'`). `no-such-device` (no `deviceId`) and `no-path` (no
 * `pathId`) have nothing to write — never silently attempted, never silently
 * dropped from the PREVIEW (131.1 already guarantees that), just excluded
 * from the write set the commit button actually sends.
 */
export function writablePairingRows(rows: readonly PairingRow[]): PairingRow[] {
  return rows.filter((row) => row.deviceId !== null && row.pathId !== null)
}

/**
 * A cheap, client-only check for the one gap 131.1's worker flagged and
 * declined to fix inside `buildPairings` itself: that function looks devices
 * up by NUMBER through a `Map`, so two devices sharing a number silently
 * collapse into one — the second reads as `no-such-device` in the preview,
 * with nothing to say why. This does not change `buildPairings`' own
 * behaviour (out of this file's scope to touch `bulk-builder.tsx`); it only
 * lets the builder's UI warn the operator BEFORE they trust a preview that
 * quietly picked one of two devices for a number.
 */
export function duplicateDeviceNumbersInRange(devices: readonly FleetDeviceRow[], fromNumber: number, toNumber: number): number[] {
  const counts = new Map<number, number>()
  for (const device of devices) {
    if (device.number === null) continue
    counts.set(device.number, (counts.get(device.number) ?? 0) + 1)
  }
  const duplicates: number[] = []
  for (const [number, count] of counts) {
    if (count > 1 && number >= fromNumber && number <= toNumber) duplicates.push(number)
  }
  return duplicates.sort((a, b) => a - b)
}

export const PAIRING_NOTE_LABEL: Record<PairingNote, string> = {
  ok: 'OK',
  'no-such-device': 'No device has this number',
  'already-assigned': 'Already assigned — will be repointed',
  'no-path': 'Ran out of paths',
}

export const PAIRING_NOTE_TONE: Record<PairingNote, string> = {
  ok: 'text-led-ok',
  'no-such-device': 'text-led-danger',
  'already-assigned': 'text-led-warn',
  'no-path': 'text-led-warn',
}

// ---------------------------------------------------------------------------
// Plan 131 §3.2/§4.2, step 131.4 — selection scope maths. Every one of these
// is pure so it can be proved as a function (this pack has no DOM harness,
// `bits.test.ts`'s own header) rather than as a rendered tree; the component
// only ever calls them.
// ---------------------------------------------------------------------------

/** Toggle one device id in or out of a selection, without mutating the set passed in. */
export function toggleSelected(selected: ReadonlySet<string>, deviceId: string): Set<string> {
  const next = new Set(selected)
  if (next.has(deviceId)) next.delete(deviceId)
  else next.add(deviceId)
  return next
}

/** "Select all" selects the FILTERED rows, never the whole fleet — docs/design.md's "a filter must not lie about its scope". */
export function selectAllFiltered(filtered: readonly FleetDeviceRow[]): Set<string> {
  return new Set(filtered.map((row) => row.deviceId))
}

/** The header checkbox's own checked state: true only when every currently-visible row is selected, and never true for an empty filter result (nothing to select is not "all selected"). */
export function isEverythingFilteredSelected(selected: ReadonlySet<string>, filtered: readonly FleetDeviceRow[]): boolean {
  return filtered.length > 0 && filtered.every((row) => selected.has(row.deviceId))
}

/**
 * The bulk bar's own count — always measured against the FILTERED rows, never
 * `selected.size` on its own. Selection is cleared whenever the filter
 * changes (§4.2, this file's own `AssignmentsTab`), so in practice the two
 * numbers agree; this is the safety net that makes the bulk bar's count
 * correct even if that guard were ever removed or raced, rather than trusting
 * the guard alone to keep it honest.
 */
export function selectedCountInScope(selected: ReadonlySet<string>, filtered: readonly FleetDeviceRow[]): number {
  return filtered.reduce((count, row) => count + (selected.has(row.deviceId) ? 1 : 0), 0)
}

/** The selected rows a bulk "Clear assignment" actually has something to do for — a row with no path and no LAN note is already clear. */
export function selectedRowsClearable(selected: ReadonlySet<string>, filtered: readonly FleetDeviceRow[]): FleetDeviceRow[] {
  return filtered.filter((row) => selected.has(row.deviceId) && (row.assignment.pathId !== '' || row.assignment.lanIp !== ''))
}

/** The selected rows a bulk path-assign can actually act on — mirrors the per-row `Combobox`'s own `disabled={row.lan.state !== 'resolved' || ...}` (a device with no resolved LAN address cannot be pointed at a path at all, bulk or not). */
export function selectedRowsAssignable(selected: ReadonlySet<string>, filtered: readonly FleetDeviceRow[]): FleetDeviceRow[] {
  return filtered.filter((row) => selected.has(row.deviceId) && row.lan.state === 'resolved')
}

// ---------------------------------------------------------------------------
// Plan 131 §3.4/§4.4, step 131.6 — "apply anyway", deliberately. See
// `ApplyDialog`'s own comment for why this is a disclosed action rather than
// a silent one, and for the honesty note about what today's `runApply()` can
// and cannot actually do.
// ---------------------------------------------------------------------------

/** Every `skip` row in a plan whose reason is specifically `path-down` — the one reason §3.4 gives an operator a deliberate way past, never `path-missing` or `duplicate` (§4.4's own non-goal: those stay a hard stop). */
export function pathDownRows(rows: readonly PlanRow[]): PlanRow[] {
  return rows.filter((row) => row.kind === 'skip' && row.reason === 'path-down')
}

export interface ApplyAnywayOffer {
  count: number
  /** Distinct path ids named by the down rows — what the warning tells the operator is down, not just how many rows are affected. */
  pathIds: string[]
  /**
   * The endpoint keys to send as `forceDownPaths` (plan 131 §3.4). Derived
   * from the same rows the warning names, so the write can never include a
   * row the operator was not shown — which is the whole of §4.5's
   * "never *silently*".
   */
  endpointKeys: string[]
}

/** `null` when there is nothing to offer — the action must not exist at all when no row is `path-down` (§5 step 131.6's own test). */
export function applyAnywayOffer(rows: readonly PlanRow[]): ApplyAnywayOffer | null {
  const down = pathDownRows(rows)
  if (down.length === 0) return null
  const pathIds = Array.from(new Set(down.map((row) => row.pathId).filter((id): id is string => Boolean(id))))
  // The endpoint keys the server needs in order to force these rows — plan
  // 131 §3.4, wired through `runApply(forceDownPaths)` → `buildPlan`. Taken
  // from the very rows the warning names, so the button can never write a
  // row the operator was not shown.
  const endpointKeys = Array.from(new Set(down.map((row) => row.endpointKey).filter((k): k is string => Boolean(k))))
  return { count: down.length, pathIds, endpointKeys }
}

/**
 * Human copy for a `skip` row's reason (§3.4's last paragraph: "the word
 * `skip` also stops being the last thing the UI says" — a skipped row states
 * what it is waiting for and what the operator can do about it). Falls back
 * to the raw reason string for a value this build does not know about,
 * mirroring `api.ts`'s own loose-schema philosophy for this row.
 */
export function describeSkipReason(reason: string | undefined): string {
  switch (reason) {
    case 'path-down':
      return 'Waiting on the path — it is reported down right now. It will be applied automatically once the path is back up, or use "Apply anyway" below to write it now.'
    case 'path-missing':
      return 'The path no longer exists on the router. Recreate the routing table, or point this device at a different one, then try again.'
    case 'duplicate':
      return 'Two router rules already match this device — remove the extra one on the router (§4.3) before this can be planned automatically.'
    default:
      return reason ?? ''
  }
}

/**
 * After an "Apply anyway" attempt, which of the `path-down` rows it was FOR
 * still did not get written. `RowOutcome` is only ever produced for
 * `create`/`update`/`delete` rows (`apply.ts`'s `executePlan`: "skip/foreign
 * rows are never touched, by construction"), so a `path-down` row can never
 * appear in `outcomes` under the CURRENT backend — this always returns every
 * row `applyAnywayOffer` named. It is written as a real diff against
 * `outcomes`, not a constant `true`, so the day `apply.ts` gains a way to
 * force a `path-down` row through (this file's own report names exactly
 * what that needs), this function starts reporting the truth automatically
 * with no change here.
 */
export function rowsStillUnwritten(rows: readonly PlanRow[], outcomes: readonly { row: PlanRow }[]): PlanRow[] {
  const writtenEndpointKeys = new Set(outcomes.map((outcome) => outcome.row.endpointKey ?? ''))
  return pathDownRows(rows).filter((row) => !writtenEndpointKeys.has(row.endpointKey ?? ''))
}

function HealthBadge({ health }: { health: PathHealth | undefined }) {
  if (!health) {
    return (
      <Badge variant="outline" className="text-fg-muted">
        Unknown
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={cn(health.up ? 'text-led-ok' : 'text-led-danger')}>
      {health.up ? 'Up' : 'Down'}
    </Badge>
  )
}

/**
 * LAN address cell — either the resolved address (with the §3.4 dynamic-lease
 * warning) or, for a `needs-address` device (§3.4 tier 3, the owner's own
 * explicit ask), an obvious way to type one in. Never hidden, never guessed.
 */
function LanCell({ row, draft, onDraftChange, onSaveManual, busy }: { row: FleetDeviceRow; draft: string; onDraftChange: (value: string) => void; onSaveManual: () => void; busy: boolean }) {
  if (row.lan.state === 'needs-address') {
    return (
      <div className="space-y-1.5">
        <p className="text-[11px] text-fg-muted">No address known yet — type one in.</p>
        <div className="flex gap-1.5">
          <Input value={draft} onChange={(e) => onDraftChange(e.target.value)} placeholder="192.168.10.x" className="h-8 w-36 text-[12px]" />
          <Button size="sm" variant="outline" disabled={!looksLikeIpv4(draft) || busy} onClick={onSaveManual}>
            Save
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <span className="readout text-[12px]">{row.lan.lanIp}</span>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-muted">
        <Badge variant="outline">{row.lan.lanIpSource}</Badge>
        {row.lan.leaseKind === 'dynamic' ? (
          <span className="text-led-warn" title="This IP was handed out by DHCP and can move to a different phone — a stale IP silently steers the wrong device (§3.4).">
            dynamic lease
          </span>
        ) : null}
      </div>
    </div>
  )
}

const PLAN_KIND_LABEL: Record<PlanRow['kind'], string> = { create: '+ create', update: '~ update', delete: '- delete', skip: '! skip', foreign: '? foreign' }
const PLAN_KIND_TONE: Record<PlanRow['kind'], string> = { create: 'text-led-ok', update: 'text-fg', delete: 'text-led-danger', skip: 'text-led-warn', foreign: 'text-fg-muted' }

function PlanRowLine({ row }: { row: PlanRow }) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-2 border-b border-border py-1.5 text-[12px] last:border-0', PLAN_KIND_TONE[row.kind])}>
      <span className="w-16 shrink-0 font-medium">{PLAN_KIND_LABEL[row.kind]}</span>
      <span className="readout">{row.endpointKey ?? '—'}</span>
      {row.kind === 'update' ? (
        <span className="text-fg-muted">
          {row.fromPathId} → {row.toPathId}
        </span>
      ) : (
        <span className="text-fg-muted">{row.pathId ?? '—'}</span>
      )}
      {/*
        Plan 131 §3.4's last paragraph: `skip` stops being the last thing the
        UI says. `describeSkipReason` states what the row is waiting for and
        what the operator can do — `(path-down)` on its own said neither.
      */}
      {row.kind === 'skip' ? <span className="w-full basis-full text-fg-muted">{describeSkipReason(row.reason)}</span> : row.reason ? <span className="text-fg-muted">({row.reason})</span> : null}
    </div>
  )
}

function ApplyDialog({ open, onOpenChange, onApplied }: { open: boolean; onOpenChange: (open: boolean) => void; onApplied: () => void }) {
  const [preview, setPreview] = useState<PlanPreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  /** Which button produced `result` — only "Apply anyway" gets the §3.4 honesty note below; a plain Confirm apply never claimed those rows in the first place. */
  const [lastAction, setLastAction] = useState<'apply' | 'apply-anyway' | null>(null)
  const { run, isPending } = useAction()

  useEffect(() => {
    if (!open) {
      setPreview(null)
      setResult(null)
      setError(null)
      setLastAction(null)
      return
    }
    setLoading(true)
    setError(null)
    previewApplyPlan()
      .then(setPreview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [open])

  const previewOk = preview && !isRefusal(preview) ? preview : null
  const canApply = previewOk !== null && previewOk.localException.status === 'ok' && result === null
  // §3.4/§4.4, step 131.6: `null` when the plan has no `path-down` row at
  // all — the action must not exist, not merely be disabled, in that case
  // (§5 step 131.6's own test, "the action is absent when no row is
  // path-down"). Computed from the SAME `previewOk.rows` the warning below
  // renders, so the button can never appear before the warning has.
  const anyway = previewOk ? applyAnywayOffer(previewOk.rows) : null
  const canApplyAnyway = anyway !== null && previewOk !== null && previewOk.localException.status === 'ok' && result === null
  const stillUnwritten = result && result.ok && lastAction === 'apply-anyway' ? rowsStillUnwritten(result.rows, result.outcomes) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Apply changes to the router</DialogTitle>
          <DialogDescription>Every write goes through this exact plan (§4.4) — nothing is ever applied blind. The router is the only thing that changes; no device is touched.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <LoadingRows rows={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => setError(null)} />
        ) : preview && isRefusal(preview) ? (
          <p className="text-[12px] text-led-danger">{preview.message}</p>
        ) : previewOk ? (
          <div className="space-y-3">
            {previewOk.localException.status !== 'ok' ? (
              <div className="space-y-1.5 rounded-lg border border-led-danger/40 bg-led-danger/5 p-3">
                <p className="text-[12px] font-medium text-led-danger">Apply is refused — the local-exception rule (§3.2) is not ok.</p>
                <p className="text-[11px] leading-relaxed text-fg-muted">{previewOk.localException.message}</p>
                <p className="text-[11px] text-fg-muted">Fix it on the Settings tab first — applying with this unresolved risks losing ADB to every device it touches.</p>
              </div>
            ) : null}

            {previewOk.blocked.length > 0 ? (
              <div className="space-y-1 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                <p className="text-[12px] font-medium text-led-warn">
                  {previewOk.blocked.length} device{previewOk.blocked.length === 1 ? '' : 's'} cannot be applied yet
                </p>
                <ul className="list-inside list-disc text-[11px] text-fg-muted">
                  {previewOk.blocked.map((b) => (
                    <li key={b.deviceId}>
                      {b.label} — {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {previewOk.rows.length === 0 ? (
              <p className="text-[12px] text-fg-muted">Nothing to change — the router already matches every noted assignment.</p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-lg border border-border p-2">
                {previewOk.rows.map((row, i) => (
                  <PlanRowLine key={i} row={row} />
                ))}
              </div>
            )}

            {/*
              §3.4/§4.4, step 131.6: the warning §4.5 already requires
              ("never applied silently"), PLUS the one thing that was
              missing — a deliberate, explicit way past it. Rendered from the
              exact same `previewOk.rows` as the plan above, so this can never
              appear before an operator has seen the rows it is about.
            */}
            {anyway ? (
              <div className="space-y-1.5 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                <p className="text-[12px] font-medium text-led-warn">
                  {anyway.count} row{anyway.count === 1 ? '' : 's'} {anyway.count === 1 ? 'points' : 'point'} at a path that is down: {anyway.pathIds.join(', ')}.
                </p>
                <p className="text-[11px] leading-relaxed text-fg-muted">
                  Skipped by default (§4.5) — a rule pointing at a dead path is a device with no internet, and that should never be a surprise. If the modem will come back and these should be written now
                  anyway, use the action below. This never happens from the default Confirm apply.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-led-warn"
                  disabled={!canApplyAnyway || isPending('apply-anyway') || isPending('apply')}
                  onClick={() => {
                    setLastAction('apply-anyway')
                    void run('apply-anyway', () => runApply(anyway?.endpointKeys ?? []), {
                      success: 'Applied',
                      failure: 'Apply failed',
                      onSuccess: (r) => {
                        setResult(r)
                        onApplied()
                      },
                    })
                  }}
                >
                  Apply anyway ({anyway.count} row{anyway.count === 1 ? '' : 's'} on a down path)
                </Button>
              </div>
            ) : null}

            {result ? (
              <div className="space-y-1 rounded-lg border border-border p-3 text-[12px]">
                <p className="font-medium">{result.ok ? 'Applied' : 'Apply refused'}</p>
                {result.ok ? (
                  <ul className="space-y-0.5">
                    {result.outcomes.map((o, i) => (
                      <li key={i} className={o.outcome === 'applied' ? 'text-led-ok' : 'text-led-danger'}>
                        {o.row.kind} {o.row.endpointKey ?? ''} — {o.outcome}
                        {o.message ? `: ${o.message}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-led-danger">{result.message}</p>
                )}
                {/*
                  The honesty half of "apply anyway" (this file's own report
                  names the exact backend gap): `executePlan` (`service/
                  apply.ts`) never touches a `skip` row, by construction, so
                  today this button cannot yet make a `path-down` row land on
                  the router any more than Confirm apply already does. Saying
                  so here, every time, is the alternative to a button that
                  claims a write it did not make — the one thing this whole
                  plan exists to stop.
                */}
                {stillUnwritten.length > 0 ? (
                  <p className="text-led-warn">
                    {stillUnwritten.length} of these still were not written — the router still reports the path down, and "Apply anyway" cannot yet override that on its own (it needs the apply
                    route itself to accept a forced path-down row, which is not part of this change).
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={!canApply || isPending('apply') || isPending('apply-anyway')}
            onClick={() => {
              setLastAction('apply')
              void run('apply', () => runApply(), {
                success: 'Applied',
                failure: 'Apply failed',
                onSuccess: (r) => {
                  setResult(r)
                  onApplied()
                },
              })
            }}
          >
            Confirm apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function pairingRowTargetLabel(row: PairingRow, devices: readonly FleetDeviceRow[]): string {
  if (row.deviceId === null) return '—'
  const device = devices.find((d) => d.deviceId === row.deviceId)
  return device ? formatDeviceName(device.number, device.label || device.stableId) : row.deviceId
}

/**
 * The builder — plan 131 §3.1/§4.1, step 131.2. The owner's own ask (§0.1):
 * type a device-NUMBER range and a starting path, pair them positionally,
 * and see the result before anything is written. `buildPairings` (131.1,
 * `bulk-builder.tsx`) is the pure pairing function; this dialog is the one
 * place that renders its preview AND is the one place that writes it —
 * exactly what the preview showed, nothing else (`writablePairingRows`).
 *
 * The "path start index" of §4.1's `BulkPairing` is presented as a PATH
 * PICKER, not a raw number — an operator thinks "start from via-modem7", not
 * "start from index 6". The index fed to `buildPairings` is derived from
 * where that path sits in the router's own list order, which is exactly what
 * §3.1 says "index" means.
 */
function BulkBuilderDialog({
  open,
  onOpenChange,
  devices,
  paths,
  onCommitted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  devices: readonly FleetDeviceRow[]
  paths: readonly Path[]
  onCommitted: () => void
}) {
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [startPathId, setStartPathId] = useState('')
  // §9 Q1's own recommendation (`bulk-builder.tsx`'s JSDoc on `overflow`):
  // 'stop' is the default. 'wrap' silently doubles a later device onto a
  // path an earlier device already got — exactly the class of surprise this
  // builder exists to prevent; 'stop' instead leaves the remainder visibly
  // `no-path` in the preview, a fact the operator sees and can act on.
  const [overflow, setOverflow] = useState<BulkPairing['overflow']>('stop')
  const { run, isPending } = useAction()

  useEffect(() => {
    if (!open) return
    setFromText('')
    setToText('')
    setStartPathId(paths[0]?.id ?? '')
    setOverflow('stop')
    // Reset every time the dialog opens, on a fresh `paths` snapshot — not a
    // dependency loop, since `paths` only changes between opens (the parent
    // reloads the fleet, not this dialog).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const fromNumber = Number(fromText)
  const toNumber = Number(toText)
  const rangeEntered = fromText.trim() !== '' && toText.trim() !== '' && Number.isInteger(fromNumber) && Number.isInteger(toNumber)
  const pathStartIndex = Math.max(
    paths.findIndex((p) => p.id === startPathId),
    0,
  )

  const preview = useMemo<{ rows: PairingRow[] } | { error: string } | null>(() => {
    if (!rangeEntered) return null
    try {
      return { rows: buildPairings({ fromNumber, toNumber, pathStartIndex, overflow }, devices, paths) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [rangeEntered, fromNumber, toNumber, pathStartIndex, overflow, devices, paths])

  const rows = preview && 'rows' in preview ? preview.rows : []
  const writable = writablePairingRows(rows)
  const duplicates = rangeEntered ? duplicateDeviceNumbersInRange(devices, fromNumber, toNumber) : []

  async function commit(): Promise<void> {
    if (writable.length === 0) return
    await run(
      'bulk-builder-commit',
      async () => {
        for (const row of writable) {
          const device = devices.find((d) => d.deviceId === row.deviceId)
          if (!device || row.pathId === null) continue
          await saveAssignment(device.stableId, buildAssignmentPatch(device, row.pathId))
        }
      },
      {
        success: `Assigned ${writable.length} device${writable.length === 1 ? '' : 's'}`,
        failure: 'Bulk assign failed',
        onSuccess: () => {
          onCommitted()
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bulk assign a device range</DialogTitle>
          <DialogDescription>
            A device-number range paired against a starting path, positionally. Nothing is written until you review the preview below and choose Assign — the same "plan, then apply" rule §4.4
            uses for the router applies here, aimed at this note instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 @sm:grid-cols-4">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">From device #</label>
              <Input type="number" inputMode="numeric" value={fromText} onChange={(e) => setFromText(e.target.value)} placeholder="1" className="h-8 text-[12.5px]" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">To device #</label>
              <Input type="number" inputMode="numeric" value={toText} onChange={(e) => setToText(e.target.value)} placeholder="20" className="h-8 text-[12.5px]" />
            </div>
            <div className="space-y-1 @sm:col-span-1">
              <label className="text-[11px] font-medium text-fg-muted">Starting path</label>
              <Combobox
                value={startPathId}
                onValueChange={setStartPathId}
                options={pathOptions({ paths, selectedPathId: startPathId })}
                searchPlaceholder="Filter paths…"
                emptyText="No path matches."
                ariaLabel="Starting path for the range"
                triggerClassName="h-8 text-[12px]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">When devices outrun paths</label>
              <Select value={overflow} onValueChange={(v) => setOverflow(v as BulkPairing['overflow'])}>
                <SelectTrigger className="h-8 w-full text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stop">Stop — leave the rest unpaired (default)</SelectItem>
                  <SelectItem value="wrap">Wrap — reuse paths from the start</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {duplicates.length > 0 ? (
            <p className="text-[11px] text-led-warn">
              Device number{duplicates.length === 1 ? '' : 's'} {duplicates.join(', ')} {duplicates.length === 1 ? 'is' : 'are'} carried by more than one enrolled device — only one of them can be
              matched by number, and the preview below cannot show which. Fix the duplicate number on the fleet before relying on this range.
            </p>
          ) : null}

          {!rangeEntered ? (
            <p className="text-[12px] text-fg-muted">Enter both ends of the range to see a preview.</p>
          ) : preview && 'error' in preview ? (
            <p className="text-[12px] text-led-danger">{preview.error}</p>
          ) : paths.length === 0 ? (
            <p className="text-[12px] text-fg-muted">No egress paths on the router — nothing to pair against.</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[11px] text-fg-muted">
                {writable.length} of {rows.length} row{rows.length === 1 ? '' : 's'} will be written.
              </p>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Device</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.deviceNumber}>
                        <TableCell className="readout text-[12px]">#{row.deviceNumber}</TableCell>
                        <TableCell className="text-[12px]">{pairingRowTargetLabel(row, devices)}</TableCell>
                        <TableCell className="readout text-[12px]">{row.pathLabel ?? '—'}</TableCell>
                        <TableCell className={cn('text-[11.5px]', PAIRING_NOTE_TONE[row.note])}>{PAIRING_NOTE_LABEL[row.note]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={writable.length === 0 || isPending('bulk-builder-commit')} onClick={() => void commit()}>
            Assign {writable.length} device{writable.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AssignmentsTab() {
  const { data, error, loading, reload } = useLoader(async () => {
    const result = await fetchFleet()
    if (isRefusal(result)) throw new Error(result.message)
    return result.fleet
  }, [])

  const [manualDrafts, setManualDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [applyOpen, setApplyOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** Plan 131 §3.2/§4.2, step 131.4 — per-row selection, scoped to the FILTERED rows (`selectAllFiltered`/`selectedCountInScope`). */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const { run: runBulk, isPending: bulkPending } = useAction()

  const paths = data?.paths ?? []
  const health = new Map((data?.health ?? []).map((h) => [h.pathId, h]))
  const devices = data?.devices ?? []

  /**
   * The filter (plan 124 §4.5). This table lists EVERY enrolled device — on
   * the owner's own farm that is 45 rows of near-identical model names — and
   * until this box existed the only way to reach one was to scroll.
   *
   * Device matching is `@enkaku/ui`'s `matchesDeviceQuery`, not a local
   * `includes`: it is the same four-way match (number exactly, then label,
   * stableId and tags as substrings) that Studio's `DevicePicker` uses, so
   * typing `7` finds `#7` here exactly as it does there and does not also
   * drag in `#17` and `#27` (plan 124 §1 goal 3, criterion 1).
   *
   * The assigned path's name is matched too, because "show me everything on
   * via-modem3" is the other question this table gets asked — and it is
   * matched against the path's `table` name the row actually displays, with
   * the raw id as the fallback for a path the router no longer lists.
   *
   * Client-side over the rows already loaded, like every other search box in
   * this product (plan 124 §2): `fetchFleet` returns the whole fleet in one
   * round trip, so there is no second page for this box to miss.
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return devices
    const tableOf = new Map(paths.map((p) => [p.id, p.table]))
    return devices.filter((row) => {
      if (matchesDeviceQuery(row, q)) return true
      const pathId = row.assignment.pathId
      return pathId !== '' && (tableOf.get(pathId) ?? pathId).toLowerCase().includes(q)
    })
  }, [devices, paths, query])

  /**
   * Plan 131 §4.2: "a selection whose scope the operator can no longer see is
   * a trap." Cleared entirely, not intersected — a filter change is exactly
   * the moment the operator's view of "what is selected" and "what is
   * selectable" diverge, and the bulk bar naming a count against rows no
   * longer on screen is the failure docs/design.md's "a filter must not lie
   * about its scope" forbids.
   */
  useEffect(() => {
    setSelectedIds(new Set())
    // Only `query` should clear the selection — `filtered` itself changes on
    // every `reload()` too (new device data, same filter), which must NOT
    // wipe a selection the operator is mid-bulk-action with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  async function bulkAssignPath(pathId: string): Promise<void> {
    const targets = selectedRowsAssignable(selectedIds, filtered)
    if (targets.length === 0) return
    setWriteError(null)
    await runBulk(
      'bulk-assign',
      async () => {
        for (const row of targets) await saveAssignment(row.stableId, buildAssignmentPatch(row, pathId))
      },
      {
        success: `Assigned ${targets.length} device${targets.length === 1 ? '' : 's'}`,
        failure: 'Bulk assign failed',
        onSuccess: () => {
          setSelectedIds(new Set())
          reload()
        },
      },
    )
  }

  async function bulkClear(): Promise<void> {
    const targets = selectedRowsClearable(selectedIds, filtered)
    if (targets.length === 0) return
    setWriteError(null)
    await runBulk(
      'bulk-clear',
      async () => {
        for (const row of targets) await clearAssignment(row.stableId)
      },
      {
        success: `Cleared ${targets.length} device${targets.length === 1 ? '' : 's'}`,
        failure: 'Bulk clear failed',
        onSuccess: () => {
          setSelectedIds(new Set())
          reload()
        },
      },
    )
  }

  async function saveManualIp(row: FleetDeviceRow): Promise<void> {
    const draft = (manualDrafts[row.deviceId] ?? '').trim()
    if (!looksLikeIpv4(draft)) return
    setBusy(row.deviceId)
    setWriteError(null)
    try {
      const next: StoredAssignment = { ...row.assignment, groupId: row.assignment.groupId || DEFAULT_GROUP_ID, lanIp: draft, lanIpSource: 'manual', since: row.assignment.since || nowSec() }
      await saveAssignment(row.stableId, next)
      setManualDrafts((prev) => {
        const copy = { ...prev }
        delete copy[row.deviceId]
        return copy
      })
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function assignPath(row: FleetDeviceRow, pathId: string): Promise<void> {
    setBusy(row.deviceId)
    setWriteError(null)
    try {
      await saveAssignment(row.stableId, buildAssignmentPatch(row, pathId))
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function unassign(row: FleetDeviceRow): Promise<void> {
    setBusy(row.deviceId)
    setWriteError(null)
    try {
      await clearAssignment(row.stableId)
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // plan 131 §3.3/§4.3: the skeleton is for the FIRST load only. A
  // revalidation (`reload()` after a write) already has `data`, so the table
  // stays mounted below and `revalidating` renders a stale affordance
  // instead — never a full unmount, which is what threw the operator's
  // scroll position back to the top on every single assignment (§0.3).
  if (isFirstLoad(loading, data)) return <LoadingRows />
  if (error) return <ErrorState message={error} onRetry={reload} />
  const revalidating = loading

  return (
    <div className="@container space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
          Every device in the farm, its resolved LAN address (§3.4), and which egress path it is noted to use. Choosing a path here writes a note only — nothing on the router changes until Apply
          is pressed and confirmed.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setBuilderOpen(true)} disabled={devices.length === 0 || paths.length === 0}>
            Bulk assign a range…
          </Button>
          <Button size="sm" onClick={() => setApplyOpen(true)} disabled={devices.length === 0}>
            Preview &amp; apply
          </Button>
        </div>
      </div>

      {writeError ? <ErrorState message={writeError} onRetry={() => setWriteError(null)} /> : null}

      {devices.length === 0 ? (
        <EmptyState title="No devices are enrolled" description="A device has to be enrolled before it can be assigned a path." />
      ) : paths.length === 0 ? (
        <EmptyState title="No egress paths on the router" description="Configure at least one routing table with a default route on the router first (§4.5) — this plugin reads paths, it does not create them." />
      ) : (
        <div className="space-y-2">
          {/*
            No search icon inside the field, unlike Studio's own
            `DevicePicker` (`packages/studio/src/components/DevicePicker.tsx`),
            which puts a lucide `Search` in a `relative` wrapper. A tier-C
            plugin's UI bundle may only import `@enkaku/ui` and React
            (`UI_EXTERNALS`, `packages/sdk/src/cli/build-ui.ts`); `lucide-react`
            is neither external nor a dependency of this pack, so importing one
            icon would inline an icon library into `ui/index.js`. This is the
            same call `plugins/proxy-manager/src/ui/parts/failover-chip.tsx`
            made and recorded for the same reason, and the shape below is
            proxy-manager's own catalogue filter (`catalogue.tsx`): the field,
            the live count beside it, and an `aria-label`, since the
            placeholder is not an accessible name.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by number, label, stable id, or path"
              aria-label="Filter devices"
              className="h-8 max-w-xs text-[12.5px]"
            />
            <span className="readout text-[11.5px] text-fg-muted">
              {filtered.length} of {devices.length} device{devices.length === 1 ? '' : 's'}
            </span>
            {/*
              A revalidation (plan 131 §3.3) — the rows below stay mounted
              and this is the only sign anything is happening, replacing the
              old full-table skeleton that unmounted every row on every
              write (§0.3).
            */}
            {revalidating ? (
              <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle" aria-hidden />
                refreshing
              </span>
            ) : null}
          </div>

          {/*
            Plan 131 §3.2/§4.2, step 131.4 — the bulk bar states its scope
            EXPLICITLY: "N of M" against `filtered`, never a bare N that could
            silently mean the whole fleet while a filter is narrowing what is
            on screen (docs/design.md's "a filter must not lie about its
            scope").
          */}
          {selectedIds.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 p-2 text-[12px]">
              <span className="font-medium">
                {selectedCountInScope(selectedIds, filtered)} of {filtered.length} selected
              </span>
              <Combobox
                value=""
                onValueChange={(v) => void bulkAssignPath(v)}
                options={pathOptions({ paths, selectedPathId: '' })}
                disabled={bulkPending('bulk-assign') || bulkPending('bulk-clear') || selectedRowsAssignable(selectedIds, filtered).length === 0}
                searchPlaceholder="Assign a path to the selection…"
                emptyText="No path matches."
                ariaLabel="Assign a path to every selected device"
                triggerClassName="h-8 w-64 text-[12px]"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={bulkPending('bulk-assign') || bulkPending('bulk-clear') || selectedRowsClearable(selectedIds, filtered).length === 0}
                onClick={() => void bulkClear()}
              >
                Clear assignment
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Clear selection
              </Button>
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <EmptyState title="No device matches that filter" description="Clear the filter to see every enrolled device again — this searches the devices already loaded, which is all of them." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select every filtered device"
                        checked={isEverythingFilteredSelected(selectedIds, filtered)}
                        onChange={() => setSelectedIds(isEverythingFilteredSelected(selectedIds, filtered) ? new Set() : selectAllFiltered(filtered))}
                      />
                    </TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead className="@2xl:w-56">LAN address</TableHead>
                    <TableHead className="@2xl:w-56">Assigned path</TableHead>
                    <TableHead className="@2xl:w-28">Path health</TableHead>
                    <TableHead className="@2xl:w-24">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const assignedHealth = row.assignment.pathId ? health.get(row.assignment.pathId) : undefined
                    const rowBusy = busy === row.deviceId
                    return (
                      <TableRow key={row.deviceId}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Select ${formatDeviceName(row.number, row.label || row.stableId)}`}
                            checked={selectedIds.has(row.deviceId)}
                            onChange={() => setSelectedIds((prev) => toggleSelected(prev, row.deviceId))}
                          />
                        </TableCell>
                        <TableCell>
                          {/*
                            `DeviceName` rather than a hand-composed string (plan
                            124 §3.2): the number is a separate, dimmed span beside
                            the name, and a device with no number renders its bare
                            label with no stray `#` and no shift in the row's
                            height (criterion 7). The stableId stays underneath —
                            it is what the KV writes below are keyed by, and it is
                            the tie-break when two devices share a label AND
                            neither has been given a number yet.
                          */}
                          <DeviceName number={row.number} label={row.label || row.stableId} className="font-medium" />
                          <div className="readout wrap-anywhere whitespace-normal text-[11px] text-fg-muted">{row.stableId}</div>
                        </TableCell>
                        <TableCell>
                          <LanCell
                            row={row}
                            draft={manualDrafts[row.deviceId] ?? ''}
                            onDraftChange={(v) => setManualDrafts((prev) => ({ ...prev, [row.deviceId]: v }))}
                            onSaveManual={() => void saveManualIp(row)}
                            busy={rowBusy}
                          />
                        </TableCell>
                        <TableCell>
                          {/*
                            A `Combobox`, not a `Select` (plan 124 §4.5). This
                            control is rendered ONCE PER DEVICE ROW, and a real
                            router carries 10–50 egress paths — so on the owner's
                            farm this was 45 unsearchable scroll-lists of 50
                            near-identically named routing tables.
                            `bits.tsx`'s `pathOptions` builds the list so this
                            picker and the group editor's cannot drift, and it is
                            what keeps the two behaviours this cell already had:
                            `Unassigned` is a real option (clearing a path is a
                            thing an operator does), and a path the router no
                            longer lists stays visible and named rather than
                            silently reading as unassigned.
                          */}
                          <Combobox
                            value={row.assignment.pathId || NONE}
                            onValueChange={(v) => void assignPath(row, v === NONE ? '' : v)}
                            options={pathOptions({ paths, selectedPathId: row.assignment.pathId, unassigned: true })}
                            disabled={row.lan.state !== 'resolved' || rowBusy}
                            searchPlaceholder="Filter paths…"
                            emptyText="No path matches."
                            ariaLabel={`Egress path for ${formatDeviceName(row.number, row.label || row.stableId)}`}
                            triggerClassName="h-8 text-[12px]"
                          />
                        </TableCell>
                        <TableCell>{row.assignment.pathId ? <HealthBadge health={assignedHealth} /> : <span className="text-fg-muted">—</span>}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" disabled={(!row.assignment.pathId && !row.assignment.lanIp) || rowBusy} onClick={() => void unassign(row)}>
                            Unassign
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <ApplyDialog open={applyOpen} onOpenChange={setApplyOpen} onApplied={reload} />
      <BulkBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} devices={devices} paths={paths} onCommitted={reload} />
    </div>
  )
}
