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
  type PathHealth,
  type PlanPreviewResult,
  type PlanRow,
  type StoredAssignment,
} from './api'
import { pathOptions, useLoader, UNASSIGNED_PATH } from './bits'

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
      {row.reason ? <span className="text-fg-muted">({row.reason})</span> : null}
    </div>
  )
}

function ApplyDialog({ open, onOpenChange, onApplied }: { open: boolean; onOpenChange: (open: boolean) => void; onApplied: () => void }) {
  const [preview, setPreview] = useState<PlanPreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const { run, isPending } = useAction()

  useEffect(() => {
    if (!open) {
      setPreview(null)
      setResult(null)
      setError(null)
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
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={!canApply || isPending('apply')}
            onClick={() =>
              void run('apply', () => runApply(), {
                success: 'Applied',
                failure: 'Apply failed',
                onSuccess: (r) => {
                  setResult(r)
                  onApplied()
                },
              })
            }
          >
            Confirm apply
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
  const [query, setQuery] = useState('')

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
      const lan = row.lan.state === 'resolved' ? { lanIp: row.lan.lanIp, lanIpSource: row.lan.lanIpSource, leaseKind: row.lan.leaseKind } : { lanIp: row.assignment.lanIp, lanIpSource: row.assignment.lanIpSource, leaseKind: row.assignment.leaseKind }
      const next: StoredAssignment = { ...row.assignment, ...lan, groupId: row.assignment.groupId || DEFAULT_GROUP_ID, pathId, since: row.assignment.since || nowSec() }
      await saveAssignment(row.stableId, next)
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

  if (loading) return <LoadingRows />
  if (error) return <ErrorState message={error} onRetry={reload} />

  return (
    <div className="@container space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
          Every device in the farm, its resolved LAN address (§3.4), and which egress path it is noted to use. Choosing a path here writes a note only — nothing on the router changes until Apply
          is pressed and confirmed.
        </p>
        <Button size="sm" onClick={() => setApplyOpen(true)} disabled={devices.length === 0}>
          Preview &amp; apply
        </Button>
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
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="No device matches that filter" description="Clear the filter to see every enrolled device again — this searches the devices already loaded, which is all of them." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
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
    </div>
  )
}
