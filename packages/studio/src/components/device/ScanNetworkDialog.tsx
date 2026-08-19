'use client'

import { useEffect, useState } from 'react'
import { Network, Plus } from 'lucide-react'
import type { SweepReport } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, Input, Label, LoadingRows } from '@enkaku/ui'
import { RangeNetworksFields } from '@/components/settings/RangeNetworksFields'
import { useNetworkRanges } from '@/lib/network-ranges'
import { scanDisabledReason, summariseSweepReport, useNetworkScan } from '@/lib/network-scan'

/**
 * "Scan network" (plan 88 §5, superseding step 88.12's navigate-away
 * shortcut) — the owner's own request, verbatim: "harusnya scan network ->
 * muncul modals ada input dinamis untuk range ip dan port ... bisa dinamis
 * gitu dan kesimpan, bisa ditambah, jadi semua setting langsung dimodal,
 * bisa di edit, di tambah, dan ada tombol langsung scan all nya" — a real,
 * self-contained scan-configuration modal, reachable ALWAYS from the
 * Devices page's fleet menu (never disabled, never a navigation away).
 *
 * Shares `useNetworkRanges` (`@/lib/network-ranges.ts`) and
 * `RangeNetworksFields` (`@/components/settings/RangeNetworksFields.tsx`)
 * with `FarmNetworksEditor.tsx` (Settings → Discovery & monitoring) — ONE
 * range-editing implementation mounted in both places, not two vocabularies
 * for the same feature (the same reasoning this session already applied to
 * merging `ActionsList`/`DeviceContextMenu`, docs/plans/96-m61-hotfixes.md).
 * They diverge only in their surrounding chrome:
 *   - this dialog is the ONLY place that edits `discovery.tcpPort` next to
 *     the ranges (`FarmNetworksEditor` does not need to — `tcpPort` is
 *     already on the same Settings page via the generic form; this modal
 *     has no such neighbour, so it is the right place per the task's own
 *     instruction);
 *   - this dialog has "Scan all" (save-if-dirty, then sweep, in one click —
 *     the owner's own "tombol langsung scan all nya"); `FarmNetworksEditor`
 *     keeps its pre-existing "Scan network" button, which only scans
 *     whatever is already saved, unchanged from before this modal existed.
 *
 * Per-range ports (plan 88 §9 Q7, resolved; `docs/plans/96-m61-hotfixes.md`
 * §96.44's follow-up): the owner's own sketch showed `[port]` per row, and
 * that gap is now closed — `discovery.networks[].port` is a real, optional
 * override, `sweep.ts` reads `net.port ?? cfg.tcpPort` per network, and
 * `RangeNetworksFields`'s own Port column (shared with `FarmNetworksEditor`)
 * edits it. The field below stays the single FARM-WIDE default and fallback
 * — still the right place for a new row's implicit port, and for every row
 * that leaves its own Port cell blank — with copy saying so plainly rather
 * than implying it is the only port a range can ever use.
 */
export function ScanNetworkDialog({
  open,
  onOpenChange,
  onScanned,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onScanned?: (report: SweepReport) => void
}) {
  const { rows, maxAddresses, tcpPort, error, load, setRow, removeRow, addRow, save, saving, scannedTotal, overLimit, hasInvalidRow, dirty } = useNetworkRanges({
    includePort: true,
  })
  const { scan, scanning, lastReport } = useNetworkScan(onScanned)
  const [portText, setPortText] = useState('')

  // The dialog's content stays mounted while closed (same pattern every
  // other dialog on this page already follows — `BulkCutoverDialog`,
  // `ForgetDeviceDialog`), so state has to be refreshed explicitly on each
  // open rather than relying on a fresh mount.
  useEffect(() => {
    if (open) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Kept in sync with the loaded/saved value, never while the operator is
  // actively editing it (`tcpPort` only changes on `load()`/a successful
  // `save()` — see `network-ranges.ts`'s header comment on why the port
  // input is local text state rather than bound directly to hook state).
  useEffect(() => {
    setPortText(String(tcpPort))
  }, [tcpPort])

  const portNumber = Number(portText)
  const portValid = portText.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535
  const portError = portText.trim() === '' ? 'enter a port' : !portValid ? 'must be a whole number between 1024 and 65535' : null
  const portChanged = portValid && portNumber !== tcpPort
  const canSave = !hasInvalidRow && !overLimit && portValid
  const busy = saving || scanning

  const doSave = () => (portValid ? save(portNumber) : Promise.resolve(null))

  const scanAll = async () => {
    if (!canSave) return
    if (dirty || portChanged) {
      const result = await doSave()
      if (result === null) return // save refused or failed — never scan on top of an unsaved, possibly-invalid config
    }
    void scan()
  }

  // Client-side precondition, same as `FarmNetworksEditor`'s own "Scan
  // network" button: only meaningful when nothing is about to change first —
  // if the config is dirty, "Scan all" saves before scanning, and the saved
  // result may well have a scannable row even though the CURRENT unsaved
  // state does not.
  const scanDisabled = !dirty && !portChanged ? scanDisabledReason(rows?.map((r) => ({ scan: r.scan })) ?? null) : null
  const scanAllDisabled = busy || !canSave || !!scanDisabled

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Scan network</DialogTitle>
          <DialogDescription>
            The IP ranges and port the bounded sweep probes for devices — configured here, saved here, and scanned here.
            Nothing is guessed from this computer's own network.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows === null ? (
          <LoadingRows rows={2} />
        ) : (
          // `min-w-0` here is the actual overflow fix (not the symptom-level
          // "just widen `max-w-3xl`"): `DialogContent` (`@enkaku/ui`'s
          // `dialog.tsx`) is a CSS Grid (`display: grid`), and this div is
          // one of its direct grid items. A grid/flex item's default
          // `min-width` is `auto`, which means "at least my content's
          // min-content width" — so without this, the wide range table
          // several levels below (inside `RangeNetworksFields`'s own
          // `overflow-x-auto` wrapper, the CORRECT place for horizontal
          // scroll per `docs/design.md`) bubbles its full intrinsic width up
          // through this plain block ancestor to the grid item, forcing the
          // grid track — and therefore the DIALOG ITSELF — to grow past its
          // own `max-w-3xl`, instead of the inner `overflow-x-auto`
          // container ever getting a chance to clip and scroll. `min-w-0`
          // caps this item's automatic minimum size at 0, so the grid track
          // sizes to the dialog's own width and ordinary block layout takes
          // over beneath it — at which point the `overflow-x-auto` div (a
          // scroll container, whose OWN automatic minimum size is already 0
          // by spec) is the only thing that can ever scroll horizontally,
          // regardless of how wide the table's content gets (verified with
          // the Port column this same change adds, plan 88 §9 Q7).
          <div className="min-w-0 space-y-4">
            <div className="max-w-[220px] space-y-1.5">
              <Label htmlFor="scan-dialog-port" className="text-[12px] font-normal">
                Port
              </Label>
              <Input
                id="scan-dialog-port"
                value={portText}
                onChange={(e) => setPortText(e.target.value)}
                placeholder="5555"
                inputMode="numeric"
                aria-label="adb TCP port"
                aria-invalid={!!portError}
                className="readout h-8"
              />
              {portError && <p className="text-[10.5px] text-led-danger">{portError}</p>}
              <p className="text-[11px] leading-relaxed text-fg-subtle">
                The farm default port — used by any range below that leaves its own Port cell blank. Any range can
                override it with its own port.
              </p>
            </div>

            {lastReport && <p className="max-w-xl text-[12px] text-fg-muted">{summariseSweepReport(lastReport)}</p>}

            {rows.length === 0 ? (
              <EmptyState
                icon={<Network className="size-4" aria-hidden />}
                title="No ranges yet"
                description="Add the IP range your device chassis lives on, like 10.20.0.0 - 10.20.0.255, so Enkaku knows where to look."
                action={
                  <Button size="sm" onClick={addRow}>
                    <Plus className="size-3.5" aria-hidden /> Add a range
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
                farmPort={portValid ? portNumber : tcpPort}
              />
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          {rows !== null && rows.length > 0 && (
            <>
              <Button variant="outline" onClick={() => void doSave()} disabled={busy || !canSave || (!dirty && !portChanged)}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button onClick={() => void scanAll()} disabled={scanAllDisabled} title={scanDisabled ?? undefined}>
                {scanning ? 'Scanning…' : saving ? 'Saving…' : 'Scan all'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
