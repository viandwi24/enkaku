'use client'

import { useEffect, useState } from 'react'
import { Network, Plus, ScanSearch, Trash2 } from 'lucide-react'
import { addressCount, CidrSchema, SettingsResponseSchema, UpdateSettingsResponseSchema, type FarmSettings } from '@enkaku/protocol'
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  cn,
  useAction,
} from '@enkaku/ui'
import { scanDisabledReason, summariseSweepReport, useNetworkScan } from '@/lib/network-scan'

type FarmNetwork = FarmSettings['discovery']['networks'][number]

function emptyRow(): FarmNetwork {
  return { cidr: '', label: '', medium: 'wired', scan: true }
}

/**
 * `null` when the field is blank (nothing to say yet, so no red border on a
 * fresh row) or a valid CIDR; the message otherwise. Never throws — this
 * runs on every keystroke, so it mirrors `CidrSchema` without ever needing a
 * try/catch around it.
 */
function cidrError(cidr: string): string | null {
  const trimmed = cidr.trim()
  if (!trimmed) return null
  return CidrSchema.safeParse(trimmed).success ? null : 'must be an IPv4 CIDR, like 10.20.0.0/24'
}

/**
 * The farm networks editor (plan 88 §3.4, §3.5, §3.6, §4.2, §5 step 88.6) —
 * the ONLY way a network enters the bounded sweep's address space, since
 * `discovery.networks` is never auto-derived from this computer's own
 * subnets (§3.5: a laptop on a corporate /16 would otherwise sweep 65,536
 * addresses because someone pressed a button).
 *
 * BESPOKE, not `SchemaForm` — decided deliberately, not because the generic
 * renderer crashes on this shape. Row 10 of the resolver's precedence table
 * (`docs/design.md` "Schema-driven forms") already turns an array of
 * objects into a real per-column table (`TableControl`), so `networks`
 * would render as text/choice/toggle cells without corruption. What that
 * generic table cannot do, and what this feature specifically needs:
 *   1. a LIVE per-row address count derived from `cidr` (`addressCount()`)
 *      — not a schema field, so there is no column for it, and the
 *      vocabulary's `kind` enum (`docs/design.md`'s nine closed entries) has
 *      no "computed from a sibling cell" kind to add without becoming a
 *      one-off invented just for this field;
 *   2. a RUNNING TOTAL across every scanned row, checked against
 *      `discovery.scan.maxAddresses` — a sibling of `networks`, not even in
 *      the same array, so it has no cell to live in at all; the schema's own
 *      cross-field `superRefine` (`settings.ts`) only fires at Save, and a
 *      refinement that fires only at Save is worse than a number that was
 *      visible the whole time (plan 88 §5 step 88.6's own framing);
 *   3. the "a claim, not an observation" help text `medium` needs — a
 *      `.describe()` on one enum field is one static sentence, not the
 *      dedicated warning this column's real-world consequence (a fleet of
 *      confidently wrong OTG/WI-FI badges) deserves;
 *   4. a domain-specific empty state — "a farm with no networks configured
 *      cannot sweep at all" — where the generic table's empty state is just
 *      an empty grid and an Add-row button.
 * Inventing a vocabulary key that only this one field would ever use is
 * exactly the trap `docs/design.md`'s closed `kind` list exists to avoid —
 * so this is a small owned component instead, the same shape as `KvPanel`
 * and `AdbDiagnosticsPanel` already mounted beside (never replacing)
 * `SchemaForm` on this same page.
 *
 * Independent load/save cycle, on purpose: `settings/page.tsx` excludes
 * `networks` from the `discovery` section's generic `FarmForm` (two editors
 * bound to the same array would drift out of sync between saves), and this
 * panel PATCHes only `{ discovery: { networks } }` — the settings store's
 * shallow per-key merge (`packages/core/src/settings/farm-settings.ts`)
 * folds that into the rest of `discovery` untouched, so this save can never
 * clobber `scanIntervalSec`, `scan.mode`, or anything else in the block.
 */
export function FarmNetworksEditor() {
  const [rows, setRows] = useState<FarmNetwork[] | null>(null)
  const [maxAddresses, setMaxAddresses] = useState(1024)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const { scan, scanning, lastReport } = useNetworkScan()

  const load = () => {
    setError(null)
    setRows(null)
    api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setRows(b.settings.discovery.networks)
        setMaxAddresses(b.settings.discovery.scan.maxAddresses)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const setRow = (i: number, patch: Partial<FarmNetwork>) => setRows((prev) => (prev ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setRows((prev) => (prev ?? []).filter((_, j) => j !== i))
  const addRow = () => setRows((prev) => [...(prev ?? []), emptyRow()])

  const save = () => {
    if (!rows) return
    void run(
      'save-networks',
      () =>
        api('/api/settings', UpdateSettingsResponseSchema, {
          method: 'PATCH',
          json: { discovery: { networks: rows.map((r) => ({ ...r, cidr: r.cidr.trim(), label: r.label.trim() })) } },
        }),
      {
        success: 'Farm networks saved',
        failure: 'Could not save these networks',
        onSuccess: (b) => {
          setRows(b.settings.discovery.networks)
          setMaxAddresses(b.settings.discovery.scan.maxAddresses)
        },
      },
    )
  }

  if (error) return <ErrorState message={error} onRetry={load} />
  if (rows === null) return <LoadingRows rows={2} />

  const scannedTotal = rows.reduce((sum, r) => sum + (r.scan ? addressCount(r.cidr.trim()) : 0), 0)
  const overLimit = scannedTotal > maxAddresses
  const hasInvalidRow = rows.some((r) => cidrError(r.cidr) !== null || !r.cidr.trim())
  const dirty = rows.length > 0
  // Computed off `rows` — the table as currently DISPLAYED, which is the
  // saved config until an edit is made and Save is clicked. A sweep run
  // between an edit and a Save still probes whatever is actually saved
  // server-side, not the pending edit; that gap is surfaced honestly by the
  // report itself (`networks` names exactly what was swept) rather than
  // guessed at here.
  const scanDisabled = scanDisabledReason(rows)

  return (
    <div className="max-w-3xl py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="rack-label">Farm networks</h3>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!!scanDisabled || scanning}
          title={scanDisabled ?? undefined}
          onClick={() => void scan()}
        >
          <ScanSearch className={`size-3.5 ${scanning ? 'animate-pulse' : ''}`} aria-hidden />
          {scanning ? 'Scanning…' : 'Scan network'}
        </Button>
      </div>
      <p className="mb-3 max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
        The address space the bounded sweep is allowed to probe — an explicit list, never guessed from this computer's own network. Add every network your device chassis lives on; only rows with "Include in a sweep" ticked are ever probed, and the total below can never exceed the farm's scan ceiling.
      </p>
      <p className="mb-4 max-w-xl rounded-md border bg-surface-2 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
        <strong className="font-semibold text-fg">Wired or Wi-Fi is a claim you are making, not something Enkaku measured.</strong> adb cannot tell a switch port from a radio — only you can. Whatever medium you pick here is what turns a device found on this network into an OTG badge or a WI-FI badge. Get it wrong and every device on that network shows a confidently wrong badge.
      </p>
      {lastReport && <p className="mb-4 max-w-xl text-[12px] text-fg-muted">{summariseSweepReport(lastReport)}</p>}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Network className="size-4" aria-hidden />}
          title="No networks configured — the sweep cannot run"
          description='Add the CIDR block your device chassis lives on, like 10.20.0.0/24, so Enkaku knows where to look. With nothing here, "Scan network" stays disabled and a device that goes missing over the network can only be found by its remembered address.'
          action={
            <Button size="sm" onClick={addRow}>
              <Plus className="size-3.5" aria-hidden /> Add a network
            </Button>
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Network (CIDR)</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Medium</TableHead>
                  <TableHead>Sweep</TableHead>
                  <TableHead className="text-right">Addresses</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, i) => {
                  const err = cidrError(row.cidr)
                  const count = err || !row.cidr.trim() ? null : addressCount(row.cidr.trim())
                  return (
                    <TableRow key={i}>
                      <TableCell>
                        <Input
                          value={row.cidr}
                          onChange={(e) => setRow(i, { cidr: e.target.value })}
                          placeholder="10.20.0.0/24"
                          aria-label={`Network ${i + 1} CIDR`}
                          aria-invalid={!!err}
                          className={cn('h-8 w-40 font-mono text-[12px]', err && 'border-led-danger text-led-danger')}
                        />
                        {err && <p className="mt-1 text-[10.5px] text-led-danger">{err}</p>}
                      </TableCell>
                      <TableCell>
                        <Input
                          value={row.label}
                          onChange={(e) => setRow(i, { label: e.target.value })}
                          placeholder="Chassis A"
                          maxLength={40}
                          aria-label={`Network ${i + 1} label`}
                          className="h-8 w-32 text-[12.5px]"
                        />
                      </TableCell>
                      <TableCell>
                        <Select value={row.medium} onValueChange={(v) => setRow(i, { medium: v as FarmNetwork['medium'] })}>
                          <SelectTrigger className="h-8 w-28 text-[12.5px]" aria-label={`Network ${i + 1} medium`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="wired">Wired</SelectItem>
                            <SelectItem value="wireless">Wi-Fi</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Switch checked={row.scan} onCheckedChange={(v) => setRow(i, { scan: v })} aria-label={`Include network ${i + 1} in a sweep`} />
                      </TableCell>
                      <TableCell className="readout text-right text-[12px] text-fg-muted">{count === null ? '—' : count.toLocaleString()}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove network ${i + 1}`} onClick={() => removeRow(i)}>
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="size-3.5" aria-hidden /> Add a network
            </Button>
            <p className={cn('readout text-[12px]', overLimit ? 'font-semibold text-led-danger' : 'text-fg-muted')}>
              {scannedTotal.toLocaleString()} / {maxAddresses.toLocaleString()} addresses in the sweep
              {overLimit && ' — over the limit: untick one, narrow a range, or raise the limit under Network scan'}
            </p>
          </div>

          <div className="mt-4">
            <Button size="sm" onClick={save} disabled={!dirty || isPending('save-networks') || hasInvalidRow || overLimit}>
              Save networks
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
