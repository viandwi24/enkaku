import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
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
  Textarea,
  cn,
  deviceSearchTerms,
  formatDeviceName,
  useAction,
} from '@enkaku/ui'
import {
  activateGroupApi,
  deactivateGroupApi,
  deleteGroupApi,
  fetchFleet,
  fetchGroups,
  isRefusal,
  previewActivateGroupApi,
  saveGroupApi,
  type ActivatePreviewResult,
  type ActivateResult,
  type BlockedAssignment,
  type DeactivateResult,
  type FleetDeviceRow,
  type Group,
  type GroupEntry,
  type GroupOnDeactivate,
  type Path,
  type PlanRow,
} from './api'
import { pathOptions, useLoader } from './bits'

/**
 * Groups — plan 122 §5 step 122.8, "the tab itself": group CRUD, the §4.6
 * activation transaction, and deactivation honouring `onDeactivate`. This is
 * the owner's own "otomatis" (122.13's correction): define a group once,
 * then enable or disable it and have the router's rules follow.
 *
 * **The Activate dialog previews before it writes (gap fix, 2026-08-21).**
 * This step's first landing showed the real §4.4 diff only AFTER
 * `activateGroup` had already run — backwards from §3.2/§4.4's own rule
 * ("Studio requires confirmation... before anything is written") and from
 * what the Assignments tab already does for a single assignment. Fixed by
 * `group-activate-preview` (`groups-service.ts`'s `previewActivateGroup`),
 * which reuses `apply.ts`'s existing `previewPlan` — never a second plan
 * pipeline — to answer, with zero writes: the exact plan rows activation
 * would produce, the `decideActivation` outcome (naming a conflict's exact
 * groups/devices, or under `force` which groups would be deactivated first),
 * and whether §3.2's local-exception check would block it. Only once that is
 * on screen does `ActivateDialog` offer a real Activate/Force-activate
 * button, which then calls `activateGroupApi` — the same two-act shape
 * (preview, then a separate confirmed write) `assignments.tsx`'s own
 * `ApplyDialog` already uses.
 */

const EMPTY_LAN = ''

function conflictingDeviceIds(a: Group, b: Group): string[] {
  const bDevices = new Set(b.entries.map((e) => e.deviceId))
  const overlap: string[] = []
  for (const e of a.entries) if (bDevices.has(e.deviceId) && !overlap.includes(e.deviceId)) overlap.push(e.deviceId)
  return overlap
}

/** Every OTHER active group this one's device set overlaps — the same predicate `groups.ts`'s `conflict`/`overlappingDeviceIds` compute server-side (§4.6), kept as a small local function here rather than importing the service module into the UI bundle (`shared.ts`'s own header gives the identical reason for staying import-free). */
function activeConflictsFor(group: Group, allGroups: readonly Group[]): { group: Group; deviceIds: string[] }[] {
  const out: { group: Group; deviceIds: string[] }[] = []
  for (const other of allGroups) {
    if (other.id === group.id || !other.active) continue
    const overlap = conflictingDeviceIds(group, other)
    if (overlap.length > 0) out.push({ group: other, deviceIds: overlap })
  }
  return out
}

/**
 * The one place this screen turns a device id into something an operator can
 * read — the duplicate-device refusal, the conflict sentences, the deactivate
 * report and the conflict matrix's tooltip all go through it.
 *
 * It composes the number (plan 124 §3.2's string half, `formatDeviceName`)
 * because every one of those call sites needs a `string`: they are prose and
 * `.join(', ')` lists, not table cells. Before this, a group that overlapped
 * two of the owner's identically-named phones said *"Jadwal-1 conflicts with
 * active Jadwal-2 on SM-F721U1, SM-F721U1"*, which names the collision
 * without naming either device in it.
 *
 * The id remains the fallback for a device the fleet no longer lists (one
 * that has been forgotten since the group was written) — an unresolvable id
 * shown raw is honest; inventing a name for it would not be.
 */
function labelFor(deviceId: string, devices: readonly FleetDeviceRow[]): string {
  const device = devices.find((d) => d.deviceId === deviceId)
  return device ? formatDeviceName(device.number, device.label || device.stableId) : deviceId
}

/** `describeConflicts` (`service/groups.ts`) — §4.6's own sentence, reproduced client-side for the preview's `decision.conflicts` (which carries no pre-built message, unlike `ActivateConflict`). Kept local for the same reason `conflictingDeviceIds`/`activeConflictsFor` above are: no service module import into the UI bundle. */
function describeConflictsLocal(candidateName: string, conflicts: readonly { group: Group; overlappingDeviceIds: string[] }[]): string {
  const clauses = conflicts.map((c) => `active ${c.group.name || c.group.id} on ${c.overlappingDeviceIds.join(', ')}`)
  return `${candidateName} conflicts with ${clauses.join('; ')}`
}

// ---------------------------------------------------------------------------
// Edit dialog — create/rename/edit a group, add/remove entries
// ---------------------------------------------------------------------------

interface EntryDraft {
  deviceId: string
  lanIp: string
  pathId: string
}

function toDraft(entries: readonly GroupEntry[]): EntryDraft[] {
  return entries.map((e) => ({ deviceId: e.deviceId, lanIp: e.lanIp, pathId: e.pathId }))
}

function duplicateDeviceIdsLocal(entries: readonly EntryDraft[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const e of entries) {
    if (e.deviceId === '') continue
    if (seen.has(e.deviceId)) dupes.add(e.deviceId)
    seen.add(e.deviceId)
  }
  return [...dupes]
}

function EditGroupDialog({
  open,
  onOpenChange,
  group,
  devices,
  paths,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: Group | null
  devices: FleetDeviceRow[]
  paths: Path[]
  onSaved: () => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [note, setNote] = useState(group?.note ?? '')
  const [onDeactivate, setOnDeactivate] = useState<GroupOnDeactivate>(group?.onDeactivate ?? 'remove-rules')
  const [entries, setEntries] = useState<EntryDraft[]>(toDraft(group?.entries ?? []))
  const [newDeviceId, setNewDeviceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  // Re-seed local state whenever a DIFFERENT group (or "new") is opened —
  // deliberately keyed on `open`/`group?.id` rather than every render, so
  // typing in the form does not get clobbered by its own re-render.
  const seedKey = `${open}:${group?.id ?? 'new'}`
  const [lastSeedKey, setLastSeedKey] = useState(seedKey)
  if (seedKey !== lastSeedKey) {
    setLastSeedKey(seedKey)
    setName(group?.name ?? '')
    setNote(group?.note ?? '')
    setOnDeactivate(group?.onDeactivate ?? 'remove-rules')
    setEntries(toDraft(group?.entries ?? []))
    setNewDeviceId('')
    setError(null)
  }

  const dupes = duplicateDeviceIdsLocal(entries)
  const usedDeviceIds = new Set(entries.map((e) => e.deviceId))
  const addableDevices = devices.filter((d) => !usedDeviceIds.has(d.deviceId))

  function addEntry(): void {
    const device = devices.find((d) => d.deviceId === newDeviceId)
    if (!device) return
    const lanIp = device.lan.state === 'resolved' ? device.lan.lanIp : EMPTY_LAN
    setEntries((prev) => [...prev, { deviceId: device.deviceId, lanIp, pathId: paths[0]?.id ?? '' }])
    setNewDeviceId('')
  }

  function removeEntry(deviceId: string): void {
    setEntries((prev) => prev.filter((e) => e.deviceId !== deviceId))
  }

  function updatePath(deviceId: string, pathId: string): void {
    setEntries((prev) => prev.map((e) => (e.deviceId === deviceId ? { ...e, pathId } : e)))
  }

  async function save(): Promise<void> {
    setError(null)
    if (name.trim() === '') {
      setError('Give this group a name before saving.')
      return
    }
    if (dupes.length > 0) {
      setError(`This group lists the same device more than once: ${dupes.map((id) => labelFor(id, devices)).join(', ')}.`)
      return
    }
    if (entries.some((e) => e.pathId === '')) {
      setError('Every device in this group needs a path chosen.')
      return
    }
    await run(
      'save',
      () =>
        saveGroupApi({
          id: group?.id ?? '',
          name,
          note,
          entries: entries.map((e) => ({ deviceId: e.deviceId, lanIp: e.lanIp, pathId: e.pathId })),
          onDeactivate,
          failoverPolicy: group?.failoverPolicy ?? 'none',
        }),
      {
        success: group ? 'Group saved' : 'Group created',
        failure: 'Save failed',
        onSuccess: (result) => {
          if (!result.ok) {
            setError(result.message)
            return
          }
          onOpenChange(false)
          onSaved()
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name || group.id}` : 'New group'}</DialogTitle>
          <DialogDescription>A named set of device → path assignments that activates or deactivates as a unit (§4.6). Nothing on the router changes until it is activated.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 @sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jadwal-1" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">When deactivated</label>
              <Select value={onDeactivate} onValueChange={(v) => setOnDeactivate(v as GroupOnDeactivate)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="remove-rules">Remove rules (default)</SelectItem>
                  <SelectItem value="disable-rules">Disable rules — keep them, cheaper to re-activate</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-fg-muted">Note</label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-fg-muted">Devices in this group</label>
              <div className="flex gap-1.5">
                {/*
                  Plan 124 §0.2 called this "the worst surface in the product",
                  and it was: the ONE dropdown in the whole repo that lists
                  every enrolled device without going through `DevicePicker`.
                  It was a Radix `Select` of `{d.label || d.stableId}` at
                  `w-56` — no number, and no search beyond Radix's
                  single-keystroke jump, so finding one phone among the
                  owner's 45 near-identically named ones was a scroll hunt.

                  Now a `Combobox` (§4.5): the row reads `#7 Galaxy A15` with
                  the stableId as its hint, and `deviceSearchTerms` feeds the
                  filter every string the device can legitimately be
                  recognised by — so typing `7` finds `#7` (and not `#17`),
                  and so does `#7`, `Galaxy` or a fragment of the stableId.
                */}
                <Combobox
                  value={newDeviceId}
                  onValueChange={setNewDeviceId}
                  options={addableDevices.map((d) => ({
                    value: d.deviceId,
                    label: formatDeviceName(d.number, d.label || d.stableId),
                    hint: d.stableId,
                    keywords: deviceSearchTerms(d),
                  }))}
                  placeholder="Add a device…"
                  searchPlaceholder="Search number, label, or stable id…"
                  emptyText={addableDevices.length === 0 ? 'Every enrolled device is already in this group.' : 'No device matches.'}
                  ariaLabel="Add a device to this group"
                  triggerClassName="h-8 w-56 text-[12px]"
                />
                <Button size="sm" variant="outline" disabled={newDeviceId === ''} onClick={addEntry}>
                  Add
                </Button>
              </div>
            </div>

            {entries.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-center text-[12px] text-fg-muted">No devices yet — add at least one above.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Device</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => {
                      // The fleet row behind this entry, or `undefined` for a device
                      // that has been forgotten since the group was written — the
                      // one case that has no number and no label to render.
                      const deviceRow = devices.find((d) => d.deviceId === e.deviceId)
                      return (
                        <TableRow key={e.deviceId} className={cn(dupes.includes(e.deviceId) && 'bg-led-danger/5')}>
                          <TableCell>
                            {/*
                              `DeviceName` (the two-span visual form, plan 124
                              §3.2) rather than `labelFor`'s string, because this
                              IS a table cell — the number reads as a quiet
                              identifier beside the name. `deviceRow` is
                              `undefined` for a device the fleet no longer lists,
                              which is the one case that falls back to the raw
                              id and renders no number at all.
                            */}
                            <DeviceName number={deviceRow?.number ?? null} label={deviceRow ? deviceRow.label || deviceRow.stableId : e.deviceId} className="font-medium" />
                            {e.lanIp === '' ? <div className="text-[11px] text-led-warn">No LAN address known — this entry will be blocked until one is (§3.4).</div> : <div className="readout text-[11px] text-fg-muted">{e.lanIp}</div>}
                          </TableCell>
                          <TableCell>
                            {/*
                              A `Combobox`, not a `Select` (plan 124 §4.5) — this
                              picker is rendered once per group entry, and a real
                              router carries 10–50 egress paths, so a 20-device
                              group rendered 20 unsearchable lists of them.
                              `pathOptions` is shared with the Assignments tab so
                              the two cannot drift; `unassigned` is deliberately
                              NOT offered here, because `save()` below refuses an
                              entry with no path — an option that cannot survive
                              saving has no business in the list.
                            */}
                            <Combobox
                              value={e.pathId}
                              onValueChange={(v) => updatePath(e.deviceId, v)}
                              options={pathOptions({ paths, selectedPathId: e.pathId })}
                              placeholder="Choose a path"
                              searchPlaceholder="Filter paths…"
                              emptyText="No path matches."
                              ariaLabel={`Egress path for ${labelFor(e.deviceId, devices)}`}
                              triggerClassName="h-8 w-full text-[12px]"
                            />
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm" onClick={() => removeEntry(e.deviceId)}>
                              Remove
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {dupes.length > 0 ? <p className="text-[11px] text-led-danger">Listed more than once: {dupes.map((id) => labelFor(id, devices)).join(', ')} — one device can only be at one path in this group (acceptance criterion 12).</p> : null}
          </div>

          {error ? <p className="text-[12px] text-led-danger">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isPending('save')} onClick={() => void save()}>
            {group ? 'Save changes' : 'Create group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Activate dialog — preview (§4.4/§3.2, gap fix), THEN a confirmed write
// (§4.6's transaction, conflict naming, force)
// ---------------------------------------------------------------------------

/** The same five-kind rendering `assignments.tsx`'s own `PlanRowLine` uses — duplicated rather than imported, matching this file's own precedent (`conflictingDeviceIds` above) of a small local copy over reaching into another screen's module for one component. */
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

function ActivateDialog({ open, onOpenChange, group, devices, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; group: Group; devices: FleetDeviceRow[]; onDone: () => void }) {
  const [force, setForce] = useState(false)
  const [preview, setPreview] = useState<ActivatePreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [result, setResult] = useState<ActivateResult | null>(null)
  const { run, isPending } = useAction()

  useEffect(() => {
    if (!open || result) return
    let alive = true
    setPreviewLoading(true)
    setPreviewError(null)
    previewActivateGroupApi(group.id, force)
      .then((r) => {
        if (alive) setPreview(r)
      })
      .catch((e: unknown) => {
        if (alive) setPreviewError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setPreviewLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, force, group.id, result, previewNonce])

  function reset(next: boolean): void {
    if (!next) {
      setResult(null)
      setPreview(null)
      setForce(false)
    }
    onOpenChange(next)
  }

  async function attempt(): Promise<void> {
    await run('activate', () => activateGroupApi(group.id, force), {
      success: 'Activated',
      failure: 'Activation failed',
      onSuccess: (r) => {
        setResult(r)
        if (r.ok) onDone()
      },
    })
  }

  const previewOk = preview && preview.ok ? preview : null
  const previewRefusal = preview && !preview.ok ? preview : null
  const blocked: BlockedAssignment[] = previewOk?.blocked ?? []
  const localExceptionBlocks = previewOk ? previewOk.localException.status !== 'ok' : false
  const canConfirm = previewOk !== null && previewOk.decision.kind !== 'refuse' && !localExceptionBlocks

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Activate {group.name || group.id}</DialogTitle>
          <DialogDescription>Nothing is written until you confirm below — this is the exact §4.4 plan and §4.6 outcome activating now would produce.</DialogDescription>
        </DialogHeader>

        {result ? (
          result.ok ? (
            <div className="space-y-2 text-[12px]">
              <p className="font-medium text-led-ok">
                Activated — {result.apply.outcomes.length} rule change{result.apply.outcomes.length === 1 ? '' : 's'} applied.
              </p>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                {result.apply.outcomes.map((o, i) => (
                  <li key={i} className={o.outcome === 'applied' ? 'text-led-ok' : 'text-led-danger'}>
                    {o.row.kind} {o.row.endpointKey ?? ''} — {o.outcome}
                    {o.message ? `: ${o.message}` : ''}
                  </li>
                ))}
              </ul>
              {result.deactivated.length > 0 ? (
                <div className="rounded-lg border border-border p-2">
                  <p className="font-medium">Deactivated to make room:</p>
                  {result.deactivated.map((d) => (
                    <p key={d.group.id} className="text-fg-muted">
                      {d.group.name || d.group.id} — {d.outcomes.length} device{d.outcomes.length === 1 ? '' : 's'}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-[12px] text-led-danger">{result.message}</p>
          )
        ) : previewLoading ? (
          <LoadingRows rows={4} />
        ) : previewError ? (
          <ErrorState message={previewError} onRetry={() => setPreviewNonce((n) => n + 1)} />
        ) : previewRefusal ? (
          <p className="text-[12px] text-led-danger">{previewRefusal.message}</p>
        ) : previewOk ? (
          <div className="space-y-3">
            {localExceptionBlocks ? (
              <div className="space-y-1.5 rounded-lg border border-led-danger/40 bg-led-danger/5 p-3">
                <p className="text-[12px] font-medium text-led-danger">Activation would be refused — the local-exception rule (§3.2) is not ok.</p>
                <p className="text-[11px] leading-relaxed text-fg-muted">{previewOk.localException.message}</p>
                <p className="text-[11px] text-fg-muted">Fix it on the Settings tab first — activating with this unresolved risks losing ADB to every device it touches.</p>
              </div>
            ) : null}

            {previewOk.decision.kind === 'refuse' ? (
              <div className="space-y-2 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3 text-[12px]">
                <p className="font-medium text-led-warn">{describeConflictsLocal(group.name || group.id, previewOk.decision.conflicts)}</p>
                {previewOk.decision.conflicts.map((c) => (
                  <p key={c.group.id} className="text-fg-muted">
                    {c.group.name || c.group.id} would be deactivated — devices: {c.overlappingDeviceIds.map((id) => labelFor(id, devices)).join(', ')}
                  </p>
                ))}
                <p className="text-fg-muted">Force activate deactivates the groups above, in this same operation, so there is never a moment a device has no assignment (§4.6).</p>
              </div>
            ) : previewOk.decision.kind === 'force' ? (
              <div className="space-y-1.5 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3 text-[12px]">
                <p className="font-medium text-led-warn">These groups would be deactivated first, in this same operation:</p>
                {previewOk.decision.toDeactivate.map((c) => (
                  <p key={c.group.id} className="text-fg-muted">
                    {c.group.name || c.group.id} — devices: {c.overlappingDeviceIds.map((id) => labelFor(id, devices)).join(', ')}
                  </p>
                ))}
              </div>
            ) : null}

            {blocked.length > 0 ? (
              <div className="space-y-1 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                <p className="text-[12px] font-medium text-led-warn">
                  {blocked.length} device{blocked.length === 1 ? '' : 's'} cannot be activated yet
                </p>
                <ul className="list-inside list-disc text-[11px] text-fg-muted">
                  {blocked.map((b) => (
                    <li key={b.deviceId}>
                      {b.label} — {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {previewOk.plan.length === 0 ? (
              <p className="text-[12px] text-fg-muted">Nothing to change on the router — it already matches this group's own entries.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border p-2">
                {previewOk.plan.map((row, i) => (
                  <PlanRowLine key={i} row={row} />
                ))}
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => reset(false)}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && previewOk?.decision.kind === 'refuse' ? (
            <Button variant="destructive" disabled={previewLoading} onClick={() => setForce(true)}>
              Preview force activate
            </Button>
          ) : !result ? (
            <Button variant={force ? 'destructive' : 'default'} disabled={!canConfirm || isPending('activate')} onClick={() => void attempt()}>
              {force ? 'Force activate' : 'Activate'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Deactivate — a plain confirm, since the consequence is a router write an
// operator needs stated plainly (§6.3: "deactivate" reads like "pause", but
// the traffic consequence is immediate)
// ---------------------------------------------------------------------------

function DeactivateButton({ group, devices, onDone }: { group: Group; devices: FleetDeviceRow[]; onDone: () => void }) {
  const { run, isPending } = useAction()
  const [result, setResult] = useState<DeactivateResult | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={isPending('deactivate')}>
          Deactivate
        </Button>
      }
      title={`Deactivate ${group.name || group.id}?`}
      description={
        <div className="space-y-2 text-[12px]">
          <p>
            {group.entries.length} device{group.entries.length === 1 ? '' : 's'} return to the router's default egress immediately — this is not a pause. {group.onDeactivate === 'disable-rules' ? 'Its rules are kept on the router, disabled — cheaper to re-activate.' : 'Its rules are removed from the router.'}
          </p>
          {result ? (
            <div className="rounded-lg border border-border p-2">
              {result.ok ? (
                <ul className="space-y-0.5">
                  {result.outcomes.map((o) => (
                    <li key={o.deviceId}>
                      {labelFor(o.deviceId, devices)} — {o.action}
                      {o.reason ? `: ${o.reason}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-led-danger">{result.message}</p>
              )}
            </div>
          ) : null}
        </div>
      }
      confirmLabel="Deactivate"
      destructive
      open={open}
      onOpenChange={setOpen}
      onConfirm={() =>
        run('deactivate', () => deactivateGroupApi(group.id), {
          success: 'Deactivated',
          failure: 'Deactivation failed',
          onSuccess: (r) => {
            setResult(r)
            if (r.ok) onDone()
          },
        })
      }
    />
  )
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function GroupsTab() {
  const { data, error, loading, reload } = useLoader(async () => {
    const [groupsResult, fleetResult] = await Promise.all([fetchGroups(), fetchFleet()])
    if (isRefusal(groupsResult)) throw new Error(groupsResult.message)
    if (isRefusal(fleetResult)) throw new Error(fleetResult.message)
    return { groups: groupsResult.items, devices: fleetResult.fleet.devices, paths: fleetResult.fleet.paths }
  }, [])

  const [editing, setEditing] = useState<{ group: Group | null } | null>(null)
  const [activating, setActivating] = useState<Group | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { run } = useAction()

  const groups = data?.groups ?? []
  const devices = data?.devices ?? []
  const paths = data?.paths ?? []

  const conflictsByGroup = useMemo(() => {
    const map = new Map<string, { group: Group; deviceIds: string[] }[]>()
    for (const g of groups) map.set(g.id, activeConflictsFor(g, groups))
    return map
  }, [groups])

  async function remove(id: string): Promise<void> {
    await run('delete', () => deleteGroupApi(id), { success: 'Group deleted', failure: 'Delete failed', onSuccess: () => reload() })
  }

  if (loading) return <LoadingRows />
  if (error) return <ErrorState message={error} onRetry={reload} />

  return (
    <div className="@container space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
          A named set of device → path assignments (§4.6) — activate or deactivate the whole set at once, and the router's rules follow. Many groups may be active at once as long as their device
          sets are disjoint.
        </p>
        <Button size="sm" onClick={() => setEditing({ group: null })}>
          New group
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="No groups yet" description="Create a group, add devices to it, and activate it — the router's rules follow automatically." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="@2xl:w-24">Devices</TableHead>
                <TableHead className="@2xl:w-28">Status</TableHead>
                <TableHead>Conflicts with</TableHead>
                <TableHead className="@2xl:w-72">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => {
                const conflicts = conflictsByGroup.get(g.id) ?? []
                return (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="font-medium">{g.name || g.id}</div>
                      {g.note ? <div className="text-[11px] text-fg-muted">{g.note}</div> : null}
                    </TableCell>
                    <TableCell>{g.entries.length}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn(g.active ? 'text-led-ok' : 'text-fg-muted')}>
                        {g.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {g.active || conflicts.length === 0 ? (
                        <span className="text-fg-muted">—</span>
                      ) : (
                        <span className="text-led-warn" title="Activating this group would deactivate these, since their device sets overlap (§4.6).">
                          {conflicts.map((c) => c.group.name || c.group.id).join(', ')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => setEditing({ group: g })}>
                          Edit
                        </Button>
                        {g.active ? (
                          <DeactivateButton group={g} devices={devices} onDone={reload} />
                        ) : (
                          <Button size="sm" disabled={g.entries.length === 0} onClick={() => setActivating(g)}>
                            Activate
                          </Button>
                        )}
                        <ConfirmDialog
                          trigger={
                            <Button variant="ghost" size="sm" disabled={g.active}>
                              Delete
                            </Button>
                          }
                          title={`Delete ${g.name || g.id}?`}
                          description="This removes the group's own definition — it does not touch the router. Refused while active."
                          confirmLabel="Delete"
                          destructive
                          open={deletingId === g.id}
                          onOpenChange={(o) => setDeletingId(o ? g.id : null)}
                          onConfirm={() => remove(g.id)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {groups.length > 1 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-fg-muted">Conflict matrix — which groups can be active at the same time</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  {groups.map((g) => (
                    <TableHead key={g.id} className="text-center">
                      {g.name || g.id}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name || row.id}</TableCell>
                    {groups.map((col) => {
                      if (col.id === row.id) return <TableCell key={col.id} className="text-center text-fg-muted">—</TableCell>
                      const overlap = conflictingDeviceIds(row, col)
                      return (
                        <TableCell key={col.id} className="text-center">
                          {overlap.length > 0 ? (
                            <span className="text-led-danger" title={`Shares ${overlap.map((id) => labelFor(id, devices)).join(', ')}`}>
                              conflicts
                            </span>
                          ) : (
                            <span className="text-led-ok">ok</span>
                          )}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      {editing ? <EditGroupDialog open onOpenChange={(o) => !o && setEditing(null)} group={editing.group} devices={devices} paths={paths} onSaved={reload} /> : null}
      {activating ? <ActivateDialog open onOpenChange={(o) => !o && setActivating(null)} group={activating} devices={devices} onDone={reload} /> : null}
    </div>
  )
}
