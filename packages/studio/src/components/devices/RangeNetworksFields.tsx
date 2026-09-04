'use client'

import {
  Button,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  Input,
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
  cn,
} from '@enkaku/ui'
import { rangeAddressCount, rangeError, rowPortError, type NetworkMedium, type RangeRow } from '@/lib/ip-range'

/**
 * The range-row table — the ONE editing surface for `networkScan.networks`,
 * mounted by `ScanNetworkDialog.tsx` (Devices → the fleet menu → Scan
 * networks). It used to have two callers, the other being Settings'
 * `FarmNetworksEditor`; the owner asked for the Settings section to go
 * (2026-09-04, "yang di settings pages dihapus aja biar ga menuh menuhin
 * settings"), so the editor is deleted and this table moved from
 * `components/settings/` to here, beside the only screen that mounts it.
 *
 * Rows are edited as a start/end IP range, not raw CIDR (the owner's own
 * earlier request, verbatim: "input dinamis untuk range ip: [ip start] - [ip
 * end]") — `networkScan.networks[]` itself stays CIDR-native
 * (`packages/core/src/registry/sweep.ts`, `CidrSchema`) and is never
 * rewritten; `@/lib/ip-range` is the presentation-layer bridge.
 *
 * Deliberately narrow: this owns ONLY the row table, the add-row button, and
 * the budget readout — not the empty state, not Save, not "Scan all". A
 * controlled component: all state lives in the caller's `useNetworkRanges()`
 * hook.
 *
 * The PER-ROW port override column (plan 88 §9 Q7, resolved) is
 * `networkScan.networks[].port`, an optional override for ONE range, blank
 * meaning "inherit the farm default" — distinct from the farm-wide port,
 * which is the constant `ADB_TCP_PORT` since plan 212 §4.1 and is shown
 * here only as each cell's placeholder.
 *
 * `onScanRow` adds the per-row Scan button (the owner's competitor
 * reference has one; so does this). It is optional, and a row that is
 * unsaved, invalid or unticked does not get one — the server refuses a
 * narrowing that names no saved, ticked range, and a button that can only
 * produce that refusal is worse than no button.
 */
export function RangeNetworksFields({
  rows,
  setRow,
  removeRow,
  addRow,
  maxAddresses,
  scannedTotal,
  farmPort,
  onScanRow,
  scanningRow,
  savedRowIndexes,
}: {
  rows: RangeRow[]
  setRow: (i: number, patch: Partial<RangeRow>) => void
  removeRow: (i: number) => void
  addRow: () => void
  maxAddresses: number
  scannedTotal: number
  /** The farm-wide adb TCP port (the `ADB_TCP_PORT` constant), shown as each row's Port placeholder — so a blank cell reads as "inherits N", not just "blank". */
  farmPort: number
  /** Sweeps just this row's ranges. Omitted, the Scan column is not rendered at all. */
  onScanRow?: (i: number) => void
  /** The row index currently being swept, if any — its button reads "Scanning…" and every other row's is disabled. */
  scanningRow?: number | null
  /** A row whose edits are not saved yet cannot be scanned: the server sweeps what is stored, never what is on screen. */
  savedRowIndexes?: ReadonlySet<number>
}) {
  const overLimit = scannedTotal > maxAddresses

  /**
   * A row is scannable only when the server could actually act on it: saved,
   * valid, and ticked. Anything else would come back as this dialog's own
   * "save the range first, then scan it" refusal — surfaced here as a
   * disabled button with the reason on it, never as a click that fails
   * afterwards for something Studio already knew.
   */
  const scanRowReason = (i: number): string | null => {
    const row = rows[i]
    if (!row) return 'No such range'
    if (rangeError(row.startIp, row.endIp) !== null || !row.startIp.trim() || !row.endIp.trim()) return 'Fix this range first'
    if (rowPortError(row.port) !== null) return 'Fix this port first'
    if (!row.scan) return 'This range is not included in a sweep — turn Sweep on for it'
    if (savedRowIndexes && !savedRowIndexes.has(i)) return 'Save this range before scanning it — a sweep probes what is stored, not what is on screen'
    return null
  }
  const scannableRow = (i: number) => scanRowReason(i) === null

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Start IP</TableHead>
              <TableHead>End IP</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Medium</TableHead>
              <TableHead>Sweep</TableHead>
              <TableHead className="text-right whitespace-nowrap">Addr.</TableHead>
              {onScanRow && <TableHead />}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => {
              const err = rangeError(row.startIp, row.endIp)
              const count = err || !row.startIp.trim() || !row.endIp.trim() ? null : rangeAddressCount(row.startIp, row.endIp)
              const portErr = rowPortError(row.port)
              return (
                <TableRow key={i}>
                  <TableCell>
                    <Input
                      value={row.startIp}
                      onChange={(e) => setRow(i, { startIp: e.target.value })}
                      placeholder="10.20.0.0"
                      aria-label={`Range ${i + 1} start IP`}
                      aria-invalid={!!err}
                      className={cn('h-8 w-28 font-mono text-[12px]', err && 'border-led-danger text-led-danger')}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={row.endIp}
                      onChange={(e) => setRow(i, { endIp: e.target.value })}
                      placeholder="10.20.0.255"
                      aria-label={`Range ${i + 1} end IP`}
                      aria-invalid={!!err}
                      className={cn('h-8 w-28 font-mono text-[12px]', err && 'border-led-danger text-led-danger')}
                    />
                    {err && <p className="mt-1 text-[10.5px] text-led-danger">{err}</p>}
                  </TableCell>
                  <TableCell>
                    <Input
                      value={row.port === undefined ? '' : String(row.port)}
                      onChange={(e) => {
                        const raw = e.target.value.trim()
                        setRow(i, { port: raw === '' ? undefined : Number(raw) })
                      }}
                      placeholder={String(farmPort)}
                      inputMode="numeric"
                      aria-label={`Range ${i + 1} port (optional override)`}
                      aria-invalid={!!portErr}
                      className={cn('readout h-8 w-[68px] text-[12px]', portErr && 'border-led-danger text-led-danger')}
                    />
                    {portErr && <p className="mt-1 text-[10.5px] text-led-danger">{portErr}</p>}
                  </TableCell>
                  <TableCell>
                    <Input
                      value={row.label}
                      onChange={(e) => setRow(i, { label: e.target.value })}
                      placeholder="Chassis A"
                      maxLength={40}
                      aria-label={`Range ${i + 1} label`}
                      className="h-8 w-28 text-[12.5px]"
                    />
                  </TableCell>
                  <TableCell>
                    <Select value={row.medium} onValueChange={(v) => setRow(i, { medium: v as NetworkMedium })}>
                      <SelectTrigger className="h-8 w-24 text-[12.5px]" aria-label={`Range ${i + 1} medium`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="wired">Wired</SelectItem>
                        <SelectItem value="wireless">Wi-Fi</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Switch checked={row.scan} onCheckedChange={(v) => setRow(i, { scan: v })} aria-label={`Include range ${i + 1} in a sweep`} />
                  </TableCell>
                  <TableCell className="readout text-right text-[12px] text-faint">{count === null ? '—' : count.toLocaleString()}</TableCell>
                  {onScanRow && (
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-[12px]"
                        disabled={scanningRow !== null && scanningRow !== undefined ? true : !scannableRow(i)}
                        title={scanRowReason(i) ?? undefined}
                        onClick={() => onScanRow(i)}
                      >
                        <MagnifyingGlassIcon className="size-3.5" aria-hidden />
                        {scanningRow === i ? 'Scanning…' : 'Scan'}
                      </Button>
                    </TableCell>
                  )}
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove range ${i + 1}`} onClick={() => removeRow(i)}>
                      <TrashIcon className="size-3.5" aria-hidden />
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
          <PlusIcon className="size-3.5" aria-hidden /> Add a range
        </Button>
        <p className={cn('readout text-[12px]', overLimit ? 'font-semibold text-led-danger' : 'text-faint')}>
          {scannedTotal.toLocaleString()} / {maxAddresses.toLocaleString()} addresses in the sweep
          {overLimit && ' — over the limit: untick one, or narrow a range'}
        </p>
      </div>
    </>
  )
}
