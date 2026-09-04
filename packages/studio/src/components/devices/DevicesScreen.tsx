'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Target } from '@enkaku/protocol'
import { EnrollmentDialog } from '@/components/EnrollmentDialog'
import { useDeviceControl, useFocusedDeviceId } from '@/components/device-control/DeviceControlHost'
import { retargetSelection } from '@/components/device-control/retarget'
import { readLocalPrefs, readSessionPrefs, writeLocalPrefs, writeSessionPrefs } from '@/lib/prefs'
import { ws } from '@/lib/ws'
import { BulkPill } from './BulkPill'
import { DeviceTable } from './DeviceTable'
import { DiscoverySheet } from './DiscoverySheet'
import { DevicesToolbar, matchesDevice, type CardWidth, type DevicesFilter, type DevicesView } from './DevicesToolbar'
import { isDeviceState, reconnectingAttempt } from './device-state'
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

  /**
   * `?focus=` is gone with the local state.
   *
   * A window that outlives the page cannot have its identity in that page's
   * query string: leaving `/` would drop the parameter while the window
   * stayed open, and the address would be lying about what is on screen. The
   * store is the single source of truth; `?device=` below is still honoured
   * as a one-shot deep link, which is all it ever was.
   */
  const setFocus = (id: string | null, mirror?: readonly string[]) => {
    if (id) deviceControl.open(id, mirror ?? [id])
    else deviceControl.close()
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
        // Connection first — `status` is the physical fact (spec §4), and
        // `connecting` is derived from the live rebuild activity rather than
        // from a fourth stored status.
        if (filter === 'online') return d.status === 'online'
        if (filter === 'connecting') return reconnectingAttempt(d) !== null
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

  // Device Control is mounted once by the root layout now (plan 215's window
  // used to live here, which is why navigating away killed the cast). This
  // screen opens it and reads which device it holds; it never renders it.
  const deviceControl = useDeviceControl()
  const focusId = useFocusedDeviceId()

  const selection = useDeviceSelection({
    filteredIds,
    containerRef,
    onOpenControl: (id) => {
      const mirror = retargetSelection(id, [...selection.selected])
      selection.set(mirror)
      setFocus(id, mirror)
    },
  })

  // Plan 218 §4.14 — the Jobs screen's "Open device" button links here with
  // `?device=<id>`. Consumed once and stripped, so a reload or a Back does
  // not reopen a window the operator has closed, and the address never
  // becomes a second, competing source of truth for which device is
  // focused.
  useEffect(() => {
    const id = params.get('device')
    if (!id) return
    deviceControl.open(id)
    const next = new URLSearchParams(params.toString())
    next.delete('device')
    router.replace(next.toString() ? `/?${next.toString()}` : '/')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        <BulkPill count={selection.selected.size} target={target} onClear={selection.clear} />
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
