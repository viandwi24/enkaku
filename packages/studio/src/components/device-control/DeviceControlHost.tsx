'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { DeviceControl } from './DeviceControl'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'
import { isPipFrame } from '@/components/shell/pip-frame'

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

/**
 * Mounted directly by `RootLayout`, outside `AuthGate`'s own `<Suspense>`
 * boundary — so this component wraps its OWN `useSearchParams()` read in one,
 * exactly like `app/settings/page.tsx` and `app/scripts/page.tsx` already do,
 * which a static export needs before it will prerender a `useSearchParams()`
 * caller at all.
 */
export function DeviceControlHost(): React.JSX.Element | null {
  return (
    <Suspense fallback={null}>
      <DeviceControlHostInner />
    </Suspense>
  )
}

function DeviceControlHostInner(): React.JSX.Element | null {
  const [request, setRequest] = useState<OpenRequest | null>(current)
  const { open: openActionDialog } = useActionDialogs()
  const searchParams = useSearchParams()

  useEffect(() => {
    const listener: Listener = (next) => setRequest(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  // Never a second cast inside a picture-in-picture panel's own framed
  // document (plan 500 §3.7, G8): that would double the encode load of
  // whatever device the OUTER window already has under control, for a
  // picture the operator already has.
  if (isPipFrame(searchParams)) return null

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
