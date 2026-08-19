'use client'

import { Plus, Trash2 } from 'lucide-react'
import {
  Button,
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
 * The shared range-row table (plan 88 §5) — the ONE editing surface for
 * `discovery.networks`, mounted by both `FarmNetworksEditor.tsx` (Settings →
 * Discovery & monitoring) and `ScanNetworkDialog.tsx` (the Devices page's
 * "Scan network" modal). Same "one implementation, not two vocabularies"
 * reasoning already applied to `ActionsList`/`DeviceContextMenu`
 * (docs/plans/96-m61-hotfixes.md) — a farm's network list must read and edit
 * identically no matter which door an operator walked in through.
 *
 * Deliberately narrow: this owns ONLY the row table, the add-row button, and
 * the budget readout — not the empty state (its wording differs by caller:
 * Settings' says "the sweep cannot run", the modal's says "add a range to
 * scan"), not Save/Scan buttons (each caller's own action set differs), and
 * not the FARM-WIDE port field (`ScanNetworkDialog` only — `discovery.tcpPort`
 * is already editable elsewhere on the Settings page, see `network-ranges.ts`'s
 * header comment). A controlled component: all state lives in the caller's
 * `useNetworkRanges()` hook.
 *
 * The PER-ROW port override column below (plan 88 §9 Q7, resolved; `docs/
 * plans/96-m61-hotfixes.md` §96.44's follow-up) is a different thing from
 * the farm-wide field just described: this is `discovery.networks[].port`,
 * an optional override for ONE range, blank meaning "inherit the farm
 * default" — shown here, in the shared table, because it is a per-row
 * value like every other column in this component, unlike the single
 * farm-wide port which has exactly one caller and no row to live in.
 */
export function RangeNetworksFields({
  rows,
  setRow,
  removeRow,
  addRow,
  maxAddresses,
  scannedTotal,
  farmPort,
}: {
  rows: RangeRow[]
  setRow: (i: number, patch: Partial<RangeRow>) => void
  removeRow: (i: number) => void
  addRow: () => void
  maxAddresses: number
  scannedTotal: number
  /** The farm-wide `discovery.tcpPort`, shown as each row's Port placeholder — so a blank cell reads as "inherits N", not just "blank". */
  farmPort: number
}) {
  const overLimit = scannedTotal > maxAddresses

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
              <TableHead className="text-right">Addresses</TableHead>
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
                      className={cn('h-8 w-32 font-mono text-[12px]', err && 'border-led-danger text-led-danger')}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={row.endIp}
                      onChange={(e) => setRow(i, { endIp: e.target.value })}
                      placeholder="10.20.0.255"
                      aria-label={`Range ${i + 1} end IP`}
                      aria-invalid={!!err}
                      className={cn('h-8 w-32 font-mono text-[12px]', err && 'border-led-danger text-led-danger')}
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
                      className={cn('readout h-8 w-20 text-[12px]', portErr && 'border-led-danger text-led-danger')}
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
                      className="h-8 w-32 text-[12.5px]"
                    />
                  </TableCell>
                  <TableCell>
                    <Select value={row.medium} onValueChange={(v) => setRow(i, { medium: v as NetworkMedium })}>
                      <SelectTrigger className="h-8 w-28 text-[12.5px]" aria-label={`Range ${i + 1} medium`}>
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
                  <TableCell className="readout text-right text-[12px] text-fg-muted">{count === null ? '—' : count.toLocaleString()}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove range ${i + 1}`} onClick={() => removeRow(i)}>
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
          <Plus className="size-3.5" aria-hidden /> Add a range
        </Button>
        <p className={cn('readout text-[12px]', overLimit ? 'font-semibold text-led-danger' : 'text-fg-muted')}>
          {scannedTotal.toLocaleString()} / {maxAddresses.toLocaleString()} addresses in the sweep
          {overLimit && ' — over the limit: untick one, narrow a range, or raise the limit under Network scan'}
        </p>
      </div>
    </>
  )
}
