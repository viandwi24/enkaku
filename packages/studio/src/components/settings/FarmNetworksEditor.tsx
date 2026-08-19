'use client'

import { Network, Plus, ScanSearch } from 'lucide-react'
import { Button, EmptyState, ErrorState, LoadingRows } from '@enkaku/ui'
import { useNetworkRanges } from '@/lib/network-ranges'
import { scanDisabledReason, summariseSweepReport, useNetworkScan } from '@/lib/network-scan'
import { RangeNetworksFields } from './RangeNetworksFields'

/**
 * The farm networks editor (plan 88 §3.4, §3.5, §3.6, §4.2, §5 step 88.6,
 * and its later range-based rewrite superseding step 88.12 — see plan 88 §5
 * for the full account) — the ONLY way a network enters the bounded sweep's
 * address space, since `discovery.networks` is never auto-derived from this
 * computer's own subnets (§3.5: a laptop on a corporate /16 would otherwise
 * sweep 65,536 addresses because someone pressed a button).
 *
 * Rows are edited as a start/end IP range, not raw CIDR (the owner's own
 * request, verbatim: "input dinamis untuk range ip: [ip start] - [ip end]")
 * — `discovery.networks[]` itself stays CIDR-native (`packages/core/src/
 * registry/sweep.ts`, `CidrSchema`) and is never rewritten; `@/lib/ip-range`
 * is the presentation-layer bridge, and `useNetworkRanges`
 * (`@/lib/network-ranges.ts`) is the state this component and
 * `ScanNetworkDialog.tsx` (the Devices page's own "Scan network" modal)
 * BOTH mount, so a farm's network list reads and edits identically
 * regardless of which door an operator walked through — the same "one
 * implementation, not two vocabularies" reasoning already applied to
 * `ActionsList`/`DeviceContextMenu` this session (docs/plans/
 * 96-m61-hotfixes.md).
 *
 * BESPOKE, not `SchemaForm` — decided deliberately, not because the generic
 * renderer crashes on this shape. Row 10 of the resolver's precedence table
 * (`docs/design.md` "Schema-driven forms") already turns an array of
 * objects into a real per-column table (`TableControl`), so `networks`
 * would render as text/choice/toggle cells without corruption. What that
 * generic table cannot do, and what this feature specifically needs:
 *   1. a LIVE per-row address count derived from a start/end range — not a
 *      schema field at all (the schema stores CIDR, not a range), so there
 *      is no column for it and no vocabulary `kind` that could compute one;
 *   2. a RUNNING TOTAL across every scanned row, checked against
 *      `discovery.scan.maxAddresses` — a sibling of `networks`, not even in
 *      the same array, so it has no cell to live in at all; the schema's own
 *      cross-field `superRefine` (`settings.ts`) only fires at Save, and a
 *      refinement that fires only at Save is worse than a number that was
 *      visible the whole time;
 *   3. the range↔CIDR conversion itself, and the "a claim, not an
 *      observation" help text `medium` needs — neither has any generic-form
 *      equivalent;
 *   4. a domain-specific empty state — "a farm with no networks configured
 *      cannot sweep at all" — where the generic table's empty state is just
 *      an empty grid and an Add-row button.
 * So this is a small owned component, the same shape as `KvPanel` and
 * `AdbDiagnosticsPanel` already mounted beside (never replacing) `SchemaForm`
 * on this same page.
 *
 * Independent load/save cycle, on purpose: `settings/page.tsx` excludes
 * `networks` from the `discovery` section's generic `FarmForm` (two editors
 * bound to the same array would drift out of sync between saves), and this
 * panel PATCHes only `{ discovery: { networks } }` — the settings store's
 * shallow per-key merge (`packages/core/src/settings/farm-settings.ts`)
 * folds that into the rest of `discovery` untouched, so this save can never
 * clobber `scanIntervalSec`, `scan.mode`, or anything else in the block.
 *
 * No FARM-WIDE port field here, deliberately: `discovery.tcpPort` is already
 * editable on THIS SAME Settings page, one component up — `settings/page.tsx`'s
 * `discovery` tab renders the generic `<FarmForm omit={['discovery.networks']} />`
 * immediately above this editor, and that form already includes `tcpPort`
 * (only `networks` is excluded, confirmed by reading `settings/page.tsx`
 * before adding a second control for the same setting on the same screen).
 * `ScanNetworkDialog.tsx` — a standalone surface with no such neighbour —
 * is where the farm-wide port field actually lives; see its own header
 * comment. `RangeNetworksFields`'s own per-row Port column (plan 88 §9 Q7,
 * resolved) is a different, narrower thing — an optional override for ONE
 * range — and is shown here exactly as it is in the modal, since both mount
 * the same shared table.
 */
export function FarmNetworksEditor() {
  const { rows, maxAddresses, tcpPort, error, load, setRow, removeRow, addRow, save, saving, scannedTotal, overLimit, hasInvalidRow, dirty } = useNetworkRanges()
  const { scan, scanning, lastReport } = useNetworkScan()

  if (error) return <ErrorState message={error} onRetry={load} />
  if (rows === null) return <LoadingRows rows={2} />

  // Computed off `rows` — the table as currently DISPLAYED, which is the
  // saved config until an edit is made and Save is clicked. A sweep run
  // between an edit and a Save still probes whatever is actually saved
  // server-side, not the pending edit; that gap is surfaced honestly by the
  // report itself (`networks` names exactly what was swept) rather than
  // guessed at here.
  const scanDisabled = scanDisabledReason(rows.map((r) => ({ scan: r.scan })))

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
        The address space the bounded sweep is allowed to probe — an explicit list, never guessed from this computer's own network. Add every range your device chassis lives on; only rows with "Include in a sweep" ticked are ever probed, and the total below can never exceed the farm's scan ceiling.
      </p>
      <p className="mb-4 max-w-xl rounded-md border bg-surface-2 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
        <strong className="font-semibold text-fg">Wired or Wi-Fi is a claim you are making, not something Enkaku measured.</strong> adb cannot tell a switch port from a radio — only you can. Whatever medium you pick here is what turns a device found on this network into an OTG badge or a WI-FI badge. Get it wrong and every device on that network shows a confidently wrong badge.
      </p>
      {lastReport && <p className="mb-4 max-w-xl text-[12px] text-fg-muted">{summariseSweepReport(lastReport)}</p>}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Network className="size-4" aria-hidden />}
          title="No networks configured — the sweep cannot run"
          description='Add the IP range your device chassis lives on, like 10.20.0.0 - 10.20.0.255, so Enkaku knows where to look. With nothing here, "Scan network" stays disabled and a device that goes missing over the network can only be found by its remembered address.'
          action={
            <Button size="sm" onClick={addRow}>
              <Plus className="size-3.5" aria-hidden /> Add a range
            </Button>
          }
        />
      ) : (
        <>
          <RangeNetworksFields rows={rows} setRow={setRow} removeRow={removeRow} addRow={addRow} maxAddresses={maxAddresses} scannedTotal={scannedTotal} farmPort={tcpPort} />
          <div className="mt-4">
            <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || hasInvalidRow || overLimit}>
              Save networks
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
