'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Smartphone } from 'lucide-react'
import type { DeviceInfo } from '@enkaku/protocol'
import { ClusterSection } from '@/components/topology/ClusterSection'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/actions'
import { fetchTopology, type TopologyResponse } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/** Fallback only until `/api/settings` answers — never the value actually used to colour a tile. */
const DEFAULT_TEMP_THRESHOLD_C = 45

const UNGROUPED_KEY = '__ungrouped__'

/**
 * The fleet map (plan 32). One screen, every device, grouped by cluster —
 * built entirely from existing cards, badges and LED colours, no graph
 * library (plan 32 §3.3). The map navigates; it does not act (plan 32 §2).
 */
export default function TopologyPage() {
  const [topo, setTopo] = useState<TopologyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tempThresholdC, setTempThresholdC] = useState(DEFAULT_TEMP_THRESHOLD_C)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [compact, setCompact] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // "running for 2m" on a busy tile, without a per-tile timer (Plan 17 §4.6).
  const now = useNow()

  const load = async () => {
    setError(null)
    try {
      setTopo(await fetchTopology())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
    // Temperature turns warning-coloured at the farm's actual auto-quarantine
    // threshold (plan 32 §4, not a number picked for this screen).
    void api<{ settings: { battery: { tempThresholdC: number } } }>('/api/settings')
      .then((b) => setTempThresholdC(b.settings.battery.tempThresholdC))
      .catch(() => undefined)

    // Live, and cheap (plan 32 §3.5): one fetch on load, then patch tiles in
    // place from the events that already exist — never a poll.
    const off = ws.on((m) => {
      if (m.type === 'device.status') {
        setTopo((prev) =>
          prev
            ? {
                ...prev,
                devices: prev.devices.map((d) => (d.id === m.payload.id ? { ...d, status: m.payload.status } : d)),
              }
            : prev,
        )
      } else if (m.type === 'device.battery') {
        setTopo((prev) =>
          prev
            ? {
                ...prev,
                devices: prev.devices.map((d) =>
                  d.id === m.payload.deviceId ? { ...d, battery: m.payload.battery } : d,
                ),
              }
            : prev,
        )
      } else if (m.type === 'job.status') {
        setTopo((prev) => {
          if (!prev) return prev
          // One job runs per device at a time (the per-device queue
          // guarantees it) — drop any prior entry for this device, then add
          // the new one back only if it is still running.
          const rest = prev.activeJobs.filter((j) => j.deviceId !== m.payload.deviceId)
          const activeJobs =
            m.payload.status === 'running'
              ? [
                  ...rest,
                  {
                    deviceId: m.payload.deviceId,
                    jobId: m.payload.jobId,
                    scriptName: m.payload.scriptName,
                    startedAt: m.payload.startedAt,
                  },
                ]
              : rest
          return { ...prev, activeJobs }
        })
      }
      // 'batch.status' carries no per-device fields — the devices it affects
      // already announce themselves through job.status above, so there is
      // nothing further to patch here.
    })
    return off
  }, [])

  const deviceById = useMemo(() => new Map((topo?.devices ?? []).map((d) => [d.id, d])), [topo])

  // Only tags actually in use — an empty filter bar is not shown.
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const d of topo?.devices ?? []) for (const t of d.tags) set.add(t)
    return [...set].sort()
  }, [topo])

  const matchesFilter = (d: DeviceInfo) => selectedTags.every((t) => d.tags.includes(t))

  // A device's total cluster count (plan 32 §3.2) — shown on the tile so a
  // repeat across sections never reads as a data error.
  const clusterCountByDevice = useMemo(() => {
    const counts = new Map<string, number>()
    for (const cl of topo?.clusters ?? []) for (const id of cl.deviceIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    return counts
  }, [topo])

  const activeJobsByDevice = useMemo(() => new Map((topo?.activeJobs ?? []).map((j) => [j.deviceId, j])), [topo])

  /**
   * Resolves a section's device ids, then tells apart the two reasons a
   * section could render empty (plan 32 §4.3, acceptance #7): the cluster
   * genuinely matches nothing (a real misconfiguration, worth saying so) vs.
   * the tag filter above happens to hide everything it does match.
   */
  const sectionOf = (ids: string[], genuinelyEmptyMessage: string) => {
    const raw = ids.map((id) => deviceById.get(id)).filter((d): d is DeviceInfo => d !== undefined)
    const devices = raw.filter(matchesFilter).sort((a, b) => a.label.localeCompare(b.label))
    const emptyMessage =
      raw.length === 0 ? genuinelyEmptyMessage : devices.length === 0 ? 'No device here matches the selected tags.' : undefined
    return { devices, emptyMessage }
  }

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <PageHeader
        title="Topology"
        description="The whole farm at once, grouped by cluster — every device belongs to at most one"
        meta={
          <label className="flex items-center gap-2 text-[12px] text-fg-muted">
            <Switch size="sm" checked={compact} onCheckedChange={setCompact} />
            Compact
          </label>
        }
      />

      <div className="space-y-5 px-5 py-4">
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
        ) : topo === null ? (
          <LoadingRows rows={4} />
        ) : topo.devices.length === 0 ? (
          <EmptyState
            icon={<Smartphone className="size-4" aria-hidden />}
            title="No devices yet"
            description="The map has nothing to show until at least one phone is enrolled in this farm."
            action={
              <Button asChild>
                <Link href="/">Go to Devices</Link>
              </Button>
            }
          />
        ) : (
          <>
            {topo.clusters.length === 0 && (
              <p className="rounded-lg border border-dashed px-4 py-3 text-[12px] text-fg-muted">
                No clusters yet — a cluster is a container devices are put into, so a group of them can be seen (and
                run against) together.{' '}
                <Link href="/clusters" className="text-accent hover:underline">
                  Create one
                </Link>
                .
              </p>
            )}

            {topo.clusters.map((cl) => {
              const section = sectionOf(cl.deviceIds, 'No devices in this cluster yet.')
              return (
                <ClusterSection
                  key={cl.id}
                  title={cl.name}
                  devices={section.devices}
                  clusterCountByDevice={clusterCountByDevice}
                  activeJobsByDevice={activeJobsByDevice}
                  tempThresholdC={tempThresholdC}
                  now={now}
                  compact={compact}
                  collapsed={collapsed.has(cl.id)}
                  onToggleCollapse={() => toggleCollapse(cl.id)}
                  emptyMessage={section.emptyMessage}
                />
              )
            })}

            {(() => {
              const section = sectionOf(topo.ungroupedDeviceIds, 'Every device belongs to at least one cluster.')
              return (
                <ClusterSection
                  title="Ungrouped"
                  devices={section.devices}
                  clusterCountByDevice={clusterCountByDevice}
                  activeJobsByDevice={activeJobsByDevice}
                  tempThresholdC={tempThresholdC}
                  now={now}
                  compact={compact}
                  collapsed={collapsed.has(UNGROUPED_KEY)}
                  onToggleCollapse={() => toggleCollapse(UNGROUPED_KEY)}
                  emptyMessage={section.emptyMessage}
                />
              )
            })()}
          </>
        )}
      </div>
    </>
  )
}
