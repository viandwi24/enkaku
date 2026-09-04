'use client'

import { useEffect, useState } from 'react'
import { DeviceControl } from './DeviceControl'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'

/**
 * Device Control, mounted ONCE by the root layout.
 *
 * It used to live inside the Devices screen, driven by that screen's `?focus=`
 * parameter, so navigating to Jobs or Scripts unmounted the window, dropped
 * the WebSocket and stopped the cast. The CEO asked for it to survive
 * navigation on 2026-09-04: a farm operator watches one phone while reading
 * that phone's job history, and losing the picture to open the page about it
 * is the wrong trade.
 *
 * The store below is the same module-level pattern `ActionDialogHost` and
 * `lib/overlays.ts` already use — one value, one subscriber list, no React
 * context above `AppShell`. A context would force every page under the shell
 * to re-render whenever the focused device changed, which is precisely what
 * this window is trying to avoid doing to the rest of the app.
 */

interface OpenRequest {
  deviceId: string
  /** Mirror members, from the screen that opened it. Empty from anywhere else. */
  selectedIds: readonly string[]
}

type Listener = (req: OpenRequest | null) => void

let current: OpenRequest | null = null
const listeners = new Set<Listener>()

function setCurrent(next: OpenRequest | null): void {
  current = next
  for (const l of listeners) l(next)
}

export interface DeviceControlApi {
  /** Opens (or retargets) the window. `selectedIds` carries the mirror set; pass just the device to control one. */
  open: (deviceId: string, selectedIds?: readonly string[]) => void
  close: () => void
}

export function useDeviceControl(): DeviceControlApi {
  return {
    open: (deviceId, selectedIds) => setCurrent({ deviceId, selectedIds: selectedIds ?? [deviceId] }),
    close: () => setCurrent(null),
  }
}

/** The id currently under control, for a screen that wants to mark its own row. Null when the window is closed. */
export function useFocusedDeviceId(): string | null {
  const [req, setReq] = useState<OpenRequest | null>(current)
  useEffect(() => {
    const listener: Listener = (next) => setReq(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return req?.deviceId ?? null
}

export function DeviceControlHost(): React.JSX.Element | null {
  const [request, setRequest] = useState<OpenRequest | null>(current)
  const { open: openActionDialog } = useActionDialogs()

  useEffect(() => {
    const listener: Listener = (next) => setRequest(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  if (!request) return null

  return (
    <DeviceControl
      key={request.deviceId}
      deviceId={request.deviceId}
      selectedIds={request.selectedIds}
      onClose={() => setCurrent(null)}
      onAction={(id, params) => openActionDialog(id, { deviceIds: [request.deviceId] }, params)}
    />
  )
}
