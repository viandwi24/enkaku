'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { NotificationSchema, NotificationsResponseSchema, RunResponseSchema, ThreadResponseSchema, type Notification } from '@enkaku/protocol'
import { BellIcon, Popover, PopoverContent, PopoverTrigger, cn, relativeTime, api } from '@enkaku/ui'
import { ws } from '@/lib/ws'

// `POST /api/notifications/:id/read` and `/read-all` (`packages/core/src/api/notifications.ts`)
// have no shared envelope in `@enkaku/protocol` — nothing else reads either
// shape, so they are declared locally rather than added there for one component.
const MarkReadResponseSchema = z.object({ notification: NotificationSchema })
const MarkAllReadResponseSchema = z.object({ count: z.number() })

/**
 * The status bar's Alerts button (plan 213 §4.7, §5 step 213.6), re-skinned
 * in place from the old sidebar's bell: a 32×32 `rounded-button` trigger with
 * a `BellIcon`, and — per the handoff — a plain 6px `var(--danger)` dot when
 * there is anything unread, with no count on it. The count is not lost: it
 * moves into the trigger's `aria-label`/`title`, where a hover or a screen
 * reader still gets it (the old `9+` badge is gone).
 */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const load = useCallback(async () => {
    try {
      const res = await api('/api/notifications?limit=20', NotificationsResponseSchema)
      setItems(res.items)
      setUnreadCount(res.unreadCount)
    } catch {
      // The bell must not take the page down when the core is unreachable.
    }
  }, [])

  useEffect(() => {
    void load()
    // Live, not polled (plan 68 §4.5) — `notification.created` is broadcast the instant any
    // notification is written, in-app or system-generated.
    return ws.on((m) => {
      if (m.type === 'notification.created') void load()
    })
  }, [load])

  const goToNotification = async (n: Notification) => {
    setOpen(false)
    if (!n.readAt) {
      try {
        await api(`/api/notifications/${n.id}/read`, MarkReadResponseSchema, { method: 'POST' })
        void load()
      } catch {
        // Non-fatal — the notification still navigates even if marking read failed.
      }
    }
    const ctx = n.context
    if (!ctx) return
    try {
      let threadId = ctx.threadId ?? null
      let agentId = ctx.agentId ?? null
      if (!threadId && ctx.runId) {
        const { run } = await api(`/api/v1/runs/${ctx.runId}`, RunResponseSchema)
        threadId = run.threadId
      }
      if (threadId && !agentId) {
        const { thread } = await api(`/api/v1/threads/${threadId}`, ThreadResponseSchema)
        agentId = thread.agentId
      }
      if (threadId && agentId) router.push(`/agents/detail?id=${agentId}&thread=${threadId}`)
    } catch {
      // No run/thread to link to (a schedule-level refusal names only `scheduleId`) — the
      // notification is still readable in the list; there is simply nowhere further to go yet.
    }
  }

  const markAllRead = async () => {
    try {
      await api('/api/notifications/read-all', MarkAllReadResponseSchema, { method: 'POST' })
      void load()
    } catch {
      // Non-fatal.
    }
  }

  const label = unreadCount > 0 ? `Alerts, ${unreadCount} unread` : 'Alerts'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="relative flex size-8 items-center justify-center rounded-button text-faint transition-colors hover:bg-muted-2 hover:text-text"
      >
        <BellIcon className="size-4" aria-hidden />
        {unreadCount > 0 && (
          <span aria-hidden className="absolute top-[5px] right-[5px] size-[6px] rounded-pill bg-danger" />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <p className="text-row font-medium">Notifications</p>
          {unreadCount > 0 && (
            <button type="button" onClick={() => void markAllRead()} className="text-meta text-faint hover:text-text">
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-body text-faint">No notifications yet.</p>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void goToNotification(n)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-muted',
                  !n.readAt && 'bg-muted-2',
                )}
              >
                <div className="flex w-full items-center gap-1.5">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      n.level === 'error' ? 'bg-danger' : n.level === 'warn' ? 'bg-warn' : 'bg-ok',
                    )}
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-body font-medium">{n.title}</span>
                  <span className="shrink-0 font-mono text-badge text-faint-2">{relativeTime(n.createdAt)}</span>
                </div>
                {n.body && <p className="line-clamp-2 pl-3 text-meta text-faint">{n.body}</p>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
