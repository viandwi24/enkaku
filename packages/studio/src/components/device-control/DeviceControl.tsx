'use client'

import { useEffect, useRef, useState } from 'react'
import type { DeviceDetail } from '@enkaku/protocol'
import { api, BroadcastIcon, Button, StatusDot, Tabs, TabsContent, TabsList, TabsTrigger, XIcon } from '@enkaku/ui'
import { DeviceDetailResponseSchema } from '@enkaku/protocol'
import { readLocalPrefs } from '@/lib/prefs'
import { useOverlay } from '@/lib/overlays'
import { dotStateOf } from '@/components/devices/device-state'
import type { GenericActionId } from '@/lib/generic-actions'
import { DEFAULT_RATIO, windowWidthPx } from './geometry'
import { useCast } from './use-cast'
import { Cast } from './Cast'
import { ShortcutRail } from './ShortcutRail'
import { InfoPopover } from './InfoPopover'
import { DeviceActions } from './DeviceActions'
import { Inspector } from './Inspector'
import { DeviceTab } from './DeviceTab'
import { stateTooltip } from './state-tooltip'

/**
 * Device Control (MVP 08, design handoff README.md:230-293; plan 215).
 *
 * Deliberately not a dialog overlay: no backdrop, no focus trap, no ARIA
 * dialog role, and the screen underneath stays live and interactive.
 * Escape is registered through the shell's tiered listener
 * (`lib/overlays.ts`), so a popover inside the window closes before the
 * window does, and the cast's own `preventDefault()`/`stopPropagation()` is
 * what makes Escape mean Back while the picture has the keyboard (plan 215
 * §3.2 D2, D4).
 */
export function DeviceControl({
  deviceId,
  selectedIds,
  onClose,
  onAction,
}: {
  deviceId: string
  /** The Devices screen's selection. The host is `deviceId`; the rest are mirror members (§4.12). */
  selectedIds: readonly string[]
  onClose: () => void
  /** Plan 216 wires the dialogs; until then the Devices screen's own bulk handler runs. */
  onAction: (id: GenericActionId, params?: Record<string, unknown>) => void
}) {
  const [device, setDevice] = useState<DeviceDetail | null>(null)
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const dragStart = useRef({ mx: 0, my: 0 })
  const [tab, setTab] = useState<'actions' | 'inspector' | 'device'>('actions')

  useEffect(() => {
    let cancelled = false
    void api(`/api/devices/${encodeURIComponent(deviceId)}`, DeviceDetailResponseSchema)
      .then((res) => {
        if (!cancelled) setDevice(res.device)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [deviceId])

  const targets = [deviceId, ...selectedIds.filter((id) => id !== deviceId)]

  const cast = useCast({
    deviceId,
    quality: 'control',
    interactive: true,
    targets,
    latencyOverlay: readLocalPrefs().latencyOverlay,
    onRotate: () => void cycleRotation(),
  })

  async function cycleRotation() {
    if (!device) return
    const base = (device.settings ?? {}) as { prep?: { rotation?: string } }
    const order = ['lock-portrait', 'lock-landscape', 'device'] as const
    const current = base.prep?.rotation ?? 'device'
    const next = order[(order.indexOf(current as (typeof order)[number]) + 1) % order.length]
    const nextSettings = { ...base, prep: { ...base.prep, rotation: next } }
    await api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema, { method: 'PATCH', json: { settings: nextSettings } }).catch(() => {})
  }

  const close = () => {
    setDrag({ x: 0, y: 0 })
    onClose()
  }
  useOverlay('window', true, close)

  function startDrag(e: React.MouseEvent) {
    dragStart.current = { mx: e.clientX - drag.x, my: e.clientY - drag.y }
    function onMove(ev: MouseEvent) {
      setDrag({ x: ev.clientX - dragStart.current.mx, y: ev.clientY - dragStart.current.my })
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const ratio = cast.stats.width > 0 ? cast.stats.width / cast.stats.height : DEFAULT_RATIO
  const width = windowWidthPx(ratio)
  const nodeOwned = device?.nodeId !== null && device?.nodeId !== undefined

  return (
    <div
      className="fixed left-1/2 top-1/2 z-50 flex h-[calc(100vh-48px)] max-h-[640px] overflow-hidden rounded-window border border-border-2 bg-panel shadow-window"
      style={{ width, maxWidth: 'calc(100vw - 24px)', transform: `translate(calc(-50% + ${drag.x}px), calc(-50% + ${drag.y}px))` }}
    >
      <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 bg-panel-2 py-2">
        <ShortcutRail deviceId={deviceId} sendKey={cast.sendKey} onRotate={() => void cycleRotation()} />
      </div>

      <Cast cast={cast} ratio={ratio} latencyOverlay={readLocalPrefs().latencyOverlay ?? false} onStartDrag={startDrag} />

      <div className="flex w-[274px] shrink-0 flex-col overflow-y-auto border-l border-line">
        <div className="flex h-11 shrink-0 cursor-grab items-center gap-2 border-b border-line px-3" onMouseDown={startDrag} data-drag-handle="1">
          {device && <StatusDot ring state={dotStateOf(device)} title={stateTooltip(device)} />}
          <span className="font-mono text-label text-faint">#{String(device?.number ?? 0).padStart(2, '0')}</span>
          <span className="truncate text-name font-semibold uppercase">{device?.label ?? deviceId}</span>
          <div className="flex-1" />
          {device && <InfoPopover device={device} onChange={() => onAction('settings')} />}
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
            <XIcon className="size-4" aria-hidden />
          </Button>
        </div>

        {device && (
          <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-meta">
            <span className={device.battery && device.battery.level < 20 ? 'font-medium text-danger' : device.battery && device.battery.level < 45 ? 'font-medium text-warn' : 'font-medium text-accent'}>
              {device.battery ? `${device.battery.level}%` : '–'}
            </span>
            <span className={device.battery && device.battery.temperatureC !== null && device.battery.temperatureC > 42 ? 'text-danger' : 'text-faint'}>
              {device.battery?.temperatureC !== null && device.battery?.temperatureC !== undefined ? `${device.battery.temperatureC}°C` : '–'}
            </span>
            <span className="text-faint">{device.androidVersion ?? '–'}</span>
          </div>
        )}

        {selectedIds.length > 1 && (
          <div className="mx-3 mt-2 flex items-center gap-2 rounded-button bg-warn-soft px-2.5 py-2 text-meta text-warn">
            <BroadcastIcon className="size-4" aria-hidden />
            <b>Host device</b>
            <span>
              Mirroring input to {selectedIds.length - 1} other selected devices · {selectedIds.length} under control
            </span>
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex min-h-0 flex-1 flex-col">
          <TabsList variant="compact" className="mx-3 mt-2">
            <TabsTrigger value="actions">Actions</TabsTrigger>
            <TabsTrigger value="inspector">Inspector</TabsTrigger>
            <TabsTrigger value="device">Device</TabsTrigger>
          </TabsList>
          <TabsContent value="actions" className="min-h-0 flex-1 overflow-y-auto">
            <DeviceActions onAction={onAction} />
          </TabsContent>
          <TabsContent value="inspector" className="min-h-0 flex-1 overflow-y-auto">
            <Inspector deviceId={deviceId} nodeOwned={nodeOwned} />
          </TabsContent>
          <TabsContent value="device" className="min-h-0 flex-1 overflow-y-auto">
            <DeviceTab deviceId={deviceId} onAction={onAction} nodeOwned={nodeOwned} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
