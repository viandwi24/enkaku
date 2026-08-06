'use client'

import Link from 'next/link'
import type { AgentThread } from '@enkaku/protocol'
import { LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The left column (plan 69 §3.1) — every thread for this agent, plus "New
 * chat". The active thread is a query param, matching the rest of Studio's
 * static-export routing (`?thread=`), and every entry is a `next/link`
 * (never a plain `<a>`) so switching threads never remounts the page and
 * kills the WS connection (criterion 12).
 */
export function ThreadList({
  agentId,
  threads,
  activeThreadId,
  onNewThread,
  newThreadPending,
}: {
  agentId: string
  threads: AgentThread[] | null
  activeThreadId: string | null
  onNewThread(): void
  newThreadPending: boolean
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r">
      <div className="p-2">
        <Button variant="secondary" size="sm" className="w-full" disabled={newThreadPending} onClick={onNewThread}>
          New chat
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {threads === null ? (
          <div className="px-2">
            <LoadingRows rows={3} />
          </div>
        ) : threads.length === 0 ? (
          <p className="px-3 py-4 text-[12px] text-fg-subtle">No conversations yet.</p>
        ) : (
          <ul className="px-1 pb-2">
            {threads.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/agents/detail?id=${agentId}&thread=${t.id}`}
                  className={cn('block truncate rounded px-2 py-1.5 text-[12.5px] hover:bg-surface', t.id === activeThreadId && 'bg-surface font-medium')}
                >
                  {t.title ?? `Thread ${t.id.slice(0, 8)}`}
                  <span className="ml-1.5 text-[10.5px] text-fg-subtle">{relativeTime(t.updatedAt)}</span>
                  {t.origin !== 'chat' && <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-fg-subtle">{t.origin}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
