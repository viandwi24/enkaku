'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { DeviceControl } from './DeviceControl'
import { useActionDialogs } from '@/components/actions/ActionDialogHost'
import { isPipFrame } from '@/components/shell/pip-frame'
import { ws } from '@/lib/ws'

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
    open: (deviceId, selectedIds) => {
      /**
       * Before the window exists, not after (owner, 2026-09-16).
       *
       * Device Control opens on the always-on WALL stream — small and soft —
       * while the `control` encoder builds behind it (plan 206), and the
       * encoder's build used to be triggered by the viewer's own
       * `stream.start`. So the build could not even begin until this window
       * had mounted, fetched the device, built a decoder and made a WS round
       * trip. Every one of those now runs WHILE the encoder builds.
       *
       * This is the one gesture that opens the window — the action registry's
       * "Open Device Control", the double-click on a tile or a row, the
       * context menu and the bulk pill all route here — so it is also the
       * only place this message is sent. Never on hover, never per wall tile:
       * a control encoder is a second scrcpy process on a phone.
       *
       * Fire-and-forget on purpose: `ws.send` queues and connects when the
       * socket is not up yet, the server ignores it for a device that cannot
       * use it, and a lost prewarm costs nothing — `stream.start` still
       * starts the encoder exactly as it always did. Only the HOST is
       * prepared; the mirror members are acted on, not cast.
       */
      ws.send({ type: 'stream.prepare', payload: { deviceId } })
      setCurrent({ deviceId, selectedIds: selectedIds ?? [deviceId] })
    },
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

  /**
   * No `key={request.deviceId}` here, deliberately.
   *
   * It used to be there, and it made every host change a full unmount and
   * remount: the WebSocket dropped, the H.264 decoder was destroyed and
   * rebuilt, and the picture went black for as long as a cold open — so
   * double-clicking another phone to move the window read as the click not
   * working (owner, 2026-09-06). Nothing needed the remount: `useCast`'s
   * stream effect is keyed on `deviceId` and already stops the old stream
   * and starts the next one, and `DeviceControl` clears its own two
   * device-scoped values when `deviceId` changes.
   */
  return (
    <DeviceControl
      deviceId={request.deviceId}
      selectedIds={request.selectedIds}
      onClose={() => setCurrent(null)}
      onAction={(id, params) => openActionDialog(id, { deviceIds: [request.deviceId] }, params)}
    />
  )
}
