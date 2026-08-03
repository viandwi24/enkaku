'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LayoutGrid, List, Plus, Search, Smartphone, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { ClusterInfo, DeviceInfo, DeviceStatus, JobInfo, Readiness } from '@enkaku/protocol'
import { DeviceCard } from '@/components/DeviceCard'
import { EnrollmentDialog } from '@/components/EnrollmentDialog'
import { InstallBatchDialog } from '@/components/InstallBatchDialog'
import { ForgetDeviceDialog } from '@/components/ForgetDeviceDialog'
import { BulkForgetDialog } from '@/components/BulkForgetDialog'
import { Wall } from '@/components/wall/Wall'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDevices } from '@/lib/api'
import { setDeviceReadiness } from '@/lib/readiness'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'ready' | 'inUse' | 'attention'
/** 'all' = no filter, 'none' = the explicit "Unclustered" option (plan 22.0 §4.5), else a cluster id. */
type ClusterFilter = 'all' | 'none' | (string & {})
/** A readiness filter, by `actual` (plan 43 §4.6) — 'all' = no filter. */
type ReadinessFilter = 'all' | 'hot' | 'awake' | 'asleep'
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
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [unauthorized, setUnauthorized] = useState<string[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [clusterFilter, setClusterFilter] = useState<ClusterFilter>('all')
  const [readinessFilter, setReadinessFilter] = useState<ReadinessFilter>('all')
  // View (List | Wall) and Group (None | Cluster | Status | Tag) are two
  // orthogonal controls, both in the query string so a view is linkable
  // (plan 47 §3.6, §4.5) — this is what replaces the separate `/topology`
  // route: it becomes `view=wall&group=cluster`.
  const [view, setViewState] = useState<View>(() => {
    const v = params.get('view')
    return isView(v) ? v : 'list'
  })
  const [group, setGroupState] = useState<GroupBy>(() => {
    const g = params.get('group')
    return isGroupBy(g) ? g : 'none'
  })
  const [error, setError] = useState<string | null>(null)
  const [enrollOpen, setEnrollOpen] = useState(false)
  // Multi-select for a batch action (plan 39 §4.5, §4.7) — "Install on
  // selected" is the only action today; the shape leaves room for others later.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [installBatchOpen, setInstallBatchOpen] = useState(false)
  // Removal (plan 47 §4.5): a single-device dialog (row menu, offers Block
  // instead on refusal) and a bulk one for the multi-select toolbar.
  const [forgetTarget, setForgetTarget] = useState<DeviceInfo | null>(null)
  const [forgetOpen, setForgetOpen] = useState(false)
  const [bulkForgetOpen, setBulkForgetOpen] = useState(false)
  const { run } = useAction()

  const load = async () => {
    setError(null)
    try {
      const [d, j] = await Promise.all([
        fetchDevices(),
        api<{ jobs: JobInfo[] }>('/api/jobs?status=running&limit=50'),
      ])
      setDevices(d)
      setJobs(j.jobs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void fetchAllPages<ClusterInfo>('/api/clusters')
      .then(setClusters)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void load()
    const off = ws.on((m) => {
      if (m.type === 'device.added' || m.type === 'device.removed' || m.type === 'device.status') void load()
      else if (m.type === 'job.status') void load()
      else if (m.type === 'device.battery') {
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
      }
    })
    return off
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
    if (q) list = list.filter((d) => d.label.toLowerCase().includes(q) || d.serial.toLowerCase().includes(q))
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
    return list
  }, [devices, filter, query, selectedTags, clusterFilter, readinessFilter])

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
  }
  const setGroup = (g: GroupBy) => {
    setGroupState(g)
    pushParams({ group: g })
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
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const releaseQuarantine = (d: DeviceInfo) =>
    run('unq-' + d.id, () => api(`/api/devices/${d.id}/unquarantine`, { method: 'POST' }), {
      success: `${d.label} is back in the queue`,
      failure: 'Could not return the device to the queue',
      onSuccess: () => void load(),
    })

  /**
   * "Wake selected" / "Sleep selected" (plan 43 §4.6, §5 step 43.5) — one
   * `PUT .../readiness` per device, each independently refused or accepted
   * server-side (§3.4); one device's refusal (a running job, another
   * viewer) never blocks the rest. The result is reported as a single
   * summary toast rather than one per device, since a farm-wide action on
   * ten devices should not produce ten toasts.
   */
  const wakeOrSleepSelected = async (desired: Readiness) => {
    const ids = [...selectedIds]
    const results = await Promise.allSettled(ids.map((id) => setDeviceReadiness(id, desired)))
    const failed = results.filter((r) => r.status === 'rejected').length
    const verb = desired === 'asleep' ? 'Sleep' : 'Wake'
    if (failed === 0) toast.success(`${verb} sent to ${ids.length} device${ids.length === 1 ? '' : 's'}`)
    else if (failed === ids.length) toast.error(`${verb} failed for all ${ids.length} selected devices`)
    else toast.warning(`${verb}: ${ids.length - failed} succeeded, ${failed} refused`)
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
            {view === 'list' &&
              (selectMode ? (
                <Button size="sm" variant="outline" onClick={exitSelectMode}>
                  Cancel
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setSelectMode(true)}>
                  Select devices
                </Button>
              ))}
            <Button size="sm" onClick={() => setEnrollOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Add device
            </Button>
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

        {view === 'list' && selectMode && selectedIds.size > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-accent/40 bg-accent/5 px-3.5 py-2.5">
            <span className="text-[12.5px]">
              {selectedIds.size} device{selectedIds.size === 1 ? '' : 's'} selected
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
          <Wall devices={filtered} jobs={jobs} groups={groups} />
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
                      onRequestForget={() => {
                        setForgetTarget(d)
                        setForgetOpen(true)
                      }}
                      selectable={selectMode}
                      selected={selectedIds.has(d.id)}
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
                onRequestForget={() => {
                  setForgetTarget(d)
                  setForgetOpen(true)
                }}
                selectable={selectMode}
                selected={selectedIds.has(d.id)}
                onToggleSelect={() => toggleSelected(d.id)}
              />
            ))}
          </div>
        )}
      </div>

      <EnrollmentDialog open={enrollOpen} onOpenChange={setEnrollOpen} unauthorizedSerials={unauthorized} />
      <InstallBatchDialog
        open={installBatchOpen}
        onOpenChange={(o) => {
          setInstallBatchOpen(o)
          if (!o) exitSelectMode()
        }}
        deviceIds={[...selectedIds]}
      />
      <ForgetDeviceDialog
        device={forgetTarget}
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        onDone={() => void load()}
      />
      <BulkForgetDialog
        devices={(devices ?? []).filter((d) => selectedIds.has(d.id))}
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
