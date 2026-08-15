'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Download, Hash, Inbox, LayoutGrid, List, MoreVertical, Plus, Search, Smartphone, Terminal, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  connectionBadge,
  DeviceLabelsApplyResponseSchema,
  DeviceNumberCompactResponseSchema,
  DeviceResponseSchema,
  JobInfoSchema,
  ReconnectOutcomeSchema,
  SettingsResponseSchema,
  type ClusterInfo,
  type DeviceInfo,
  type DeviceLabelMode,
  type DeviceStatus,
  type JobInfo,
  type Readiness,
} from '@enkaku/protocol'
import { z } from 'zod'
import { DeviceCard } from '@/components/DeviceCard'
import { DiscoveredTray } from '@/components/DiscoveredTray'
import { EnrollmentDialog } from '@/components/EnrollmentDialog'
import { InstallBatchDialog } from '@/components/InstallBatchDialog'
import { ForgetDeviceDialog } from '@/components/ForgetDeviceDialog'
import { DisconnectDeviceDialog } from '@/components/DisconnectDeviceDialog'
import { BulkForgetDialog } from '@/components/BulkForgetDialog'
import { BulkTransferDialog } from '@/components/BulkTransferDialog'
import { OutcomeSummary, type OutcomeCounts } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups, type NamedOutcome } from '@/components/bulk/SkippedGroups'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Wall } from '@/components/wall/Wall'
import { FocusOverlay } from '@/components/wall/FocusOverlay'
import { SelectionCursorBadge } from '@/components/wall/SelectionCursorBadge'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBulkSelection } from '@/hooks/use-bulk-selection'
import { api, describeApiError, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDevices, fetchDiscoveredDevices, type DiscoveredDevice } from '@/lib/api'
import { isAdmin, useAuth } from '@/lib/auth'
import { readLocalPrefs, readSessionPrefs, TILE_SIZE_PX, type TileSize, writeLocalPrefs, writeSessionPrefs } from '@/lib/prefs'
import { setDeviceReadiness } from '@/lib/readiness'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'ready' | 'inUse' | 'attention'
/** 'all' = no filter, 'none' = the explicit "Unclustered" option (plan 22.0 §4.5), else a cluster id. */
type ClusterFilter = 'all' | 'none' | (string & {})
/** A readiness filter, by `actual` (plan 43 §4.6) — 'all' = no filter. */
type ReadinessFilter = 'all' | 'hot' | 'awake' | 'asleep'
/**
 * A connection filter (plan 88 §3.1, §4.1, F5). Six values, not four — the
 * badge only has USB / OTG / WI-FI / TCP, but an operator chasing a
 * wired-farm problem usually wants "everything not on USB" more than three
 * separate checkboxes, so `network` sits alongside the three fine-grained
 * ones rather than replacing them. `network` filters on the OBSERVED `kind`
 * field directly (the question adb can actually answer); `otg`/`wifi`/`tcp`
 * filter on the derived badge (kind + medium together) for when the precise
 * value matters, e.g. isolating exactly the wired-OTG rack during a cutover.
 */
type ConnectionFilter = 'all' | 'usb' | 'network' | 'otg' | 'wifi' | 'tcp'
const CONNECTION_FILTER_LABEL: Record<ConnectionFilter, string> = {
  all: 'Any connection',
  usb: 'USB',
  network: 'On the network',
  otg: 'OTG',
  wifi: 'Wi-Fi',
  tcp: 'TCP (unknown)',
}
/** The View and Group controls (plan 47 §3.6, §4.5) — both linkable in the query string. */
type View = 'list' | 'wall'
type GroupBy = 'none' | 'cluster' | 'status' | 'tag'

const STATUS_ORDER: DeviceStatus[] = ['idle', 'busy', 'manual', 'quarantined', 'offline']
const STATUS_LABEL: Record<DeviceStatus, string> = {
  idle: 'Idle',
  busy: 'Busy',
  manual: 'Controlled',
  quarantined: 'Quarantined',
  offline: 'Offline',
}

function isView(v: string | null): v is View {
  return v === 'list' || v === 'wall'
}
function isGroupBy(v: string | null): v is GroupBy {
  return v === 'none' || v === 'cluster' || v === 'status' || v === 'tag'
}

function DashboardView() {
  const params = useSearchParams()
  const router = useRouter()
  const { user } = useAuth()
  // `device.quarantine` (admin-only, `packages/core/src/auth/acl.ts`) gates
  // `POST /:id/unquarantine` — the fleet card's "Return to queue" button.
  const canReleaseQuarantine = isAdmin(user)
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [unauthorized, setUnauthorized] = useState<string[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [clusterFilter, setClusterFilter] = useState<ClusterFilter>('all')
  const [readinessFilter, setReadinessFilter] = useState<ReadinessFilter>('all')
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>('all')
  // View (List | Wall) and Group (None | Cluster | Status | Tag) are two
  // orthogonal controls, both in the query string so a view is linkable
  // (plan 47 §3.6, §4.5) — this is what replaces the separate `/topology`
  // route: it becomes `view=wall&group=cluster`.
  //
  // Precedence, most specific first (plan 92 §3.10, §4.9, §9 Q1, decided
  // 2026-08-12): URL query param -> this tab's session preference -> 'wall'.
  // There is no farm setting in this chain — `wall.defaultView` does not
  // exist. A shared `?view=` link still always wins (plan 47's own reason
  // for putting the view in the query string), and a brand-new tab/window/
  // session has no session preference to read, so it always falls through
  // to the Wall — the unconditional landing view.
  const [view, setViewState] = useState<View>(() => {
    const v = params.get('view')
    if (isView(v)) return v
    const p = readSessionPrefs().view
    if (p) return p
    return 'wall'
  })
  const [group, setGroupState] = useState<GroupBy>(() => {
    const g = params.get('group')
    return isGroupBy(g) ? g : 'none'
  })
  // Tile size (plan 92 §3.11) — a property of the screen someone is sitting
  // in front of, not a landing-view choice, so it lives in `localStorage`
  // (via `readLocalPrefs`/`writeLocalPrefs`) and survives a new tab on
  // purpose, unlike `view` above.
  const [tileSize, setTileSizeState] = useState<TileSize>(() => readLocalPrefs().tileSize)
  const [error, setError] = useState<string | null>(null)
  const [enrollOpen, setEnrollOpen] = useState(false)
  // Multi-select for a batch action (plan 39 §4.5, §4.7) — "Install on
  // selected" is the only action today; the shape leaves room for others later.
  // Plan 91 §5 step 91.8 (F11, F12): migrated off a hand-rolled `Set` onto
  // `useBulkSelection` below, which needs a plain array to hand back a
  // single `setSelected` call — and, unlike before, selection now works in
  // BOTH List and Wall view off this one piece of state (F11: the wall
  // tile used to hard-code no selection surface at all).
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [installBatchOpen, setInstallBatchOpen] = useState(false)
  // Push/Pull file (plan 93 §3.11, §3.16, §4.8, F15, step 93.11) — one
  // dialog, two modes, beside the existing Install: `BulkTransferDialog`
  // posts a batch (`internal:push`/`internal:pull`) exactly like
  // `InstallBatchDialog` does, and stays open showing the same report.
  const [bulkTransferOpen, setBulkTransferOpen] = useState<'push' | 'pull' | null>(null)
  // "Wake selected" / "Sleep selected" (plan 93 §3.15, §4.8, F15, H3, step
  // 93.11): `wakeOrSleepSelected` used to emit one anonymous summary toast
  // that could never name a failing device (F15's third named defect). It
  // now reports through the same `OutcomeSummary`/`SkippedGroups` shape
  // every other bulk surface in this plan uses, held here rather than in a
  // toast so the names stay on screen until dismissed.
  const [wakeSleepReport, setWakeSleepReport] = useState<{ verb: string; okCount: number; total: number; refused: NamedOutcome[] } | null>(null)
  // Removal (plan 47 §4.5): a single-device dialog (row menu, offers Block
  // instead on refusal) and a bulk one for the multi-select toolbar.
  const [forgetTarget, setForgetTarget] = useState<DeviceInfo | null>(null)
  const [forgetOpen, setForgetOpen] = useState(false)
  const [bulkForgetOpen, setBulkForgetOpen] = useState(false)
  // Per-device disconnect (plan 88 §3.7, §3.8, §4.6, §5 step 88.4) — same
  // target/open pair as `forgetTarget`/`forgetOpen` above. Reconnect fires
  // directly (§3.8: it is not destructive), no dialog of its own.
  const [disconnectTarget, setDisconnectTarget] = useState<DeviceInfo | null>(null)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  // Discovered tray (plan 56 §4.5): phones adb has seen that nobody has
  // admitted yet. Its own entry point, not a third List/Wall view — it is
  // rendered only once `discovered.length > 0` so an empty tray costs
  // nothing visually.
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([])
  const [trayOpen, setTrayOpen] = useState(false)
  // Plan 89 §3.2 point 5, §5 step 89.3 — the fleet-wide renumber compaction.
  // There is no dry-run endpoint (`POST /api/devices/numbers/compact` just
  // does it), so the confirm dialog cannot honestly preview a count before
  // the click — it says what the action DOES, and the actual count is
  // reported afterward in the success toast, never promised up front.
  const [renumberOpen, setRenumberOpen] = useState(false)
  // The farm's default labelling mode (plan 89 §3.8, §5 step 89.8) — read
  // once from `/api/settings`, the same fetch the device page's own
  // `farmVideo` uses. Only consulted by `AdmitDeviceDialog`'s checkbox,
  // which reflects it rather than editing the farm default itself (that
  // stays on the farm Settings page) — `'off'` until the fetch resolves,
  // the feature's own safe default, so a slow fetch never shows a
  // pre-checked box for a farm that has not opted in.
  const [farmLabellingMode, setFarmLabellingMode] = useState<DeviceLabelMode>('off')
  // "Apply labels" (plan 89 §3.7 point 3, §5 step 89.8) — the fleet-wide
  // switch-on: `POST /api/devices/labels/apply` returns a per-device report
  // synchronously (no batch job, no WS updates to wait for), so the report
  // is held here and rendered the moment the call resolves, the same
  // "stays open, shows what happened" shape `InstallBatchDialog` uses via
  // `OutcomeSummary`/`SkippedGroups` (docs/design.md's "Multi-device
  // reports" rule: outcome first, grouped by exact reason, always named).
  const [labelsApplyReport, setLabelsApplyReport] = useState<{ counts: OutcomeCounts; failed: NamedOutcome[]; skipped: NamedOutcome[] } | null>(null)
  const { run, isPending } = useAction()

  const loadDiscovered = () => void fetchDiscoveredDevices().then(setDiscovered).catch(() => undefined)

  const applyLabelsToSelected = () =>
    run(
      'apply-labels',
      () => api('/api/devices/labels/apply', DeviceLabelsApplyResponseSchema, { method: 'POST', json: { deviceIds: selectedIds } }),
      {
        failure: 'Could not apply labels',
        onSuccess: (res) => {
          const deviceLabel = (id: string) => devices?.find((d) => d.id === id)?.label ?? id
          const ok = res.results.filter((r) => r.state !== null && (r.state.state === 'applied' || r.state.state === 'off')).length
          const failed: NamedOutcome[] = res.results
            .filter((r) => r.state === null)
            .map((r) => ({ deviceId: r.deviceId, label: deviceLabel(r.deviceId), reason: r.error ?? 'unknown error' }))
          // `partial`/`unavailable`/`stale`/`unknown` are real, reported
          // outcomes from the labelling service — not thrown errors — so
          // they group under `skipped`, each carrying the service's OWN
          // reason text verbatim (never invented here, plan 93 §3.15's rule).
          const skipped: NamedOutcome[] = res.results
            .filter((r) => r.state !== null && r.state.state !== 'applied' && r.state.state !== 'off')
            .map((r) => ({ deviceId: r.deviceId, label: deviceLabel(r.deviceId), reason: r.state?.reason ?? (r.state?.state ?? 'not applied') }))
          setLabelsApplyReport({ counts: { ok, failed: failed.length, skipped: skipped.length, total: res.total }, failed, skipped })
        },
      },
    )

  const renumberFleet = () =>
    run(
      'renumber',
      () => api('/api/devices/numbers/compact', DeviceNumberCompactResponseSchema, { method: 'POST', json: {} }),
      {
        failure: 'Could not renumber the fleet',
        onSuccess: (result) => {
          if (result.changed.length === 0) {
            toast.success('Every number was already compact — nothing changed')
          } else if (result.failed.length === 0) {
            toast.success(
              `Renumbered ${result.changed.length} device${result.changed.length === 1 ? '' : 's'}` +
                (result.relabelled > 0 ? ` · ${result.relabelled} label${result.relabelled === 1 ? '' : 's'} re-applied` : ''),
            )
          } else {
            // Outcome first, grouped by reason, always named (docs/design.md
            // "Multi-device reports") — a bulk toast is small, so the names
            // ride the description rather than a full report panel.
            toast.warning(`Renumbered ${result.changed.length} device${result.changed.length === 1 ? '' : 's'}`, {
              description: `${result.failed.length} label${result.failed.length === 1 ? '' : 's'} could not be re-applied: ${result.failed
                .map((f) => `${f.stableId} (${f.reason})`)
                .join(', ')}`,
            })
          }
          void load()
        },
      },
    )

  const load = async () => {
    setError(null)
    try {
      const [d, j] = await Promise.all([
        fetchDevices(),
        // Every list endpoint returns the keyset envelope `{items, nextCursor, total}` (plan 30);
        // this call site still read `.jobs`, so `setJobs(undefined)` made the whole dashboard throw
        // on the next render. Default defensively too — a shape change must not blank the page.
        //
        // Narrower than the full `JobsPageResponseSchema` on purpose (plan 72
        // §4.1) — this call site only ever reads `.items`, and the real
        // response's `nextCursor`/`total` are ignored either way.
        api('/api/jobs?status=running&limit=50', z.object({ items: z.array(JobInfoSchema) })),
      ])
      setDevices(d)
      setJobs(j.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then(setClusters)
      .catch(() => undefined)
    // The farm's default labelling mode (plan 89 §3.8) — `AdmitDeviceDialog`
    // reads it to reflect what a freshly admitted device will get, without
    // this page needing the whole farm Settings form. A fetch failure
    // leaves the safe `'off'` default in place.
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => setFarmLabellingMode(b.settings.defaults.labelling.mode))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void load()
    loadDiscovered()
    const off = ws.on((m) => {
      if (m.type === 'device.added') {
        void load()
        // Admitted here or by another operator — either way it just left the tray.
        loadDiscovered()
      } else if (m.type === 'device.removed' || m.type === 'device.status') void load()
      else if (m.type === 'job.status') {
        // Merge the live push in place instead of re-fetching (plan 99 §4.9,
        // §4.11, step 99.10's own reported gap — closed here). `job.status`
        // already carries a workflow's `node` block (`{id,seq,total,kind,
        // script,status}`); `load()`'s `GET /api/jobs?status=running` call
        // validates the response against `JobInfoSchema`, which has NO
        // `node` field, so a re-fetch here silently stripped the exact
        // counter the Wall's `node 2/4` badge (`WallTile.tsx`) needs — and
        // even fixed, a poll-shaped refetch would always lag the live
        // counter it exists to display. `m.payload` is already the whole
        // row (plan 30 §3.5) — the SAME shape `app/jobs/page.tsx`'s own
        // `pushLive(m.payload as Job)` already trusts with no re-parse, so
        // this reuses that precedent rather than inventing a second one.
        setJobs((prev) => {
          const i = prev.findIndex((j) => j.jobId === m.payload.jobId)
          // This list is `status=running` only (see `load()` above) — a job
          // that just left that status (succeeded/failed/cancelled) belongs
          // OUT of it, not merged in.
          if (m.payload.status !== 'running') return prev.filter((j) => j.jobId !== m.payload.jobId)
          if (i === -1) return [...prev, m.payload]
          const next = [...prev]
          next[i] = m.payload
          return next
        })
      } else if (m.type === 'device.discovered') {
        // The REST snapshot is the source of truth for the tray: this payload
        // carries no `firstSeen`/`lastSeen` (plan 56 §4.4), and the count has
        // to move live the same way the fleet list already does from `device.added`.
        loadDiscovered()
      } else if (m.type === 'device.battery') {
        setDevices((prev) =>
          prev
            ? prev.map((d) => (d.id === m.payload.deviceId ? { ...d, battery: m.payload.battery } : d))
            : prev,
        )
      } else if (m.type === 'device.unauthorized') {
        setUnauthorized((prev) => (prev.includes(m.payload.serial) ? prev : [...prev, m.payload.serial]))
        setEnrollOpen(true)
      } else if (m.type === 'device.readiness') {
        // One broadcast moves the Wall, the list, and (via its own
        // subscription) the device page together, with no page refresh
        // (plan 43 §4.1, acceptance #13).
        setDevices((prev) =>
          prev
            ? prev.map((d) => (d.id === m.payload.deviceId ? { ...d, readiness: m.payload.readiness } : d))
            : prev,
        )
      } else if (m.type === 'lease.changed') {
        // Who holds a device (plan 71 §3.2, §3.8) — an ordinary acquire or
        // release also flips `status` (idle↔manual), which already triggers
        // a full `load()` above; a TAKEOVER does not (the device stays
        // `manual` throughout, only the holder changes), so this is the only
        // path that keeps the fleet card and wall tile live for that case —
        // without it, an agent taking a device over from another agent (or a
        // person) would show the DISPLACED holder until something unrelated
        // happened to trigger a reload. No polling anywhere (replaces
        // `lib/agent-holders.ts`, deleted).
        setDevices((prev) =>
          prev
            ? prev.map((d) => (d.id === m.payload.deviceId ? { ...d, heldBy: m.payload.heldBy } : d))
            : prev,
        )
      } else if (m.type === 'assist.changed') {
        // Who is ASSISTING a device (plan 91 §3.4 item 4, F25) — the same
        // live-patch treatment `lease.changed` gets above, just for
        // `assistedBy` instead of `heldBy`. Without this branch the devices
        // list and the Wall (this page feeds both) only picked up a NEW
        // assist grant on the next `/api/devices` fetch or an unrelated
        // `device.added`/`device.status` refresh — not the instant a grant
        // starts, is released, expires (`ttl`), or ends with the primary
        // hold (`primary_ended`).
        setDevices((prev) =>
          prev
            ? prev.map((d) => (d.id === m.payload.deviceId ? { ...d, assistedBy: m.payload.assistedBy } : d))
            : prev,
        )
      }
    })
    // The live merge above has no way to know about a `job.status` message
    // that was broadcast while this tab's socket was disconnected — there is
    // no snapshot replay (CLAUDE.md's own rule: "a client must GET
    // /api/devices first, then subscribe"), so a job that finished mid-drop
    // could otherwise stay in `jobs` forever. Resync once per reconnect, the
    // same pattern `LiveView.tsx`/`DeviceLog.tsx`/`MonitorPane.tsx` already
    // use for the same reason.
    const offReconnect = ws.onReconnected(() => void load())
    return () => {
      off()
      offReconnect()
    }
  }, [])

  const needsAttention = (d: DeviceInfo) =>
    d.status === 'quarantined' || d.status === 'offline' || Boolean(d.battery && d.battery.temperatureC >= 45)

  const summary = useMemo(() => {
    const list = devices ?? []
    return {
      all: list.length,
      ready: list.filter((d) => d.status === 'idle').length,
      inUse: list.filter((d) => d.status === 'busy' || d.status === 'manual').length,
      attention: list.filter(needsAttention).length,
    }
  }, [devices])

  // Every tag currently in use, so the filter bar offers only tags that
  // actually narrow the list (plan 19 §8 risk table — visible tags are the
  // reusable ones).
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const d of devices ?? []) for (const t of d.tags) set.add(t)
    return [...set].sort()
  }, [devices])

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))

  const filtered = useMemo(() => {
    let list = devices ?? []
    if (filter === 'ready') list = list.filter((d) => d.status === 'idle')
    else if (filter === 'inUse') list = list.filter((d) => d.status === 'busy' || d.status === 'manual')
    else if (filter === 'attention') list = list.filter(needsAttention)
    const q = query.trim().toLowerCase()
    // The address joins the search (plan 92 §4.8): an operator chasing a
    // connection problem usually has the IP in hand, not the label or the
    // raw adb serial, and 15 monospace characters read once during that hunt
    // is exactly the "permanent tile space is the wrong place for it, search
    // is" trade the tile layout makes. `null` (USB, or a TCP device with no
    // known address yet) never matches, same as every other optional field here.
    if (q)
      list = list.filter(
        (d) => d.label.toLowerCase().includes(q) || d.serial.toLowerCase().includes(q) || d.connection.address?.toLowerCase().includes(q),
      )
    // AND semantics (plan 19 §4.3, §9.3) — the same rule GET /api/devices?tag=
    // applies server-side, so filtering here and filtering there never disagree.
    if (selectedTags.length > 0) list = list.filter((d) => selectedTags.every((t) => d.tags.includes(t)))
    // A cluster filter (plan 22.0 §4.5, acceptance #4) — 'none' means exactly
    // the unclustered devices, matching `GET /api/devices?clusterId=none`.
    if (clusterFilter === 'none') list = list.filter((d) => d.cluster === null)
    else if (clusterFilter !== 'all') list = list.filter((d) => d.cluster?.id === clusterFilter)
    // Readiness filter, by `actual` (plan 43 §4.6) — what the device really
    // is right now, not merely what was asked for.
    if (readinessFilter !== 'all') list = list.filter((d) => d.readiness.actual === readinessFilter)
    // Connection filter (plan 88 §3.1, §4.1, F5) — `network` reads the
    // observed `kind` directly; the other three read the same derived badge
    // string the operator sees on the card, so "filter to OTG" can never
    // disagree with what the badge itself says.
    if (connectionFilter === 'usb') list = list.filter((d) => d.connection.kind === 'usb')
    else if (connectionFilter === 'network') list = list.filter((d) => d.connection.kind === 'tcp')
    else if (connectionFilter === 'otg') list = list.filter((d) => connectionBadge(d.connection) === 'OTG')
    else if (connectionFilter === 'wifi') list = list.filter((d) => connectionBadge(d.connection) === 'WI-FI')
    else if (connectionFilter === 'tcp') list = list.filter((d) => connectionBadge(d.connection) === 'TCP')
    return list
  }, [devices, filter, query, selectedTags, clusterFilter, readinessFilter, connectionFilter])

  // View (List | Wall) and Group (None | Cluster | Status | Tag) update the
  // query string too, so the exact page anyone is looking at is linkable —
  // this is what makes the old `/topology` route a plain redirect to
  // `view=wall&group=cluster` rather than a page of its own (plan 47 §3.6).
  const pushParams = (next: { view?: View; group?: GroupBy }) => {
    const qs = new URLSearchParams(params.toString())
    const v = next.view ?? view
    const g = next.group ?? group
    if (v === 'list') qs.delete('view')
    else qs.set('view', v)
    if (g === 'none') qs.delete('group')
    else qs.set('group', g)
    const qsStr = qs.toString()
    router.replace(qsStr ? `/?${qsStr}` : '/')
  }
  const setView = (v: View) => {
    setViewState(v)
    pushParams({ view: v })
    // This tab's own choice, remembered for a reload of THIS tab only
    // (plan 92 §3.10) — never a farm setting, never cross-session.
    writeSessionPrefs({ view: v })
  }
  const setGroup = (g: GroupBy) => {
    setGroupState(g)
    pushParams({ group: g })
  }
  const setTileSize = (t: TileSize) => {
    setTileSizeState(t)
    writeLocalPrefs({ tileSize: t })
  }

  // The focused device on the Wall (plan 91 §3.11, §5 step 91.8/91.9, F13):
  // `?focus=<id>` — URL-driven rather than mirrored into local state (unlike
  // `view`/`group` above), matching §3.11's own reasoning ("URL-driven, so
  // it survives a reload and is linkable"). Double-click on a wall tile sets
  // it; `clearFocus` below (91.9) is the thing that closes it — 91.8's own
  // gap note named this exact absence.
  const focusId = params.get('focus')
  const setFocus = (id: string) => {
    const qs = new URLSearchParams(params.toString())
    qs.set('focus', id)
    router.replace(`/?${qs.toString()}`)
  }
  const clearFocus = () => {
    const qs = new URLSearchParams(params.toString())
    qs.delete('focus')
    const qsStr = qs.toString()
    router.replace(qsStr ? `/?${qsStr}` : '/')
  }

  // Grouping is a view concern only (plan 19 §4.5, plan 47 §3.6) — applied to
  // BOTH the table and the Wall (the same `groups` value feeds each), which
  // is the one thing the old, separate `/topology` route never offered for
  // the table. A device with several tags appears in each tag group; a
  // device with none, or with no cluster, gets its own bucket rather than
  // being silently dropped.
  const groups = useMemo((): Array<[string, DeviceInfo[]]> | null => {
    if (group === 'none') return null
    if (group === 'tag') {
      const byTag = new Map<string, DeviceInfo[]>()
      const untagged: DeviceInfo[] = []
      for (const d of filtered) {
        if (d.tags.length === 0) {
          untagged.push(d)
          continue
        }
        for (const t of d.tags) {
          const list = byTag.get(t)
          if (list) list.push(d)
          else byTag.set(t, [d])
        }
      }
      const sorted: Array<[string, DeviceInfo[]]> = [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))
      if (untagged.length > 0) sorted.push(['untagged', untagged])
      return sorted
    }
    if (group === 'cluster') {
      const byCluster = new Map<string, DeviceInfo[]>()
      const unclustered: DeviceInfo[] = []
      for (const d of filtered) {
        if (!d.cluster) {
          unclustered.push(d)
          continue
        }
        const list = byCluster.get(d.cluster.name)
        if (list) list.push(d)
        else byCluster.set(d.cluster.name, [d])
      }
      const sorted: Array<[string, DeviceInfo[]]> = [...byCluster.entries()].sort(([a], [b]) => a.localeCompare(b))
      if (unclustered.length > 0) sorted.push(['Unclustered', unclustered])
      return sorted
    }
    // group === 'status'
    const byStatus = new Map<DeviceStatus, DeviceInfo[]>()
    for (const d of filtered) {
      const list = byStatus.get(d.status)
      if (list) list.push(d)
      else byStatus.set(d.status, [d])
    }
    return STATUS_ORDER.filter((s) => (byStatus.get(s)?.length ?? 0) > 0).map(
      (s) => [STATUS_LABEL[s], byStatus.get(s) ?? []] as [string, DeviceInfo[]],
    )
  }, [filtered, group])

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds([])
  }

  // Select-all / tri-state (plan 91 §5 step 91.8, F12) — over the currently
  // FILTERED set, same rule `ToolsSection`/`AccessSection`
  // (`app/agents/detail/page.tsx`) already use: "select all" means all of
  // what is actually on screen, not the whole unfiltered fleet.
  const filteredIds = useMemo(() => filtered.map((d) => d.id), [filtered])
  const bulk = useBulkSelection(filteredIds, selectedIds, setSelectedIds)

  const releaseQuarantine = (d: DeviceInfo) =>
    // Not one of the call sites the plan named for this file — found while
    // migrating. `POST /:id/unquarantine` returns `{ device }`
    // (`packages/core/src/api/devices.ts`), the result unread here (the WS
    // `device.status` broadcast the unquarantine triggers is what actually
    // updates the list, via `load()` below).
    run('unq-' + d.id, () => api(`/api/devices/${d.id}/unquarantine`, DeviceResponseSchema, { method: 'POST' }), {
      success: `${d.label} is back in the queue`,
      failure: 'Could not return the device to the queue',
      onSuccess: () => void load(),
    })

  /** Dials this device's last known address (plan 88 §3.3, §4.4, §4.6) — no confirmation, it is not destructive. */
  const reconnectDevice = (d: DeviceInfo) =>
    run('reconnect-' + d.id, () => api(`/api/devices/${d.id}/connection/reconnect`, ReconnectOutcomeSchema, { method: 'POST', json: {} }), {
      failure: `Could not reconnect ${d.label}`,
      onSuccess: (outcome) => {
        if (outcome.result === 'already-connected') toast.success(`${d.label} is already connected`)
        else if (outcome.result === 'connected') toast.success(`${d.label} reconnected from ${outcome.address}`)
        else if (outcome.result === 'not-found') toast.error(`Could not find ${d.label} on the network`, { description: 'It did not answer at any remembered address.' })
        else toast.error(`Could not reconnect ${d.label}`, { description: outcome.detail })
        void load()
      },
    })

  /**
   * "Wake selected" / "Sleep selected" (plan 43 §4.6, §5 step 43.5; plan 93
   * §3.15, §4.8, F15, H3, step 93.11) — one `PUT .../readiness` per device,
   * each independently refused or accepted server-side (§3.4); one device's
   * refusal (a running job, another viewer) never blocks the rest. F15
   * named this function by name as the third of three inconsistent bulk
   * patterns: "`wakeOrSleepSelected` uses `Promise.allSettled` and emits
   * one anonymous summary toast that never names a failing device." It
   * still uses `Promise.allSettled` — that part was never the defect — but
   * the report is now the shared `OutcomeSummary`/`SkippedGroups` pair
   * (`wakeSleepReport`, rendered below), which DOES name every device that
   * refused, with the server's own reason (`describeApiError`), never
   * invented or paraphrased.
   */
  const wakeOrSleepSelected = async (desired: Readiness) => {
    const ids = selectedIds
    const results = await Promise.allSettled(ids.map((id) => setDeviceReadiness(id, desired)))
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const refused: NamedOutcome[] = results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return []
      const id = ids[i]
      if (!id) return []
      return [{ deviceId: id, label: devices?.find((d) => d.id === id)?.label ?? id, reason: describeApiError(r.reason) }]
    })
    setWakeSleepReport({ verb: desired === 'asleep' ? 'Sleep' : 'Wake', okCount, total: ids.length, refused })
  }

  return (
    <>
      <PageHeader
        title="Devices"
        description="Phones connected to this farm"
        actions={
          <div className="flex items-center gap-2">
            {/* List | Wall (plan 42 §4.6) — a mode on this page, so the
                filters and tags below apply to the wall unchanged. */}
            <div className="inline-flex items-center rounded-lg border p-0.5">
              <button
                type="button"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                  view === 'list' ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg-muted',
                )}
              >
                <List className="size-3.5" aria-hidden />
                List
              </button>
              <button
                type="button"
                aria-pressed={view === 'wall'}
                onClick={() => setView('wall')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                  view === 'wall' ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg-muted',
                )}
              >
                <LayoutGrid className="size-3.5" aria-hidden />
                Wall
              </button>
            </div>
            {/* Tile size — S / M / L (plan 92 §3.11): a wall control, not a
                setting. It is a property of the screen someone is sitting in
                front of, so it persists in `localStorage` (`writeLocalPrefs`,
                unlike `view`'s own per-tab `sessionStorage` above) and only
                appears once the Wall is actually on screen, since it has no
                effect on the List. */}
            {view === 'wall' && (
              <div className="inline-flex items-center rounded-lg border p-0.5" role="group" aria-label="Tile size">
                {(
                  [
                    ['s', 'Small tiles'],
                    ['m', 'Medium tiles'],
                    ['l', 'Large tiles'],
                  ] as const
                ).map(([size, label]) => (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={tileSize === size}
                    aria-label={label}
                    title={label}
                    onClick={() => setTileSize(size)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11px] font-semibold uppercase leading-none transition-colors',
                      tileSize === size ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg-muted',
                    )}
                  >
                    {size}
                  </button>
                ))}
              </div>
            )}
            {/* Selection now works in EITHER view (plan 91 §5 step 91.8,
                F11) — no longer gated to `view === 'list'`, since it is one
                shared `useBulkSelection` instance behind both the table and
                the Wall. */}
            {selectMode ? (
              <>
                <Button size="sm" variant="ghost" onClick={bulk.toggleAll}>
                  {bulk.allChecked ? 'Clear all' : 'Select all'}
                </Button>
                <Button size="sm" variant="outline" onClick={exitSelectMode}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setSelectMode(true)}>
                Select devices
              </Button>
            )}
            {/* Discovered tray entry point (plan 56 §4.5) — deliberately
                absent, not disabled, when the tray is empty: a queue with
                nothing in it should cost nothing visually. */}
            {discovered.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setTrayOpen(true)}>
                <Inbox className="size-3.5" aria-hidden />
                Discovered ({discovered.length})
              </Button>
            )}
            <Button size="sm" onClick={() => setEnrollOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Add device
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label="More fleet actions">
                  <MoreVertical className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Plan 89 §3.2 point 5, §5 step 89.3 — reassigns 1..n in
                    list order and re-pushes every moved device's label in
                    the same request, so a compaction can never leave a
                    phone displaying a number that has already moved. */}
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setRenumberOpen(true) }}>
                  <Hash className="size-3.5" aria-hidden />
                  Renumber fleet…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog
              open={renumberOpen}
              onOpenChange={setRenumberOpen}
              trigger={<span className="hidden" />}
              title="Renumber the fleet?"
              description="Reassigns every device's number to close any gaps left by released or forgotten devices, in the same list order shown here, and re-applies the physical label of every device whose number changes. Devices whose number stays the same are untouched."
              confirmLabel="Renumber"
              destructive={false}
              onConfirm={renumberFleet}
            />
          </div>
        }
      />

      <div className="space-y-4 px-5 py-4">
        {/* The summary doubles as the filter: clicking "needs attention"
            filters straight away, instead of being a number you cannot act on. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['all', 'Total', summary.all, ''],
              ['ready', 'Ready', summary.ready, 'text-led-ok'],
              ['inUse', 'In use', summary.inUse, 'text-led-active'],
              ['attention', 'Needs attention', summary.attention, 'text-led-danger'],
            ] as const
          ).map(([key, label, value, tone]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key as Filter)}
              className={cn(
                'rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors',
                filter === key ? 'border-accent' : 'hover:border-line-strong',
              )}
            >
              <div className={cn('readout text-2xl leading-none', value > 0 ? tone : 'text-fg-subtle')}>
                {value}
              </div>
              <div className="rack-label mt-1.5">{label}</div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or serial…"
              aria-label="Search devices"
              className="h-8 pl-8 text-[12.5px]"
            />
          </div>

          {/* A cluster filter, including an explicit "Unclustered" option
              (plan 22.0 §4.5, acceptance #4) — separate from the tag chips
              below since a device has at most one cluster but any number of tags. */}
          <Select value={clusterFilter} onValueChange={setClusterFilter}>
            <SelectTrigger className="h-8 w-[10.5rem] text-[12.5px]" aria-label="Filter by cluster">
              <SelectValue placeholder="All clusters" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clusters</SelectItem>
              <SelectItem value="none">Unclustered</SelectItem>
              {clusters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Readiness filter (plan 43 §4.6, §5 step 43.5) — narrows by
              `actual`, the same field the badge itself shows. */}
          <Select value={readinessFilter} onValueChange={(v) => setReadinessFilter(v as ReadinessFilter)}>
            <SelectTrigger className="h-8 w-[8.5rem] text-[12.5px]" aria-label="Filter by readiness">
              <SelectValue placeholder="Any readiness" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any readiness</SelectItem>
              <SelectItem value="hot">Hot</SelectItem>
              <SelectItem value="awake">Awake</SelectItem>
              <SelectItem value="asleep">Asleep</SelectItem>
            </SelectContent>
          </Select>

          {/* Connection filter (plan 88 §3.1, §4.1, §4.9, F5) — narrows by
              the same badge value the card and the wall render, plus a
              coarser "On the network" bucket for the more common question
              (see the type's own comment for why both exist). */}
          <Select value={connectionFilter} onValueChange={(v) => setConnectionFilter(v as ConnectionFilter)}>
            <SelectTrigger className="h-8 w-[10rem] text-[12.5px]" aria-label="Filter by connection">
              <SelectValue placeholder="Any connection" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CONNECTION_FILTER_LABEL) as ConnectionFilter[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {CONNECTION_FILTER_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Group by: None | Cluster | Status | Tag (plan 47 §3.6, §4.5) —
              applies to the table AND the Wall, from the same `groups`
              value. This is what replaced the separate `/topology` route. */}
          <Select value={group} onValueChange={(v) => setGroup(v as GroupBy)}>
            <SelectTrigger className="h-8 w-[9.5rem] text-[12.5px]" aria-label="Group by">
              <SelectValue placeholder="Group by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No grouping</SelectItem>
              <SelectItem value="cluster">Group by cluster</SelectItem>
              <SelectItem value="status">Group by status</SelectItem>
              <SelectItem value="tag">Group by tag</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Tag filter bar (plan 19 §4.5): AND semantics, same as the API. */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                aria-pressed={selectedTags.includes(tag)}
                onClick={() => toggleTag(tag)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors',
                  selectedTags.includes(tag)
                    ? 'border-accent bg-accent/15 text-accent-strong'
                    : 'border-line text-fg-muted hover:border-line-strong',
                )}
              >
                {tag}
              </button>
            ))}
            {selectedTags.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTags([])}
                className="rounded-full px-2 py-0.5 text-[11px] text-fg-subtle hover:text-fg-muted"
              >
                Clear tags
              </button>
            )}
          </div>
        )}

        {/* The toolbar itself is view-agnostic too (plan 91 §5 step 91.8,
            F11) — Wake/Sleep/Install/Forget apply to whatever is selected
            regardless of which view picked it. */}
        {selectMode && selectedIds.length > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-accent/40 bg-accent/5 px-3.5 py-2.5">
            <span className="text-[12.5px]">
              {selectedIds.length} device{selectedIds.length === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2">
              {/* Warming or sleeping a whole cluster is the actual use case
                  (plan 43 §4.6) — one tile at a time is the thing that would
                  make an operator write a script. Each device is set
                  independently; a refusal on one (e.g. a job running) does
                  not block the rest. */}
              <Button size="sm" variant="outline" onClick={() => void wakeOrSleepSelected('awake')}>
                Wake selected
              </Button>
              <Button size="sm" variant="outline" onClick={() => void wakeOrSleepSelected('asleep')}>
                Sleep selected
              </Button>
              <Button size="sm" onClick={() => setInstallBatchOpen(true)}>
                <Upload className="size-3.5" aria-hidden />
                Install on selected
              </Button>
              {/* Fleet-wide switch-on (plan 89 §3.7 point 3, §5 step 89.8) —
                  applies each selected device's OWN current `labelling.mode`
                  (off/lock-screen/wallpaper), it does not change what mode any
                  device is set to. Turning labelling on for a device that has
                  never had it applied is what makes this useful on an
                  existing farm after the farm default changes. */}
              <Button size="sm" variant="outline" disabled={isPending('apply-labels')} onClick={() => void applyLabelsToSelected()}>
                <Hash className="size-3.5" aria-hidden />
                {isPending('apply-labels') ? 'Applying…' : 'Apply labels'}
              </Button>
              {/* Run command / Push file / Pull file (plan 93 §3.16, §4.8,
                  F15, step 93.11) — beside the existing Install, attaching
                  to whatever selection the page already exposes. Wall-view
                  selection is plan 91's, not this plan's (§3.16) — this
                  toolbar reads `selectedIds` regardless of which view
                  populated it, exactly as Wake/Sleep/Install/Forget
                  already do. */}
              <Button size="sm" variant="outline" asChild>
                <Link href={`/console?deviceIds=${selectedIds.map(encodeURIComponent).join(',')}`}>
                  <Terminal className="size-3.5" aria-hidden />
                  Run command…
                </Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBulkTransferOpen('push')}>
                <Upload className="size-3.5" aria-hidden />
                Push file…
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBulkTransferOpen('pull')}>
                <Download className="size-3.5" aria-hidden />
                Pull file…
              </Button>
              {/* Bulk Forget (plan 47 §4.5, acceptance #9) — the operation
                  this farm needs today for its permanently-offline rows. */}
              <Button size="sm" variant="outline" className="text-led-danger" onClick={() => setBulkForgetOpen(true)}>
                <Trash2 className="size-3.5" aria-hidden />
                Forget selected
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : devices === null ? (
          <LoadingRows rows={4} />
        ) : devices.length === 0 && discovered.length > 0 ? (
          // The farm is empty but a phone IS plugged in, waiting to be
          // admitted (plan 56). Telling that operator to "plug in a phone"
          // would be answering a question they did not ask, about a thing
          // they already did.
          <EmptyState
            icon={<Smartphone className="size-4" aria-hidden />}
            title={discovered.length === 1 ? 'One phone is waiting to be added' : `${discovered.length} phones are waiting to be added`}
            description={<>Connecting a phone does not add it to the farm. Open Discovered to name it and add it.</>}
            action={<Button onClick={() => setTrayOpen(true)}>Open Discovered</Button>}
          />
        ) : devices.length === 0 ? (
          <EmptyState
            icon={<Smartphone className="size-4" aria-hidden />}
            title="No devices yet"
            description={
              <>
                Plug in a phone over USB with USB debugging turned on, then accept the prompt on its screen. For
                devices on the same network, use wireless pairing.
              </>
            }
            action={<Button onClick={() => setEnrollOpen(true)}>Add device</Button>}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            description="Change the search or pick a different filter."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                }}
              >
                Show all
              </Button>
            }
          />
        ) : view === 'wall' ? (
          <Wall
            devices={filtered}
            jobs={jobs}
            groups={groups}
            selectable={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelected}
            focusId={focusId}
            onFocus={setFocus}
            minTileWidthPx={TILE_SIZE_PX[tileSize]}
          />
        ) : groups ? (
          <div className="space-y-5">
            {groups.map(([tag, list]) => (
              <div key={tag}>
                <h3 className="rack-label mb-2">
                  {tag} <span className="text-fg-subtle">· {list.length}</span>
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {list.map((d) => (
                    <DeviceCard
                      key={`${tag}-${d.id}`}
                      device={d}
                      runningJob={jobs.find((j) => j.deviceId === d.id) ?? null}
                      onReleaseQuarantine={d.status === 'quarantined' ? () => void releaseQuarantine(d) : undefined}
                      canReleaseQuarantine={canReleaseQuarantine}
                      onRequestForget={() => {
                        setForgetTarget(d)
                        setForgetOpen(true)
                      }}
                      onRequestDisconnect={() => {
                        setDisconnectTarget(d)
                        setDisconnectOpen(true)
                      }}
                      onReconnect={() => void reconnectDevice(d)}
                      selectable={selectMode}
                      selected={selectedIds.includes(d.id)}
                      onToggleSelect={() => toggleSelected(d.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((d) => (
              <DeviceCard
                key={d.id}
                device={d}
                runningJob={jobs.find((j) => j.deviceId === d.id) ?? null}
                onReleaseQuarantine={d.status === 'quarantined' ? () => void releaseQuarantine(d) : undefined}
                canReleaseQuarantine={canReleaseQuarantine}
                onRequestForget={() => {
                  setForgetTarget(d)
                  setForgetOpen(true)
                }}
                onRequestDisconnect={() => {
                  setDisconnectTarget(d)
                  setDisconnectOpen(true)
                }}
                onReconnect={() => void reconnectDevice(d)}
                selectable={selectMode}
                selected={selectedIds.includes(d.id)}
                onToggleSelect={() => toggleSelected(d.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* "mouse akan ada indikator device yang terseleksi berapa" (plan 91
          §0.3, §5 step 91.8, F11/F12) — a live count that follows the
          cursor while selecting, in either view. `position: fixed`, so
          where it mounts in the tree does not matter. */}
      <SelectionCursorBadge active={selectMode} count={selectedIds.length} />

      {/* The focus overlay (plan 91 §3.11, §5 step 91.9) — only on the Wall,
          only once a tile has actually been double-clicked. `devices` is the
          FULL, unfiltered list (not `filtered`): a selected device that has
          scrolled out of the current filter must still be a valid Mirror
          candidate. */}
      {view === 'wall' && focusId && (
        <FocusOverlay deviceId={focusId} devices={devices ?? []} selectedIds={selectedIds} onClose={clearFocus} />
      )}

      <DiscoveredTray
        discovered={discovered}
        clusters={clusters}
        farmLabellingMode={farmLabellingMode}
        open={trayOpen}
        onOpenChange={setTrayOpen}
        onChanged={() => {
          loadDiscovered()
          void load()
        }}
      />
      <EnrollmentDialog open={enrollOpen} onOpenChange={setEnrollOpen} unauthorizedSerials={unauthorized} />
      <InstallBatchDialog
        open={installBatchOpen}
        onOpenChange={(o) => {
          setInstallBatchOpen(o)
          if (!o) exitSelectMode()
        }}
        devices={(devices ?? []).filter((d) => selectedIds.includes(d.id))}
      />
      <BulkTransferDialog
        mode={bulkTransferOpen ?? 'push'}
        open={bulkTransferOpen !== null}
        onOpenChange={(o) => {
          if (!o) {
            setBulkTransferOpen(null)
            exitSelectMode()
          }
        }}
        devices={(devices ?? []).filter((d) => selectedIds.includes(d.id))}
      />
      {/* Plan 93 §3.15, §4.8, F15, H3, step 93.11 — `wakeOrSleepSelected`'s
          own report: the same `OutcomeSummary`/`SkippedGroups` pair every
          other bulk surface uses, so a wake/sleep that refuses on some
          devices names every one of them instead of an anonymous toast. */}
      <Dialog open={wakeSleepReport !== null} onOpenChange={(o) => !o && setWakeSleepReport(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{wakeSleepReport?.verb} — result</DialogTitle>
          </DialogHeader>
          {wakeSleepReport && (
            <div className="space-y-3">
              <OutcomeSummary
                counts={{
                  ok: wakeSleepReport.okCount,
                  failed: wakeSleepReport.refused.length,
                  skipped: 0,
                  total: wakeSleepReport.total,
                }}
                label={`${wakeSleepReport.verb} progress`}
              />
              <SkippedGroups failed={wakeSleepReport.refused} skipped={[]} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWakeSleepReport(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* "Apply labels"' own report (plan 89 §5 step 89.8) — the same
          `OutcomeSummary`/`SkippedGroups` pair `InstallBatchDialog` uses,
          stays open so nothing is lost the instant the call resolves.
          `partial`/`unavailable`/`stale`/`unknown` group under `skipped`
          with the labelling service's own reason text, never rounded up
          into `ok`. */}
      <Dialog open={labelsApplyReport !== null} onOpenChange={(o) => !o && setLabelsApplyReport(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply labels — result</DialogTitle>
          </DialogHeader>
          {labelsApplyReport && (
            <div className="space-y-3">
              <OutcomeSummary counts={labelsApplyReport.counts} label="Apply labels progress" />
              <SkippedGroups failed={labelsApplyReport.failed} skipped={labelsApplyReport.skipped} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLabelsApplyReport(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ForgetDeviceDialog
        device={forgetTarget}
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        onDone={() => void load()}
      />
      <DisconnectDeviceDialog
        device={disconnectTarget}
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        onDone={() => void load()}
      />
      <BulkForgetDialog
        devices={(devices ?? []).filter((d) => selectedIds.includes(d.id))}
        open={bulkForgetOpen}
        onOpenChange={(o) => {
          setBulkForgetOpen(o)
          if (!o) exitSelectMode()
        }}
        onDone={() => void load()}
      />
    </>
  )
}

export default function Dashboard() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <DashboardView />
    </Suspense>
  )
}
