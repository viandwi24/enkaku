'use client'

import { useState } from 'react'
import { ReconcileReportSchema, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import {
  ArrowsClockwiseIcon,
  ArrowsLeftRightIcon,
  CheckIcon,
  DotsThreeIcon,
  FunnelIcon,
  Input,
  MagnifyingGlassIcon,
  RowsIcon,
  SquaresFourIcon,
  StatusDot,
  TrayArrowDownIcon,
  api,
  cn,
  matchesDeviceQuery,
} from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'
import { GroupTabs } from './GroupTabs'
import { dotStateOf, isDeviceState, reconnectingAttempt } from './device-state'

export type DevicesFilter = 'all' | 'online' | 'connecting' | 'offline' | 'quarantined' | 'free' | 'controlled' | 'job'
export type DevicesView = 'table' | 'screens'

export const CARD_WIDTH_PX = { s: 112, m: 146, l: 190, xl: 240 } as const
export type CardWidth = keyof typeof CARD_WIDTH_PX

const RESCAN_SPIN_MS = 1400

/**
 * `serial, label, model, task` (design handoff, Search popover). Matches
 * name, serial, model, group and task, so the search box and the match count
 * beside it can never disagree (plan 214 §4.6).
 */
export function matchesDevice(d: DeviceInfo, q: string, task: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return (
    matchesDeviceQuery(d, needle) ||
    d.serial.toLowerCase().includes(needle) ||
    (d.model ?? '').toLowerCase().includes(needle) ||
    (d.group?.name ?? '').toLowerCase().includes(needle) ||
    task.toLowerCase().includes(needle)
  )
}

const ICON_BTN = 'flex size-8 flex-none items-center justify-center rounded-button transition-colors'
const ICON_IDLE = 'text-faint hover:bg-muted-2 hover:text-text'
const ICON_ACTIVE = 'bg-accent-soft text-accent'
const ROW = 'flex w-full items-center gap-2 rounded-button px-[10px] py-[9px] text-row transition-colors hover:bg-muted'

export function DevicesToolbar({
  groups,
  devices,
  allDevices,
  activeGroup,
  onSelectGroup,
  onGroupsMutated,
  view,
  onViewChange,
  cardWidth,
  onCardWidthChange,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  matchCount,
  pendingCount,
  onOpenDiscovery,
  onOpenOtg,
  onOpenScan,
}: {
  groups: GroupInfo[]
  /** The group-scoped device list — what the filter menu's counts describe. */
  devices: DeviceInfo[]
  /** The whole farm — what the group tab counts describe. */
  allDevices: DeviceInfo[]
  activeGroup: string
  onSelectGroup: (id: string) => void
  onGroupsMutated: () => void
  view: DevicesView
  onViewChange: (v: DevicesView) => void
  cardWidth: CardWidth
  onCardWidthChange: (w: CardWidth) => void
  filter: DevicesFilter
  onFilterChange: (f: DevicesFilter) => void
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  pendingCount: number
  onOpenDiscovery: () => void
  onOpenOtg: () => void
  onOpenScan: () => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [spinning, setSpinning] = useState(false)

  useOverlay('menu', searchOpen, () => setSearchOpen(false))
  useOverlay('menu', filterOpen, () => setFilterOpen(false))
  useOverlay('menu', viewOpen, () => setViewOpen(false))
  useOverlay('menu', moreOpen, () => setMoreOpen(false))

  const rescan = () => {
    setSpinning(true)
    api('/api/devices/rescan', ReconcileReportSchema, { method: 'POST' }).finally(() => {
      setTimeout(() => setSpinning(false), RESCAN_SPIN_MS)
    })
  }

  /*
   * Two questions, kept apart (CEO, 2026-09-04): "can this device be reached"
   * and "who is using it". They used to be mixed into one list, so `Free` sat
   * beside `Disconnected` as if they answered the same thing — and the
   * connection half had no `Connected` row at all, only its negative.
   * `deviceState()` derives the activity half; `status` IS the connection
   * half, which is exactly what spec §4 shrank it to.
   */
  const filterRows: Array<{ id: DevicesFilter; label: string; dot: ReturnType<typeof dotStateOf> | null; count: number; group?: string }> = [
    { id: 'all', label: 'All', dot: null, count: devices.length },
    { id: 'online', label: 'Connected', dot: 'free', count: devices.filter((d) => d.status === 'online').length, group: 'Connection' },
    { id: 'connecting', label: 'Connecting', dot: null, count: devices.filter((d) => reconnectingAttempt(d) !== null).length, group: 'Connection' },
    { id: 'offline', label: 'Disconnected', dot: 'offline', count: devices.filter((d) => d.status === 'offline').length, group: 'Connection' },
    { id: 'quarantined', label: 'Quarantined', dot: 'unauthorized', count: devices.filter((d) => d.status === 'quarantined').length, group: 'Connection' },
    { id: 'free', label: 'Free', dot: 'free', count: devices.filter((d) => isDeviceState(d, 'free')).length, group: 'Activity' },
    { id: 'controlled', label: 'Controlled by a user', dot: 'controlled', count: devices.filter((d) => isDeviceState(d, 'controlled')).length, group: 'Activity' },
    { id: 'job', label: 'Running a job', dot: 'job', count: devices.filter((d) => isDeviceState(d, 'job')).length, group: 'Activity' },
  ]

  return (
    <div className="flex h-[58px] flex-none items-center gap-[10px] border-b border-line px-3">
      <GroupTabs groups={groups} devices={allDevices} active={activeGroup} onSelect={onSelectGroup} onMutated={onGroupsMutated} />
      <div className="flex-1" />

      {pendingCount > 0 && (
        <button
          type="button"
          onClick={onOpenDiscovery}
          className="flex flex-none items-center gap-1.5 rounded-pill border border-border-2 bg-panel-2 px-[13px] py-[7px] text-body text-text-2 hover:bg-muted"
        >
          <TrayArrowDownIcon className="size-4" aria-hidden />
          Discovered ({pendingCount})
        </button>
      )}

      <div className="relative flex flex-none items-center gap-1">
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className={cn(ICON_BTN, searchOpen || query !== '' ? ICON_ACTIVE : ICON_IDLE)}
          aria-label="Search"
        >
          <MagnifyingGlassIcon className="size-4" aria-hidden />
        </button>
        {searchOpen && (
          <div data-menu-root="1" className="absolute top-[40px] right-0 z-30 w-[300px] rounded-card border border-border bg-panel p-3 shadow-popover">
            <Input
              variant="search"
              autoFocus
              placeholder="serial, label, model, task"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between text-meta text-faint">
              <span>{`${matchCount} match${matchCount === 1 ? '' : 'es'}`}</span>
              <button type="button" className="text-accent" onClick={() => onQueryChange('')}>
                Clear
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="relative flex flex-none items-center">
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          className={cn(ICON_BTN, filterOpen || filter !== 'all' ? ICON_ACTIVE : ICON_IDLE)}
          aria-label="Filter"
        >
          <FunnelIcon className="size-4" aria-hidden />
        </button>
        {filterOpen && (
          <div data-menu-root="1" className="absolute top-[40px] right-0 z-30 w-[216px] rounded-card border border-border bg-panel p-1 shadow-popover">
            {filterRows.map((row, i) => (
              <div key={row.id} className="contents">
                {/* One heading per run of rows sharing a `group`, so the two
                    questions read as two lists rather than one long one. */}
                {row.group && row.group !== filterRows[i - 1]?.group && (
                  <p className="px-[10px] pt-2 pb-1 text-label text-faint-2 uppercase tracking-[.5px]">{row.group}</p>
                )}
              <button
                type="button"
                className={ROW}
                onClick={() => {
                  onFilterChange(row.id)
                  setFilterOpen(false)
                }}
              >
                {row.dot ? <StatusDot state={row.dot} /> : <span className="size-2" />}
                <span className="flex-1 text-left">{row.label}</span>
                <span className="text-label text-faint">{row.count}</span>
                {filter === row.id && <CheckIcon className="size-3.5 text-accent" aria-hidden />}
              </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex flex-none items-center">
        <button
          type="button"
          onClick={() => setViewOpen((v) => !v)}
          className={cn(ICON_BTN, viewOpen ? ICON_ACTIVE : ICON_IDLE)}
          aria-label="View"
        >
          {view === 'table' ? <RowsIcon className="size-4" aria-hidden /> : <SquaresFourIcon className="size-4" aria-hidden />}
        </button>
        {viewOpen && (
          <div data-menu-root="1" className="absolute top-[40px] right-0 z-30 w-[200px] rounded-card border border-border bg-panel p-1 shadow-popover">
            {(['table', 'screens'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={ROW}
                onClick={() => {
                  onViewChange(v)
                  setViewOpen(false)
                }}
              >
                <span className="flex-1 text-left capitalize">{v}</span>
                {view === v && <CheckIcon className="size-3.5 text-accent" aria-hidden />}
              </button>
            ))}
            {view === 'screens' && (
              <div className="mt-1 border-t border-line px-[10px] py-2">
                <div className="flex items-center justify-between text-meta text-faint">
                  <span>Card width</span>
                  <span className="font-mono">{CARD_WIDTH_PX[cardWidth]}</span>
                </div>
                <div className="mt-1.5 flex gap-1">
                  {(Object.keys(CARD_WIDTH_PX) as CardWidth[]).map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => onCardWidthChange(w)}
                      className={cn(
                        'flex-1 rounded-button py-1 text-label uppercase transition-colors',
                        w === cardWidth ? 'bg-accent-soft text-accent' : 'bg-muted text-faint hover:text-text',
                      )}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <button type="button" onClick={rescan} className={cn(ICON_BTN, ICON_IDLE)} aria-label="Rescan">
        <ArrowsClockwiseIcon className={cn('size-4', spinning && 'animate-enkaku-spin')} aria-hidden />
      </button>

      {/*
        The fleet menu (owner, 2026-09-04). The four icons to the left are all
        ways of LOOKING at the farm — search it, filter it, lay it out, re-read
        it. These two change the farm's own wiring, and they are the two an
        operator standing at a rack reaches for: they were previously buried in
        Settings (the network list) or mounted nowhere at all (the cutover
        wizard). Two rows, not a submenu: a third would mean this menu had
        become the overflow drawer every toolbar eventually grows.
      */}
      <div className="relative flex flex-none items-center">
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className={cn(ICON_BTN, moreOpen ? ICON_ACTIVE : ICON_IDLE)}
          aria-label="More"
        >
          <DotsThreeIcon className="size-4" aria-hidden />
        </button>
        {moreOpen && (
          <div data-menu-root="1" className="absolute top-[40px] right-0 z-30 w-[248px] rounded-card border border-border bg-panel p-1 shadow-popover">
            <button
              type="button"
              className={ROW}
              onClick={() => {
                setMoreOpen(false)
                onOpenOtg()
              }}
            >
              <ArrowsLeftRightIcon className="size-4 text-faint" aria-hidden />
              <span className="flex-1 text-left">Switch to OTG…</span>
            </button>
            <button
              type="button"
              className={ROW}
              onClick={() => {
                setMoreOpen(false)
                onOpenScan()
              }}
            >
              <MagnifyingGlassIcon className="size-4 text-faint" aria-hidden />
              <span className="flex-1 text-left">Scan networks…</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
