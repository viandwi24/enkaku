'use client'

import { useEffect, useRef, useState } from 'react'
import { SettingsResponseSchema, UpdateSettingsResponseSchema } from '@enkaku/protocol'
import { api, useAction } from '@enkaku/ui'
import { emptyRangeRow, networksToRanges, rangeAddressCount, rangeError, rangeRowsToNetworks, rowPortError, type RangeRow } from './ip-range'

/**
 * The shared range-editing state (plan 88 §5, superseding step 88.12) — used
 * by BOTH `FarmNetworksEditor.tsx` (Settings → Discovery & monitoring) and
 * `ScanNetworkDialog.tsx` (the Devices page's "Scan network" modal), so a
 * farm's network list reads and edits identically regardless of which door
 * an operator walked through. Same reasoning this session already applied to
 * `ActionsList`/`DeviceContextMenu` (docs/plans/96-m61-hotfixes.md) — one
 * shared implementation, not two vocabularies for the same feature.
 *
 * Loads and saves `discovery.networks` exactly like the pre-range
 * `FarmNetworksEditor` did (a full-array PATCH, never a partial diff — see
 * `rangeRowsToNetworks`'s own header comment on why a full rewrite is what
 * makes editing a merged multi-CIDR row safe).
 *
 * `tcpPort` is exposed read-only (the loaded/saved value, for display) but
 * is never mutated by this hook while the operator types — a text field
 * bound directly to hook state and edited via a setter defined in the SAME
 * render that reads it risks `save()` closing over the pre-update value
 * (React state updates are not synchronous), which would silently save the
 * wrong port. Instead `save(overridePort?)` takes the port explicitly at
 * call time: `ScanNetworkDialog` keeps its own local text state for the
 * input and passes the parsed number straight into `save()`, so what gets
 * PATCHed is always exactly what is on screen at the moment of the click.
 * Only written when `includePort: true` — that is `ScanNetworkDialog`'s own
 * port field; `FarmNetworksEditor` leaves it `false` because
 * `discovery.tcpPort` is already editable elsewhere on the same Settings
 * page via the generic schema form (`settings/page.tsx`'s `discovery` tab
 * renders `<FarmForm omit={['discovery.networks']} />` before this editor,
 * and that form already includes `tcpPort` — confirmed by reading
 * `settings/page.tsx` before adding a second control for the same setting
 * on the same screen).
 */
export function useNetworkRanges(opts: { includePort?: boolean } = {}) {
  const includePort = opts.includePort ?? false
  const [rows, setRows] = useState<RangeRow[] | null>(null)
  const [maxAddresses, setMaxAddresses] = useState(1024)
  const [tcpPort, setTcpPort] = useState(5555)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  // The last-loaded/saved ROWS snapshot, for genuine dirty-tracking ("Scan
  // all" only saves when there really is something unsaved) rather than the
  // pre-range editor's own "dirty = at least one row exists" shortcut, which
  // would make "Scan all" re-save on every click even with zero edits. Port
  // is excluded here on purpose — see this file's header comment; a caller
  // that also edits the port (`ScanNetworkDialog`) compares that itself.
  const savedRowsSnapshot = useRef<string | null>(null)

  const load = () => {
    setError(null)
    setRows(null)
    api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        // Plan 212 §4.1 — `discovery.scan.maxAddresses` and `discovery.tcpPort`
        // are constants now (`SCAN_MAX_ADDRESSES`, `ADB_TCP_PORT`,
        // `packages/core/src/config/constants.ts`), not part of the settings
        // response; this hook keeps its own literal defaults for them
        // (1024, 5555) rather than reading a field the API no longer serves.
        const nextRows = networksToRanges(b.settings.networkScan.networks)
        setRows(nextRows)
        savedRowsSnapshot.current = JSON.stringify(nextRows)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const setRow = (i: number, patch: Partial<RangeRow>) => setRows((prev) => (prev ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setRows((prev) => (prev ?? []).filter((_, j) => j !== i))
  const addRow = () => setRows((prev) => [...(prev ?? []), emptyRangeRow()])

  // A row's own port OVERRIDE (plan 88 §9 Q7, resolved) gates Save exactly
  // like its start/end IP does — an in-progress invalid port (mid-typing, or
  // out of the 1024–65535 bound) must never reach `rangeRowsToNetworks` and
  // get PATCHed.
  const hasInvalidRow = (rows ?? []).some((r) => rangeError(r.startIp, r.endIp) !== null || !r.startIp.trim() || !r.endIp.trim() || rowPortError(r.port) !== null)
  const scannedTotal = (rows ?? []).reduce((sum, r) => (r.scan ? sum + rangeAddressCount(r.startIp, r.endIp) : sum), 0)
  const overLimit = scannedTotal > maxAddresses
  const dirty = rows !== null && JSON.stringify(rows) !== savedRowsSnapshot.current

  /**
   * `overridePort`, when `includePort` is set, is written instead of the
   * hook's own `tcpPort` state — see the header comment above for why.
   * Returns the same `Promise<T | null>` `useAction`'s `run` returns, so a
   * caller (`ScanNetworkDialog`'s "Scan all") can await it before deciding
   * whether to proceed to the scan.
   */
  const save = (overridePort?: number) => {
    if (!rows || hasInvalidRow || overLimit) return Promise.resolve(null)
    const networks = rangeRowsToNetworks(rows)
    if (!networks) return Promise.resolve(null)
    // Plan 212 §4.1 — `discovery.tcpPort` is the constant `ADB_TCP_PORT` now;
    // `includePort`/`overridePort` no longer have a settings field to reach,
    // so the port argument is accepted for call-site compatibility but is
    // not sent. `plugins 219 owns rebuilding this editor against the new
    // schema.
    void overridePort
    void includePort
    return run(
      'save-networks',
      () =>
        api('/api/settings', UpdateSettingsResponseSchema, {
          method: 'PATCH',
          json: { networkScan: { networks } },
        }),
      {
        success: 'Farm networks saved',
        failure: 'Could not save these networks',
        onSuccess: (b) => {
          const nextRows = networksToRanges(b.settings.networkScan.networks)
          setRows(nextRows)
          savedRowsSnapshot.current = JSON.stringify(nextRows)
        },
      },
    )
  }

  return {
    rows,
    maxAddresses,
    tcpPort,
    error,
    load,
    setRow,
    removeRow,
    addRow,
    save,
    saving: isPending('save-networks'),
    scannedTotal,
    overLimit,
    hasInvalidRow,
    dirty,
  }
}
