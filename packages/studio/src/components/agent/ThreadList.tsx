'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import type { AgentThread } from '@enkaku/protocol'
import { ThreadDeletePreviewResponseSchema, ThreadDeleteResponseSchema } from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LoadingRows,
  api,
  cn,
  relativeTime,
  useAction,
} from '@enkaku/ui'

/**
 * The left column (plan 69 §3.1) — every thread for this agent, plus "New
 * chat". The active thread is a query param, matching the rest of Studio's
 * static-export routing (`?thread=`), and every entry is a `next/link`
 * (never a plain `<a>`) so switching threads never remounts the page and
 * kills the WS connection (criterion 12).
 *
 * Plan 83 §3.6, §4.4 — a per-row menu adds Delete, which did not exist
 * anywhere before this plan: `api/threads.ts` had no `DELETE` route and
 * this file had no affordance for it. `onThreadDeleted` lets the parent
 * page drop the row from its own list and, if it was the active thread,
 * navigate away from a now-nonexistent one.
 */
export function ThreadList({
  agentId,
  threads,
  activeThreadId,
  onNewThread,
  newThreadPending,
  onThreadDeleted,
}: {
  agentId: string
  threads: AgentThread[] | null
  activeThreadId: string | null
  onNewThread(): void
  newThreadPending: boolean
  onThreadDeleted?(threadId: string): void
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
              <li key={t.id} className="group relative">
                <Link
                  href={`/agents/detail?id=${agentId}&thread=${t.id}`}
                  className={cn('block truncate rounded px-2 py-1.5 pr-7 text-[12.5px] hover:bg-surface', t.id === activeThreadId && 'bg-surface font-medium')}
                >
                  {t.title ?? `Thread ${t.id.slice(0, 8)}`}
                  <span className="ml-1.5 text-[10.5px] text-fg-subtle">{relativeTime(t.updatedAt)}</span>
                  {t.origin !== 'chat' && <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-fg-subtle">{t.origin}</span>}
                </Link>
                <ThreadRowMenu thread={t} onDeleted={() => onThreadDeleted?.(t.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function ThreadRowMenu({ thread, onDeleted }: { thread: AgentThread; onDeleted(): void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [counts, setCounts] = useState<{ messages: number; runs: number } | null>(null)
  const [countsError, setCountsError] = useState<string | null>(null)
  const { run: doAction } = useAction()

  const openConfirm = () => {
    setCounts(null)
    setCountsError(null)
    setConfirmOpen(true)
    void api(`/api/v1/threads/${thread.id}/delete-preview`, ThreadDeletePreviewResponseSchema)
      .then((b) => setCounts(b.counts))
      .catch((e) => setCountsError(e instanceof Error ? e.message : String(e)))
  }

  const label = thread.title ?? `thread ${thread.id.slice(0, 8)}`

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Thread actions"
            className="absolute right-1 top-1 hidden size-6 group-hover:flex data-[state=open]:flex"
            onClick={(e) => e.preventDefault()}
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Radix closes the dropdown the instant an item is selected (default `onSelect`
              behaviour, left alone here) — `openConfirm` sets INDEPENDENT `ConfirmDialog` state
              (below, a sibling of this menu, not nested inside it), which is exactly why it is
              called from `onSelect` rather than relying on `ConfirmDialog`'s own `trigger`-nested
              `AlertDialogTrigger`: nesting it INSIDE `DropdownMenuContent` would have unmounted it
              along with the closing menu before the confirm dialog ever appeared. */}
          <DropdownMenuItem variant="destructive" onSelect={openConfirm}>
            <Trash2 className="size-3.5" aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        trigger={<span className="hidden" />}
        title={`Delete ${label}?`}
        description={
          countsError ? (
            `Could not check what this thread carries — ${countsError}`
          ) : counts ? (
            // Criterion 16 — names how many messages and runs will be deleted.
            `This deletes ${counts.messages} message${counts.messages === 1 ? '' : 's'} and ${counts.runs} run${counts.runs === 1 ? '' : 's'}. This cannot be undone. Blobs (screenshots, attachments) are kept.`
          ) : (
            'Checking what this thread carries…'
          )
        }
        confirmLabel="Delete"
        onConfirm={() =>
          doAction(`delete-thread-${thread.id}`, () => api(`/api/v1/threads/${thread.id}`, ThreadDeleteResponseSchema, { method: 'DELETE' }), {
            success: 'Thread deleted',
            failure: 'Could not delete the thread — cancel any active run first',
            onSuccess: onDeleted,
          })
        }
      />
    </>
  )
}
