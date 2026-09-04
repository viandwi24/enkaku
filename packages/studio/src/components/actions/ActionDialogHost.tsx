'use client'

import { useEffect, useState } from 'react'
import { GroupInfoSchema, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import { applyActivityEvent } from '@/lib/activity'
import { fetchAllPages, fetchDevices } from '@/lib/api'
import { ws } from '@/lib/ws'
import type { TargetContext } from '@/components/target/useTarget'
import { ActionDialog } from './ActionDialog'
import { VERB_DIALOGS, type ActionDialogVerb } from './verb-dialogs'

export type { ActionDialogVerb } from './verb-dialogs'

interface OpenRequest {
  verb: ActionDialogVerb
  ctx: TargetContext
  prefill?: Record<string, unknown>
}

type Listener = (req: OpenRequest | null) => void

/**
 * A module-level store, the same shape as `lib/overlays.ts`'s registry (§4.9):
 * one value, one subscriber list, no React context needed above `AppShell`.
 */
let current: OpenRequest | null = null
const listeners = new Set<Listener>()

function setCurrent(next: OpenRequest | null): void {
  current = next
  for (const l of listeners) l(next)
}

export interface ActionDialogApi {
  /** Opens the dialog for `verb` with the target pre-filled. `prefill` seeds the verb's own draft (a script id, a package name). */
  open: (verb: ActionDialogVerb, ctx: TargetContext, prefill?: Record<string, unknown>) => void
}

/**
 * Opens the dialog for `verb` with the target pre-filled — no provider
 * needed, exactly like `useOverlay`/`hasOverlay` (`lib/overlays.ts`).
 */
export function useActionDialogs(): ActionDialogApi {
  return {
    open: (verb, ctx, prefill) => setCurrent({ verb, ctx, prefill }),
  }
}

/**
 * Mounted ONCE, by the root layout, beside the `Toaster` (§4.9). Every
 * screen opens a dialog through `useActionDialogs()`; this renders at most
 * one `<ActionDialog>` — opening a second verb replaces the first, which is
 * what "no dialog opens another dialog" means in practice (G7).
 */
export function ActionDialogHost(): React.JSX.Element | null {
  const [request, setRequest] = useState<OpenRequest | null>(current)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [groups, setGroups] = useState<GroupInfo[]>([])

  useEffect(() => {
    const listener: Listener = (next) => setRequest(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (!request) return
    let cancelled = false
    void fetchDevices()
      .then((rows) => {
        if (!cancelled) setDevices(rows)
      })
      .catch(() => undefined)
    void fetchAllPages('/api/groups', undefined, GroupInfoSchema)
      .then((rows) => {
        if (!cancelled) setGroups(rows)
      })
      .catch(() => undefined)

    const off = ws.on((msg) => {
      switch (msg.type) {
        case 'device.added':
          setDevices((prev) => [...prev.filter((d) => d.id !== msg.payload.id), msg.payload])
          break
        case 'device.removed':
          setDevices((prev) => prev.filter((d) => d.id !== msg.payload.id))
          break
        case 'device.status':
          setDevices((prev) => prev.map((d) => (d.id === msg.payload.id ? { ...d, status: msg.payload.status } : d)))
          break
        case 'device.activity':
          setDevices((prev) => prev.map((d) => (d.id === msg.payload.deviceId ? applyActivityEvent(d, msg.payload) : d)))
          break
        default:
          break
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [request])

  if (!request) return null

  const spec = VERB_DIALOGS[request.verb]
  return (
    <ActionDialog
      key={request.verb}
      spec={spec}
      ctx={request.ctx}
      prefill={request.prefill}
      devices={devices}
      groups={groups}
      onClose={() => setCurrent(null)}
    />
  )
}
