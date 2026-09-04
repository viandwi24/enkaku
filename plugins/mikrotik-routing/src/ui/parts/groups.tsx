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
  formatDeviceName,
  useAction,
} from '@enkaku/ui'
import { DevicePickerDialog } from '@enkaku/host'
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
import { summariseOverDownPath } from './assignments'
import { buildPairings, type BulkPairing, type PairingNote, type PairingRow } from './bulk-builder'

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

// ---------------------------------------------------------------------------
// Bulk add — plan 131 §3.1/§4.1, step 131.3. The same `buildPairings` the
// Assignments tab renders (131.2, another worker's file — not this one), but
// mapped onto GROUP ENTRIES rather than assignments, because that is what
// this screen writes. `assignments.tsx` writes a `StoredAssignment` keyed by
// `stableId`; this dialog writes `EntryDraft[]` into the group form's own
// local `entries` state, exactly the shape `addEntry` above already builds
// for the picker above — nothing here invents a second way to construct an
// entry.
// ---------------------------------------------------------------------------

const PAIRING_NOTE_LABEL: Record<PairingNote, string> = {
  ok: 'ok',
  'no-such-device': 'no device carries this number',
  'already-assigned': 'already has an assignment note (Assignments tab)',
  'no-path': 'ran out of paths from the chosen start',
}
const PAIRING_NOTE_TONE: Record<PairingNote, string> = {
  ok: 'text-led-ok',
  'no-such-device': 'text-led-danger',
  'already-assigned': 'text-led-warn',
  'no-path': 'text-led-warn',
}

/**
 * One row of the bulk-add preview, after `buildPairings`'s own anomaly note
 * is joined with the one anomaly THIS call site knows about that the pure
 * function cannot: whether the paired device is already listed in this
 * group's own `entries` (added earlier by the device picker, a previous bulk
 * commit in the same dialog session, or an overlapping range run twice).
 * `row.note === 'already-assigned'` is a different, farm-wide fact (the
 * Assignments tab's own note) and is deliberately NOT treated as a reason to
 * skip here — a device can belong to an Assignments-tab note and to this
 * group at the same time; they are unrelated records.
 */
export interface BulkEntryPlan {
  row: PairingRow
  alreadyInGroup: boolean
  /** The entry this row would add, or `null` when nothing can be written — no matching device, no path to pair with, or already in this group. Never guessed, never a partial record. */
  entry: EntryDraft | null
}

/**
 * Pure. Mirrors `EditGroupDialog`'s own `addEntry` exactly for the one field
 * that function computes rather than copies straight from a `PairingRow`:
 * `lanIp` comes from the device's resolved LAN address, or `EMPTY_LAN` when
 * it has none — never invented, never left for `buildPairings` to guess,
 * since `buildPairings` (`bulk-builder.tsx`) knows nothing about LAN
 * addresses at all.
 */
export function planBulkGroupEntries(rows: readonly PairingRow[], devices: readonly FleetDeviceRow[], usedDeviceIds: ReadonlySet<string>): BulkEntryPlan[] {
  return rows.map((row) => {
    const alreadyInGroup = row.deviceId !== null && usedDeviceIds.has(row.deviceId)
    if (row.deviceId === null || row.pathId === null || alreadyInGroup) {
      return { row, alreadyInGroup, entry: null }
    }
    const device = devices.find((d) => d.deviceId === row.deviceId)
    const lanIp = device && device.lan.state === 'resolved' ? device.lan.lanIp : EMPTY_LAN
    return { row, alreadyInGroup, entry: { deviceId: row.deviceId, lanIp, pathId: row.pathId } }
  })
}

/**
 * Which device numbers are carried by more than one enrolled device — the
 * one gap step 131.1 flagged rather than papering over: `buildPairings`
 * looks up a device by number through a `Map`, so a duplicated number has one
 * device win silently and the other read as `no-such-device`. This screen
 * cannot fix the ambiguity (there is no way to know which of the two the
 * operator meant), but it CAN say the ambiguity exists, cheaply, from the
 * same `devices` array already in hand — so a row is never just wrong with
 * no explanation.
 */
function duplicatedDeviceNumbers(devices: readonly FleetDeviceRow[]): ReadonlySet<number> {
  const counts = new Map<number, number>()
  for (const d of devices) {
    if (d.number !== null) counts.set(d.number, (counts.get(d.number) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n))
}

function BulkAddDialog({
  open,
  onOpenChange,
  devices,
  paths,
  usedDeviceIds,
  onCommit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  devices: FleetDeviceRow[]
  paths: Path[]
  usedDeviceIds: ReadonlySet<string>
  onCommit: (entries: EntryDraft[]) => void
}) {
  const [fromText, setFromText] = useState('1')
  const [toText, setToText] = useState('1')
  const [pathStartIndex, setPathStartIndex] = useState(0)
  const [overflow, setOverflow] = useState<BulkPairing['overflow']>('stop')

  // Re-seed whenever the dialog is (re)opened — the same `open`-keyed pattern
  // `EditGroupDialog` uses above, so a second bulk-add in the same session
  // does not inherit the previous one's typed range.
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setFromText('1')
      setToText('1')
      setPathStartIndex(0)
      setOverflow('stop')
    }
  }

  const fromNumber = Number.parseInt(fromText, 10)
  const toNumber = Number.parseInt(toText, 10)
  const rangeValid = Number.isInteger(fromNumber) && Number.isInteger(toNumber) && fromText.trim() !== '' && toText.trim() !== '' && toNumber >= fromNumber

  const duplicateNumbers = useMemo(() => duplicatedDeviceNumbers(devices), [devices])

  // Pure preview — computed, never written, until "Add" below (§4.4's rule
  // aimed at this dialog, per §3.1/§0.1).
  const rows: PairingRow[] = useMemo(() => {
    if (!rangeValid) return []
    return buildPairings({ fromNumber, toNumber, pathStartIndex, overflow }, devices, paths)
  }, [rangeValid, fromNumber, toNumber, pathStartIndex, overflow, devices, paths])

  const plans = useMemo(() => planBulkGroupEntries(rows, devices, usedDeviceIds), [rows, devices, usedDeviceIds])
  const writable = plans.filter((p) => p.entry !== null)

  function commit(): void {
    if (writable.length === 0) return
    onCommit(writable.map((p) => p.entry as EntryDraft))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk add by device number</DialogTitle>
          <DialogDescription>
            A range of device numbers, paired positionally against paths starting at the one you choose — the owner's own ask (§0.1). Nothing is added to this group until you confirm below; every
            row's preview is exactly what gets written.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 @sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">From device #</label>
              <Input type="number" value={fromText} onChange={(e) => setFromText(e.target.value)} className="readout" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">To device #</label>
              <Input type="number" value={toText} onChange={(e) => setToText(e.target.value)} className="readout" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-fg-muted">When devices outrun the paths</label>
              <Select value={overflow} onValueChange={(v) => setOverflow(v as BulkPairing['overflow'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stop">Stop — leave the rest unpaired (recommended)</SelectItem>
                  <SelectItem value="wrap">Wrap — reuse paths from the start</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-fg-muted">Starting path</label>
            <Combobox
              value={paths[pathStartIndex]?.id ?? ''}
              onValueChange={(v) => {
                const idx = paths.findIndex((p) => p.id === v)
                if (idx >= 0) setPathStartIndex(idx)
              }}
              options={pathOptions({ paths, selectedPathId: paths[pathStartIndex]?.id ?? '' })}
              placeholder="Choose the first path"
              searchPlaceholder="Filter paths…"
              emptyText="No path matches."
              ariaLabel="Starting path for the bulk pairing"
              triggerClassName="h-8 w-full text-[12px]"
              disabled={paths.length === 0}
            />
            <p className="text-[11px] text-fg-muted">Device #{Number.isFinite(fromNumber) ? fromNumber : '?'} pairs with this path; each following device number pairs with the next path in the Paths tab's own order.</p>
          </div>

          {!rangeValid ? (
            <p className="text-[12px] text-led-danger">Enter whole numbers with "To" greater than or equal to "From".</p>
          ) : rows.length === 0 ? (
            <p className="text-[12px] text-fg-muted">Nothing to preview yet.</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[12px] text-fg-muted">
                {writable.length} of {rows.length} device{rows.length === 1 ? '' : 's'} in this range will be added to the group.
              </p>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">#</TableHead>
                      <TableHead>Device</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead>Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plans.map((plan) => {
                      const { row } = plan
                      const ambiguous = duplicateNumbers.has(row.deviceNumber)
                      return (
                        <TableRow key={row.deviceNumber} className={cn(plan.entry === null && 'bg-led-warn/5')}>
                          <TableCell className="readout">{row.deviceNumber}</TableCell>
                          <TableCell>{row.deviceId ? labelFor(row.deviceId, devices) : <span className="text-fg-muted">—</span>}</TableCell>
                          <TableCell className="readout">{row.pathLabel ?? <span className="text-fg-muted">—</span>}</TableCell>
                          <TableCell className={cn('text-[11px]', plan.alreadyInGroup ? 'text-led-warn' : PAIRING_NOTE_TONE[row.note])}>
                            {plan.alreadyInGroup ? 'already in this group' : PAIRING_NOTE_LABEL[row.note]}
                            {ambiguous ? <div className="text-led-danger">{'>'}1 device shares number #{row.deviceNumber} — ambiguous, resolved to one of them</div> : null}
                          </TableCell>
                        </TableRow>
                      )
                    })}
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
          <Button disabled={writable.length === 0} onClick={commit}>
            Add {writable.length} device{writable.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
  /**
   * Devices ticked in the picker but not yet added (field report,
   * 2026-08-26). An array, not a single id: this used to be a one-at-a-time
   * `<Combobox>` + Add, so putting twelve phones in a group meant twelve
   * open-search-pick-Add cycles. `DevicePickerDialog`'s own dialog now
   * carries the multi-select and its own confirm button, so this stays
   * empty between opens (`addEntry` clears it once devices land in
   * `entries`) — kept as `addEntry`'s parameter default rather than removed,
   * so the entry-building logic itself (default lanIp/pathId, one call per
   * batch) is unchanged from the pre-`DevicePickerDialog` picker (plan 129
   * §5 step 129.7, renamed to `DevicePickerDialog` by plan 216 §4.10).
   */
  const [pendingDeviceIds, setPendingDeviceIds] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  /** The bulk-by-number builder (plan 131 §3.1, step 131.3) — a second, complementary way to add devices, beside the picker above. Neither replaces the other (§3.1's own instruction). */
  const [bulkOpen, setBulkOpen] = useState(false)
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
    setPendingDeviceIds([])
    setPickerOpen(false)
    setBulkOpen(false)
    setError(null)
  }

  const dupes = duplicateDeviceIdsLocal(entries)
  const usedDeviceIds = new Set(entries.map((e) => e.deviceId))
  const addableDevices = devices.filter((d) => !usedDeviceIds.has(d.deviceId))

  /**
   * `ids` defaults to `pendingDeviceIds` so this keeps the exact shape it has
   * had since the picker gained a multi-select: several ids in, one batch of
   * entries out, each seeded with its device's resolved LAN address (or the
   * empty placeholder) and the fleet's first path. `DevicePickerDialog`'s own
   * dialog confirm now calls this directly with the ids it hands back, rather
   * than staging them in `pendingDeviceIds` for a second, separate "Add"
   * click.
   */
  function addEntry(ids: string[] = pendingDeviceIds): void {
    const picked = ids
      .map((id) => devices.find((d) => d.deviceId === id))
      .filter((d): d is FleetDeviceRow => d !== undefined)
    if (picked.length === 0) return
    setEntries((prev) => [
      ...prev,
      ...picked.map((device) => ({
        deviceId: device.deviceId,
        lanIp: device.lan.state === 'resolved' ? device.lan.lanIp : EMPTY_LAN,
        pathId: paths[0]?.id ?? '',
      })),
    ])
    setPendingDeviceIds([])
  }

  /**
   * `BulkAddDialog`'s own commit — it has already run `planBulkGroupEntries`
   * and shown every row before this is ever called, so here there is nothing
   * left to validate: the entries handed in are exactly what the preview
   * showed (§3.1's own rule, "the preview renders exactly what gets
   * written"). Appended the same way `addEntry` appends above, never a
   * second entries-mutation shape.
   */
  function addEntriesFromBulk(newEntries: EntryDraft[]): void {
    if (newEntries.length === 0) return
    setEntries((prev) => [...prev, ...newEntries])
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
                <Button size="sm" variant="outline" disabled={addableDevices.length === 0} onClick={() => setPickerOpen(true)}>
                  Add devices…
                </Button>
                {/*
                  A second, complementary way in (plan 131 §3.1) — the picker
                  above is for choosing by name; this is for "devices 1
                  through 20 onto paths starting at index 3", the owner's own
                  verbatim ask (§0.1). Neither replaces the other. Not gated
                  on `addableDevices` the way the picker button is: a range
                  that includes a device already in this group is a
                  legitimate thing to type, and the preview names that row as
                  "already in this group" rather than refusing to open.
                */}
                <Button size="sm" variant="outline" disabled={devices.length === 0} onClick={() => setBulkOpen(true)}>
                  Bulk add by number…
                </Button>
              </div>
            </div>

            {/*
              Plan 124 §0.2 called this "the worst surface in the product" and
              went through a `Select` → `Combobox` → list-style `DevicePicker`
              → live-tile-wall progression (the owner's own verbatim ask for
              the wall is now the `0.8.0 → 0.9.0` changelog entry in
              `index.ts`, plan 216 §4.6/§10). Plan 216 replaces the live-tile
              wall with Studio's unified `DevicePicker` — MVP 07 §2.1's "one
              component, one hook, one place" — because the Screens view is
              now where a device is chosen by looking at its screen; this
              dialog is where one is chosen by name.

              `DevicePickerDialog` reaches Studio's own `DevicePicker` through
              `@enkaku/host` (plan 129 §3.4, §4.4; plan 216 §4.10) — a plugin
              cannot own the picker's live activity data itself, so this is
              Studio's own instance of the component, handed through the same
              host-module table `@enkaku/ui` already uses. `filter` keeps the
              picker to devices not already in this group; `onConfirm` calls
              `addEntry` directly with the ids it hands back, which is the
              same several-at-once entry-building `addEntry` already did for
              the list picker (plan 129 §5 step 129.7).
            */}
            {addableDevices.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12px] text-fg-muted">
                Every enrolled device is already in this group.
              </p>
            ) : null}
            <DevicePickerDialog
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              value={pendingDeviceIds}
              onConfirm={(ids) => addEntry(ids)}
              filter={(d) => !usedDeviceIds.has(d.id)}
              title="Choose devices for this group"
            />
            <BulkAddDialog open={bulkOpen} onOpenChange={setBulkOpen} devices={devices} paths={paths} usedDeviceIds={usedDeviceIds} onCommit={addEntriesFromBulk} />

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
      {/* Plan 132 §10 — the same mark `assignments.tsx` puts on a row that
          lands on a currently-down path. Without it this dialog wrote those
          rules and said nothing, which is §0.4's complaint one screen over. */}
      {'overDownPath' in row && row.overDownPath ? <span className="text-led-warn">(path is down — this device will have no internet until it returns)</span> : null}
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
  // Reuses the Assignments tab's own helper rather than a second copy — the
  // two dialogs must never disagree about which rows land on a down path.
  const overDownPath = previewOk ? summariseOverDownPath(previewOk.plan) : null
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

            {/* Plan 132 §4.3, extended here per §10: ABOVE the scrolling list,
                never below it. Activating a group with a down path writes the
                rule and takes those devices offline — deliberately, because an
                assignment is a constraint — but an operator must be told
                before they scroll, not after. */}
            {overDownPath ? (
              <div className="space-y-1 rounded-lg border border-led-warn/40 bg-led-warn/5 p-3">
                <p className="text-[12px] font-medium text-led-warn">
                  {overDownPath.count} device{overDownPath.count === 1 ? '' : 's'} will lose internet: {overDownPath.pathIds.join(', ')} {overDownPath.pathIds.length === 1 ? 'is' : 'are'} down.
                </p>
                <p className="text-[11px] leading-relaxed text-fg-muted">
                  The rule is written anyway, and that is the point — a device keeps the egress path you assigned it instead of falling back to another one. Traffic resumes on its own when the path returns.
                </p>
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
