'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Target } from '@enkaku/protocol'
import { EnrollmentDialog } from '@/components/EnrollmentDialog'
import { readLocalPrefs, readSessionPrefs, writeLocalPrefs, writeSessionPrefs } from '@/lib/prefs'
import { ws } from '@/lib/ws'
import { BulkPill } from './BulkPill'
import { DeviceTable } from './DeviceTable'
import { DiscoverySheet } from './DiscoverySheet'
import { DevicesToolbar, matchesDevice, type CardWidth, type DevicesFilter, type DevicesView } from './DevicesToolbar'
import { isDeviceState } from './device-state'
import { ScreensGrid } from './ScreensGrid'
import { taskLabelOf } from './TaskCell'
import { useDeviceSelection } from './useDeviceSelection'
import { useDevices } from './useDevices'
import { useQueuedJobs } from './useQueuedJobs'

/**
 * The composition inside plan 213's `PagePanel` (design handoff, "Screen:
 * Devices"; plan 214 §4.17): the toolbar, the table or the Screens grid, the
 * bulk pill, the discovery sheet, the enrolment dialog, and the marquee
 * overlay rectangle. Every fetch and every gesture on this screen lives
 * under `components/devices/`; this file only wires them together.
 */
export function DevicesScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const containerRef = useRef<HTMLDivElement>(null)

  const { devices, groups, discovered, reload } = useDevices()
  const { queuedFor } = useQueuedJobs()

  const [activeGroup, setActiveGroup] = useState(params.get('group') ?? 'all')
  const [view, setView] = useState<DevicesView>(() => (params.get('view') as DevicesView) || readSessionPrefs().devicesView || 'table')
  const [cardWidth, setCardWidth] = useState<CardWidth>(() => readLocalPrefs().cardWidth)
  const [filter, setFilter] = useState<DevicesFilter>('all')
  const [query, setQuery] = useState('')
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [spinning, setSpinning] = useState(false)

  // Enrolment (§9 Q5, kept undrawn by the handoff): the only surface that
  // tells an operator a phone is waiting for its adb authorisation prompt.
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [unauthorized, setUnauthorized] = useState<string[]>([])
  const unauthorizedSeen = useRef<Set<string>>(new Set())

  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type !== 'device.unauthorized') return
      if (unauthorizedSeen.current.has(m.payload.serial)) return
      unauthorizedSeen.current.add(m.payload.serial)
      setUnauthorized((prev) => (prev.includes(m.payload.serial) ? prev : [...prev, m.payload.serial]))
      setEnrollOpen(true)
    })
    return off
  }, [])

  const setViewAndPersist = (v: DevicesView) => {
    setView(v)
    writeSessionPrefs({ devicesView: v })
    const next = new URLSearchParams(params.toString())
    next.set('view', v)
    router.replace(`/?${next.toString()}`)
  }

  const setGroupAndPersist = (id: string) => {
    setActiveGroup(id)
    const next = new URLSearchParams(params.toString())
    next.set('group', id)
    router.replace(`/?${next.toString()}`)
  }

  const setCardWidthAndPersist = (w: CardWidth) => {
    setCardWidth(w)
    writeLocalPrefs({ cardWidth: w })
  }

  const groupScoped = useMemo(
    () => (devices ?? []).filter((d) => (activeGroup === 'all' ? true : d.group?.id === activeGroup)),
    [devices, activeGroup],
  )

  const statusFiltered = useMemo(
    () =>
      groupScoped.filter((d) => {
        if (filter === 'all') return true
        if (filter === 'quarantined') return d.status === 'quarantined'
        if (filter === 'offline') return d.status === 'offline'
        return isDeviceState(d, filter)
      }),
    [groupScoped, filter],
  )

  const filtered = useMemo(
    () => statusFiltered.filter((d) => matchesDevice(d, query, taskLabelOf(d, queuedFor(d.id)))),
    [statusFiltered, query, queuedFor],
  )

  const filteredIds = useMemo(() => filtered.map((d) => d.id), [filtered])

  const selection = useDeviceSelection({ filteredIds, containerRef })

  const pendingCount = discovered.length

  const target: Target = { deviceIds: [...selection.selected] }

  const rescan = () => {
    setSpinning(true)
    setTimeout(() => setSpinning(false), 1400)
  }

  if (devices === null) {
    return <div className="flex flex-1 items-center justify-center text-body text-faint">Loading…</div>
  }

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col">
      <DevicesToolbar
        groups={groups}
        devices={statusFiltered}
        allDevices={devices}
        activeGroup={activeGroup}
        onSelectGroup={setGroupAndPersist}
        onGroupsMutated={reload}
        view={view}
        onViewChange={setViewAndPersist}
        cardWidth={cardWidth}
        onCardWidthChange={setCardWidthAndPersist}
        filter={filter}
        onFilterChange={setFilter}
        query={query}
        onQueryChange={setQuery}
        matchCount={filtered.length}
        pendingCount={pendingCount}
        onOpenDiscovery={() => setDiscoveryOpen(true)}
      />

      {view === 'table' ? (
        <DeviceTable
          devices={filtered}
          selected={selection.selected}
          onItemMouseDown={selection.onItemMouseDown}
          onItemDoubleClick={selection.onItemDoubleClick}
          onToggle={selection.toggle}
          onSelectAll={(checked) => (checked ? selection.set(filteredIds) : selection.clear())}
          queuedFor={queuedFor}
        />
      ) : (
        <ScreensGrid devices={filtered} cardWidth={cardWidth} selection={selection} />
      )}

      {selection.selected.size > 0 && (
        <BulkPill count={selection.selected.size} target={target} groups={groups} onClear={selection.clear} />
      )}

      <DiscoverySheet
        open={discoveryOpen}
        onOpenChange={setDiscoveryOpen}
        discovered={discovered}
        onMutated={reload}
        spinning={spinning}
        onRescan={rescan}
      />

      <EnrollmentDialog
        open={enrollOpen}
        onOpenChange={(v) => {
          setEnrollOpen(v)
          if (!v) setUnauthorized([])
        }}
        unauthorizedSerials={unauthorized}
      />

      {selection.rect && (
        <div className="pointer-events-none fixed z-50 rounded-[6px] border border-accent bg-accent-a1" style={selection.rect} />
      )}
    </div>
  )
}
