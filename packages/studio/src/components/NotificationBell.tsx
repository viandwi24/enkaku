'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell } from 'lucide-react'
import { z } from 'zod'
import { NotificationSchema, NotificationsResponseSchema, RunResponseSchema, ThreadResponseSchema, type Notification } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { relativeTime } from '@/lib/format'
import { api } from '@/lib/actions'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

// `POST /api/notifications/:id/read` and `/read-all` (`packages/core/src/api/notifications.ts`)
// have no shared envelope in `@enkaku/protocol` — nothing else reads either
// shape, so they are declared locally rather than added there for one component.
const MarkReadResponseSchema = z.object({ notification: NotificationSchema })
const MarkAllReadResponseSchema = z.object({ count: z.number() })

/**
 * The Studio minimum for plan 68 §4.5: "a bell in the app shell shows
 * unread notifications and links to the run that produced each." The
 * fuller notification interface (filtering, a dedicated page, richer
 * context) is Plan 69's job — this is deliberately just a bell and a list.
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <span className="readout absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-led-danger text-[9px] text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-[13px] font-medium">Notifications</p>
          {unreadCount > 0 && (
            <button type="button" onClick={() => void markAllRead()} className="text-[11.5px] text-fg-muted hover:text-fg">
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-fg-muted">No notifications yet.</p>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void goToNotification(n)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-surface-2/60',
                  !n.readAt && 'bg-surface-2/30',
                )}
              >
                <div className="flex w-full items-center gap-1.5">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      n.level === 'error' ? 'bg-led-danger' : n.level === 'warn' ? 'bg-led-warn' : 'bg-led-ok',
                    )}
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-[12.5px] font-medium">{n.title}</span>
                  <span className="readout shrink-0 text-[10.5px] text-fg-subtle">{relativeTime(n.createdAt)}</span>
                </div>
                {n.body && <p className="line-clamp-2 pl-3 text-[11.5px] text-fg-muted">{n.body}</p>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
