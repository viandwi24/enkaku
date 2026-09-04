'use client'

import { useState } from 'react'
import type { SweepReport } from '@enkaku/protocol'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingRows,
  MagnifyingGlassIcon,
  PlusIcon,
  cn,
} from '@enkaku/ui'
import { rangeToCidrs } from '@/lib/ip-range'
import { useNetworkRanges } from '@/lib/network-ranges'
import { scanDisabledReason, summariseSweepReport, useNetworkScan } from '@/lib/network-scan'
import { RangeNetworksFields } from './RangeNetworksFields'

/**
 * Scan networks (the fleet menu on Devices; owner, 2026-09-04) — the address
 * space the bounded sweep may probe, and the sweep itself, on one screen.
 *
 * It replaces Settings → Network scan, which is gone: the operator's own
 * reasoning was that a list you edit while standing at the rack does not
 * belong three clicks deep in Settings, and that Settings should not fill up
 * with it. The setting itself is untouched — `networkScan.networks` is still
 * the only address space a sweep can use, still saved through `PATCH
 * /api/settings`, still never guessed from this computer's own subnets
 * (`registry/sweep.ts` §3.5: a laptop on a corporate /16 would otherwise
 * sweep 65,536 addresses because someone pressed a button).
 *
 * Deliberately NOT merged with the OTG dialog next to it in the same menu,
 * though the competitor this was modelled on puts both in one card. They are
 * two different jobs at two different moments: enabling OTG is something you
 * do to phones you can see, with a cable in your hand; scanning is something
 * you do to a network, to find phones you cannot see. One card asking "which
 * of these two am I doing?" is the thing the owner specifically did not
 * want.
 */
export function ScanNetworkDialog({ open, onOpenChange, onScanned }: { open: boolean; onOpenChange: (open: boolean) => void; onScanned: () => void }) {
  const { rows, savedRowIndexes, maxAddresses, tcpPort, error, load, setRow, removeRow, addRow, save, saving, scannedTotal, overLimit, hasInvalidRow, dirty } =
    useNetworkRanges()
  const { scan, scanning, lastReport } = useNetworkScan(onScanned)
  /** Which row's Scan button is in flight, so the other rows' buttons can say why they are disabled. `null` = a whole-farm sweep, or nothing running. */
  const [scanningRow, setScanningRow] = useState<number | null>(null)

  const scanAllDisabled = scanDisabledReason(rows === null ? null : rows.map((r) => ({ scan: r.scan })))

  const scanRow = async (i: number) => {
    const row = rows?.[i]
    if (!row) return
    const cidrs = rangeToCidrs(row.startIp.trim(), row.endIp.trim())
    if (!cidrs) return
    setScanningRow(i)
    try {
      await scan(cidrs)
    } finally {
      setScanningRow(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Scan networks</DialogTitle>
          <DialogDescription>
            The ranges Enkaku is allowed to dial, and the sweep itself. A sweep only ever probes the ranges listed here
            with Sweep on — it is never derived from this computer&apos;s own network, and it never runs on a timer.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows === null ? (
          <LoadingRows rows={3} />
        ) : (
          /*
           * `min-w-0` is load-bearing, not decoration. `DialogContent` is a
           * grid, and a grid item's default `min-width: auto` means this
           * column grows to fit the widest thing inside it — so the range
           * table pushed the whole dialog past its own `max-w`, spilling the
           * header text and the footer buttons off the right edge (owner,
           * 2026-09-04) while the table's own `overflow-x-auto` never
           * scrolled, because nothing was ever constraining it.
           */
          <div className="min-w-0">
            <p className="mb-3 rounded-inner border border-line-2 bg-panel-2 px-3 py-2 text-meta leading-relaxed text-faint">
              <strong className="font-semibold text-text">Wired or Wi-Fi is a claim you are making, not something Enkaku measured.</strong> adb cannot
              tell a switch port from a radio — only you can. What you pick here is what turns a device found on this
              network into an OTG badge or a WI-FI badge.
            </p>

            {rows.length === 0 ? (
              <EmptyState
                title="No ranges yet — a sweep cannot run"
                description="Add the IP range your device chassis lives on, like 10.20.0.0 – 10.20.0.255, so Enkaku knows where to look. With nothing here, a device that goes missing over the network can only be found by its remembered address."
                action={
                  <Button size="sm" onClick={addRow}>
                    <PlusIcon className="size-3.5" aria-hidden /> Add a range
                  </Button>
                }
              />
            ) : (
              <RangeNetworksFields
                rows={rows}
                setRow={setRow}
                removeRow={removeRow}
                addRow={addRow}
                maxAddresses={maxAddresses}
                scannedTotal={scannedTotal}
                farmPort={tcpPort}
                onScanRow={(i) => void scanRow(i)}
                scanningRow={scanning ? scanningRow : null}
                savedRowIndexes={savedRowIndexes}
              />
            )}

            {lastReport && <SweepSummary report={lastReport} />}
          </div>
        )}

        <DialogFooter className="items-center">
          <p className={cn('mr-auto min-w-0 text-meta', dirty ? 'text-led-warn' : 'text-faint')}>
            {dirty ? 'Unsaved changes — a sweep probes what is saved, not what is on screen.' : 'Saved.'}
          </p>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="outline" onClick={() => void save()} disabled={!dirty || saving || hasInvalidRow || overLimit}>
            {saving ? 'Saving…' : 'Save ranges'}
          </Button>
          <Button
            disabled={!!scanAllDisabled || scanning || dirty}
            title={scanAllDisabled ?? (dirty ? 'Save the ranges first — a sweep probes what is stored' : undefined)}
            onClick={() => {
              setScanningRow(null)
              void scan()
            }}
          >
            <MagnifyingGlassIcon className={cn('size-3.5', scanning && scanningRow === null && 'animate-enkaku-spin')} aria-hidden />
            {scanning && scanningRow === null ? 'Scanning…' : 'Scan all'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The report, not just a count. A sweep that answered on four addresses and
 * adopted none is a different event from one that found nothing at all, and
 * an address conflict is the one line an operator must not miss — the
 * address book remembers that address for a different phone, which is a real
 * misconfiguration and not a transient miss.
 */
function SweepSummary({ report }: { report: SweepReport }) {
  return (
    <div className="mt-4 rounded-inner border border-line-2 px-3 py-2.5">
      <p className="text-row text-text">{summariseSweepReport(report)}</p>
      <p className="mt-1 readout text-meta text-faint">
        {report.networks.map((n) => `${n.cidr}${n.label ? ` (${n.label})` : ''} :${n.port}`).join(' · ')} · {report.skipped} already known ·{' '}
        {report.connected} connected · {report.identified} identified · {(report.durationMs / 1000).toFixed(1)}s
      </p>
      {report.conflicts.length > 0 && (
        <ul className="mt-2 space-y-1">
          {report.conflicts.map((c) => (
            <li key={c.address} className="readout text-meta text-led-danger">
              {c.address} answered as {c.found}, but the address book remembers it for {c.expected} — not adopted.
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
