'use client'

import { useEffect, useState } from 'react'
import { DevicePreparationSchema, type DevicePreparation, type PreparationComponentStatus } from '@enkaku/protocol'
import { api } from '@enkaku/ui'
import { ws } from './ws'

/**
 * Live `devices.preparation`, shared by the device popup's screen-panel
 * overlay and `PreparationPanel.tsx` (plan 106 §5 step 106.7) — the owner's
 * own ask: *"pas device awal ditambahkan atau gimana itu ada state preparing
 * device... jadi kalau ada proses install apk yang error atau gagal ini bisa
 * di lihat"* now extends to "while it is still running", not only once it
 * settles.
 *
 * **Why this polls at all, stated so nobody "fixes" it into a bare
 * `ws.on()` subscription**: `GET /:id/preparation` (`api/device-preparation.ts`)
 * overlays `state: 'provisioning'` onto a component whose `run()` call is
 * genuinely executing right now (`runner.ts`/`agent-provisioner.ts`'s own
 * `runningSince`, plan 106 §5 step 106.7) — but that fact is deliberately
 * IN-MEMORY ONLY, never written to `devices.preparation` and never routed
 * through `device.preparation`'s transition-event contract (see
 * `runner.ts`'s `runningSince` doc comment for why: reverting a persisted
 * intermediate state on a deferred pass, or a core crash mid-install, is
 * exactly the hazard that design avoids). So there is no event for a pass
 * STARTING — only for one FINISHING (`device.preparation`/`device.agent`,
 * `MAIN_EVENT_KINDS`, `@enkaku/protocol`). This hook is honest about that
 * split: it polls at a stated interval to catch a start (including one
 * triggered server-side by admission/reconnect, which this client never
 * requested), and additionally refetches immediately on the real
 * completion event so the UI does not sit on a stale row for a whole poll
 * interval after a pass actually settles.
 *
 * Two independent call sites (the screen panel, `PreparationPanel`) may
 * both mount this hook for the same device at once — while a popup is open
 * AND its Settings › Preparation section is open. That is at most 2×
 * `GET /:id/preparation` for the ONE device the popup is already open on
 * (`docs/design.md`'s "nothing that scales with device count" — this is
 * exactly the bounded case that rule allows, not the per-tile fan-out it
 * forbids), so no shared cache was built for what is a small, accepted
 * duplication.
 */
const POLL_MS = 3000

export function usePreparation(deviceId: string): {
  preparation: DevicePreparation | null
  loadError: string | null
  reload: () => void
  /** Optimistic local patch — a Retry action already gets that ONE component's fresh status back in its own response; applying it here shows the result the instant the mutation resolves, instead of waiting for the next poll tick or a `device.preparation` event. The next poll or event still re-syncs from the server as usual. */
  patch: (componentId: string, status: PreparationComponentStatus) => void
  /** Same idea as `patch`, for an action that returns the WHOLE record at once (the on-demand whole-device pass, `POST /:id/preparation`). */
  replace: (next: DevicePreparation) => void
} {
  const [preparation, setPreparation] = useState<DevicePreparation | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = (): void => {
    api(`/api/devices/${deviceId}/preparation`, DevicePreparationSchema)
      .then((p) => {
        setPreparation(p)
        setLoadError(null)
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    setPreparation(null)
    setLoadError(null)
    load()
    const id = setInterval(load, POLL_MS)
    const off = ws.on((msg) => {
      if (msg.type !== 'device.event' || msg.payload.deviceId !== deviceId) return
      if (msg.payload.kind === 'device.preparation' || msg.payload.kind === 'device.agent') load()
    })
    return () => {
      clearInterval(id)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  const patch = (componentId: string, status: PreparationComponentStatus): void => {
    setPreparation((prev) => ({ ...(prev ?? {}), [componentId]: status }))
  }

  return { preparation, loadError, reload: load, patch, replace: setPreparation }
}
