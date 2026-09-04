'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceDetail } from '@enkaku/protocol'
import { api, BroadcastIcon, Button, StatusDot, Tabs, TabsContent, TabsList, TabsTrigger, XIcon } from '@enkaku/ui'
import { DeviceDetailResponseSchema } from '@enkaku/protocol'
import { readLocalPrefs, writeLocalPrefs } from '@/lib/prefs'
import { useOverlay } from '@/lib/overlays'
import { dotStateOf } from '@/components/devices/device-state'
import type { GenericActionId } from '@/lib/generic-actions'
import { DEFAULT_RATIO, DEFAULT_WINDOW_HEIGHT_PX, clampWindowHeight, windowWidthPx } from './geometry'
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
  /**
   * The dragged HEIGHT, and the only size the operator sets.
   *
   * The width follows from it and the live aspect ratio, so the cast column
   * always fits: a free-form two-axis resize on a window whose middle column
   * is a phone screen can only produce a cropped picture or a band of dead
   * space beside it. Restored on 2026-09-04 after the handoff's fixed 640px
   * proved too small on a large display; persisted per browser, not per farm.
   */
  const [height, setHeight] = useState(DEFAULT_WINDOW_HEIGHT_PX)
  const resizeStart = useRef({ my: 0, h: 0 })
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

  /**
   * Stable handlers for the shortcut rail.
   *
   * This window re-renders roughly twice a second by design and always has:
   * the cast header shows a live fps and a live "no frames for Ns", both of
   * which are state that ticks (`use-cast.ts`'s `FPS_PUBLISH_MS`). Every
   * child re-rendered with it, and the rail is eleven Radix tooltip triggers
   * plus a popover — the most expensive thing in the window to rebuild, for
   * a row of buttons whose contents change only when the operator clicks
   * one. The clipboard history added to it made each rebuild bigger, which
   * is what made this visible (owner, 2026-09-05), but the re-render itself
   * predates it and has nothing to do with the clipboard.
   *
   * `React.memo` alone could not fix it: every callback here is redefined on
   * each render, so the memo would never hit. A `useCallback` chain through
   * `use-cast`'s own closures would reach a long way for it, so the rail's
   * handlers are latched in a ref instead — the wrappers below are created
   * once and always call the CURRENT function, so there is no stale-closure
   * risk of the kind a `useCallback` with a wrong dependency list creates.
   */
  const railRef = useRef({ sendKey: cast.sendKey, cycleRotation: () => {}, clear: cast.clearDeviceClipboardHistory, read: cast.readDeviceClipboard })
  railRef.current = {
    sendKey: cast.sendKey,
    cycleRotation: () => void cycleRotation(),
    clear: cast.clearDeviceClipboardHistory,
    read: cast.readDeviceClipboard,
  }
  const railSendKey = useCallback((keycode: number) => railRef.current.sendKey(keycode), [])
  const railRotate = useCallback(() => railRef.current.cycleRotation(), [])
  const railClearClipboard = useCallback(() => railRef.current.clear(), [])
  const railReadClipboard = useCallback(() => railRef.current.read(), [])

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

  // Read once on mount, and clamped to THIS viewport: a height dragged on a
  // 27-inch display must not open off-screen on a laptop.
  useEffect(() => {
    setHeight(clampWindowHeight(readLocalPrefs().deviceControlHeight, window.innerHeight))
  }, [])

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    resizeStart.current = { my: e.clientY, h: height }
    function onMove(ev: MouseEvent) {
      // Doubled: the window is centred, so its top edge rises by half of
      // whatever the bottom edge is dragged down — without this the handle
      // moves at half the speed of the cursor and feels broken.
      const next = resizeStart.current.h + (ev.clientY - resizeStart.current.my) * 2
      setHeight(clampWindowHeight(next, window.innerHeight))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setHeight((h) => {
        writeLocalPrefs({ deviceControlHeight: Math.round(h) })
        return h
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

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

  /**
   * The live stream's ratio once frames arrive; the device's own screen until
   * they do.
   *
   * This used to fall straight back to `DEFAULT_RATIO` (9:19.5), so a window
   * opened at the wrong width and visibly jumped a second later when the
   * first frame landed — the owner saw the cast "start small then suddenly
   * grow" (2026-09-04). Plan 215 §3.2 D3 is right that `screenW/screenH` must
   * not drive the LIVE ratio, because it goes stale on rotation: the moment a
   * frame exists it wins here, and rotation still resizes the window in the
   * same render as the picture. But as the opening guess it is the device's
   * actual screen rather than a guess about phones in general.
   */
  const ratio =
    cast.stats.width > 0
      ? cast.stats.width / cast.stats.height
      : device?.screenW && device?.screenH
        ? device.screenW / device.screenH
        : DEFAULT_RATIO
  const width = windowWidthPx(ratio, height)
  const nodeOwned = device?.nodeId !== null && device?.nodeId !== undefined

  return (
    <div
      className="fixed left-1/2 top-1/2 z-50 flex overflow-hidden rounded-window border border-border-2 bg-panel shadow-window"
      style={{
        width,
        height,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 48px)',
        transform: `translate(calc(-50% + ${drag.x}px), calc(-50% + ${drag.y}px))`,
      }}
    >
      <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 bg-panel-2 py-2">
        <ShortcutRail
          deviceId={deviceId}
          sendKey={railSendKey}
          onRotate={railRotate}
          clipboardHistory={cast.deviceClipboardHistory}
          onClearClipboardHistory={railClearClipboard}
          onReadClipboard={railReadClipboard}
        />
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

      {/*
        The resize grip. Bottom-right, inside the window, above the info
        column's scroll area — `nwse-resize` because the window grows in both
        axes even though only the height is dragged (the width follows the
        ratio). `aria-hidden`: there is nothing here a keyboard user can do
        that the default size does not already give them, and announcing a
        control that only responds to a drag would be a false promise.
      */}
      <div
        onMouseDown={startResize}
        aria-hidden
        className="absolute right-0 bottom-0 z-10 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 45%, var(--line) 45% 55%, transparent 55% 70%, var(--line) 70% 80%, transparent 80%)',
        }}
      />
    </div>
  )
}
