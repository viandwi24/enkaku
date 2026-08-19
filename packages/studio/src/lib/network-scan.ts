'use client'

import { useState } from 'react'
import { SweepReportSchema, type SweepReport } from '@enkaku/protocol'
import { api, useAction } from '@enkaku/ui'

/**
 * `POST /api/devices/scan` (plan 88 §3.5, §4.5, §4.6, §5 step 88.12) — the
 * one hook behind the "Scan network" action everywhere it appears in Studio.
 *
 * This closes a real gap: `devices.ts`'s own doc comment above the route
 * claimed "the Studio 'Rescan / scan all networks' button" already called
 * it, but nothing under `packages/studio/src` ever did — confirmed by grep
 * before this file existed. Two screens need the trigger (Settings →
 * Discovery & monitoring's `FarmNetworksEditor`, where the ranges are
 * configured, and the Devices page's own fleet menu, where an operator
 * would actually run one day to day) and both share this hook rather than
 * each hand-rolling its own fetch + report wording, the same "one path for
 * every action" reasoning `useAction` itself already documents.
 *
 * Deliberately thin: `sweeper.sweep()` already enforces `scan.mode`/"no
 * scannable network" (`E_SCAN_UNAVAILABLE`) and the singleton mutex
 * (`E_SCAN_BUSY`) server-side, both mapped through the router's own
 * `ERROR_STATUS` table — this hook does not re-implement that policy, it
 * only calls the route and lets `useAction`'s built-in failure toast show
 * the server's own message verbatim (`describeApiError`), exactly the
 * pattern `DiscoveredTray.tsx`'s "Rescan" button already established for
 * its sibling route, `POST /rescan`.
 */
export function useNetworkScan(onScanned?: (report: SweepReport) => void) {
  const { run, isPending } = useAction()
  const [lastReport, setLastReport] = useState<SweepReport | null>(null)

  const scan = () =>
    run('scan-network', () => api('/api/devices/scan', SweepReportSchema, { method: 'POST' }), {
      failure: 'Could not scan the network',
      onSuccess: (report) => {
        setLastReport(report)
        onScanned?.(report)
      },
    })

  return { scan, scanning: isPending('scan-network'), lastReport }
}

/**
 * One line summarising a `SweepReport`, matching the wording convention
 * `DiscoveredTray.tsx`'s own `summariseReconcileReport` and
 * `registry/cutover.ts`'s own `detail` field already established: name
 * every category that actually changed, and close with an explicit
 * "nothing new" when nothing did — a scan that found nothing must never
 * read identical to a scan that silently did nothing.
 */
export function summariseSweepReport(report: SweepReport): string {
  const cidrs = report.networks.map((n) => n.cidr).join(', ') || 'no networks'
  const parts: string[] = []
  if (report.adopted.length > 0) parts.push(`${report.adopted.length} reconnected`)
  if (report.discovered.length > 0) parts.push(`${report.discovered.length} newly discovered`)
  if (report.conflicts.length > 0) parts.push(`${report.conflicts.length} address conflict${report.conflicts.length === 1 ? '' : 's'}`)
  const base = `Swept ${cidrs} · ${report.scanned} scanned · ${report.answered} answered`
  return parts.length === 0 ? `${base} · nothing new` : `${base} · ${parts.join(' · ')}`
}

/**
 * Whether at least one configured network is actually included in a sweep
 * (`discovery.networks[].scan`) — the one client-side-knowable precondition
 * for the button (everything else, e.g. orchestrator mode or `scan.mode:
 * 'off'`, has no Studio-visible signal and is left to surface honestly as
 * an `E_SCAN_UNAVAILABLE`/`E_NOT_SUPPORTED` toast after the click, same as
 * `DiscoveredTray.tsx`'s "Rescan" button does for its own `E_NOT_SUPPORTED`
 * case rather than trying to predict server state client-side).
 */
export function hasScannableNetwork(networks: { scan: boolean }[]): boolean {
  return networks.some((n) => n.scan)
}

/**
 * `null` once means "go ahead" — a disabled button with a reason, never a
 * disabled button with none, and never a click that fails only after the
 * fact for a precondition Studio already knew about. `networks === null`
 * covers the brief window before the settings fetch resolves.
 */
export function scanDisabledReason(networks: { scan: boolean }[] | null): string | null {
  if (networks === null) return 'Checking farm networks…'
  if (networks.length === 0) return 'No networks configured — the sweep cannot run'
  if (!hasScannableNetwork(networks)) return 'No network has "Include in a sweep" turned on — check Farm networks under Settings → Discovery & monitoring'
  return null
}
