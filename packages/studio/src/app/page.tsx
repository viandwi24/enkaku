'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Smartphone } from 'lucide-react'
import type { ClusterInfo, DeviceInfo, JobInfo } from '@enkaku/protocol'
import { DeviceCard } from '@/components/DeviceCard'
import { EnrollmentDialog } from '@/components/EnrollmentDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, useAction } from '@/lib/actions'
import { fetchAllPages, fetchDevices } from '@/lib/api'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'ready' | 'inUse' | 'attention'
/** 'all' = no filter, 'none' = the explicit "Unclustered" option (plan 22.0 §4.5), else a cluster id. */
type ClusterFilter = 'all' | 'none' | (string & {})

export default function Dashboard() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [clusters, setClusters] = useState<ClusterInfo[]>([])
  const [unauthorized, setUnauthorized] = useState<string[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [clusterFilter, setClusterFilter] = useState<ClusterFilter>('all')
  const [groupByTag, setGroupByTag] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrollOpen, setEnrollOpen] = useState(false)
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
    return list
  }, [devices, filter, query, selectedTags, clusterFilter])

  // Grouping is a view concern only (plan 19 §4.5) — a device with several
  // tags appears in each group; devices with none get their own bucket.
  const groups = useMemo(() => {
    if (!groupByTag) return null
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
  }, [filtered, groupByTag])

  const releaseQuarantine = (d: DeviceInfo) =>
    run('unq-' + d.id, () => api(`/api/devices/${d.id}/unquarantine`, { method: 'POST' }), {
      success: `${d.label} is back in the queue`,
      failure: 'Could not return the device to the queue',
      onSuccess: () => void load(),
    })

  return (
    <>
      <PageHeader
        title="Devices"
        description="Phones connected to this farm"
        actions={
          <Button size="sm" onClick={() => setEnrollOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add device
          </Button>
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

          {allTags.length > 0 && (
            <label className="flex items-center gap-2 text-[12px] text-fg-muted">
              <Switch size="sm" checked={groupByTag} onCheckedChange={setGroupByTag} />
              Group by tag
            </label>
          )}
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
              />
            ))}
          </div>
        )}
      </div>

      <EnrollmentDialog open={enrollOpen} onOpenChange={setEnrollOpen} unauthorizedSerials={unauthorized} />
    </>
  )
}
