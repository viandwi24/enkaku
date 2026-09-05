'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { runAction, groupResults } from '@/lib/actions'
import { GroupInfoSchema, type DeviceInfo, type GroupInfo } from '@enkaku/protocol'
import { applyActivityEvent } from '@/lib/activity'
import { trackOperation } from '@/lib/operations'
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
    /**
     * A verb marked `immediate` runs here instead of opening anything.
     *
     * Handled in `open` rather than at each call site so every entry point —
     * the bulk menu, Device Control's Actions tab, a plugin's own button —
     * gets it without knowing the rule exists. A modal whose only content is
     * one sentence and a button repeating the menu item just clicked is two
     * clicks for one act, and the target was already chosen by the selection
     * the menu opened from (CEO, 2026-09-05).
     */
    open: (verb, ctx, prefill) => {
      if (!VERB_DIALOGS[verb]?.immediate) {
        setCurrent({ verb, ctx, prefill })
        return
      }
      const count = (ctx.deviceIds ?? []).length
      const label = VERB_DIALOGS[verb].submitLabel(count)
      void runAction(verb, ctx as never, (prefill ?? {}) as never)
        .then((res: Awaited<ReturnType<typeof runAction>>) => {
          // Some of these finish before the request returns (wake, sleep,
          // reconnect) and some take minutes on twenty phones (installing the
          // guest agent). The difference is not a property of the verb we have
          // to keep a list of — it is `accepted` in the answer, meaning the
          // core went away to do it. Those go to the tray in the corner, which
          // is the whole point of running them without a modal: no window in
          // the way, and still somewhere to watch (CEO, 2026-09-05).
          if (res.results.some((r) => r.status === 'accepted')) {
            trackOperation({ id: res.operationId, verb, title: VERB_DIALOGS[verb].title(count), results: res.results, visible: true })
            return
          }
          const grouped = groupResults(res.results)
          const failed = grouped.failed.length + grouped.forbidden.length
          if (failed > 0) toast.warning(`${label}: ${grouped.done.length} done, ${failed} refused`)
          else toast.success(`${label}: done`)
        })
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
    },
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
