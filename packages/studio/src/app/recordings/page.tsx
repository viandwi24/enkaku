'use client'

import { useRef } from 'react'
import Link from 'next/link'
import { Film } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableCell, TableHead } from '@/components/ui/table'
import { useAction } from '@/lib/actions'
import { relativeTime } from '@/lib/format'
import { deleteRecording, listRecordings, type RecordingListItem } from '@/components/recording/recording-api'

/**
 * `/recordings` — the recorder's own list (plan 94 §4.10, §5 step 94.5).
 * `GET /api/recordings` replies with a plain `{ items }`, not the keyset
 * envelope every other list endpoint uses (a recording's own count is small
 * — one workspace file per recording, no pagination is warranted) — wrapped
 * into `PaginatedTable`'s `Page<T>` shape below purely to reuse its loading/
 * error/empty states, not because this list actually paginates.
 */

export default function RecordingsPage() {
  const tableRef = useRef<PaginatedTableHandle<RecordingListItem>>(null)
  const { run, isPending } = useAction()

  const fetchPage = async (): Promise<Page<RecordingListItem>> => {
    const { items } = await listRecordings()
    return { items, nextCursor: null, total: items.length }
  }

  const remove = (r: RecordingListItem) =>
    run(`del-${r.slug}`, () => deleteRecording(r.slug), {
      success: `${r.name} deleted`,
      failure: 'Could not delete the recording',
      onSuccess: () => tableRef.current?.reload(),
    })

  return (
    <>
      <PageHeader title="Recordings" description="Macros captured from the device screen — review, promote a selector, publish as an ordinary script" />

      <div className="space-y-4 px-5 py-4">
        <PaginatedTable<RecordingListItem>
          ref={tableRef}
          fetchPage={fetchPage}
          rowKey={(r) => r.slug}
          sort={(list) => [...list].sort((a, b) => b.recordedAt - a.recordedAt)}
          header={
            <>
              <TableHead>Name</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead>Recorded</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </>
          }
          renderRow={(r) => (
            <>
              <TableCell>
                <Link href={`/recordings/detail?slug=${encodeURIComponent(r.slug)}`} className="font-medium hover:underline">
                  {r.name}
                </Link>
                {r.description && <p className="mt-0.5 truncate text-[11px] text-fg-muted">{r.description}</p>}
              </TableCell>
              <TableCell className="readout text-[12px] text-fg-muted">{r.corrupt ? '—' : r.stepCount}</TableCell>
              <TableCell className="text-[12px] text-fg-muted">{r.recordedAt ? relativeTime(r.recordedAt) : '—'}</TableCell>
              <TableCell>
                {r.corrupt ? (
                  <Badge variant="destructive">corrupt</Badge>
                ) : r.detached ? (
                  <Badge variant="outline">detached</Badge>
                ) : r.publishedVersion ? (
                  <Badge variant="secondary">published {r.publishedVersion}</Badge>
                ) : (
                  <Badge variant="outline">not published</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/recordings/detail?slug=${encodeURIComponent(r.slug)}`}>Review</Link>
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button variant="outline" size="sm" disabled={isPending(`del-${r.slug}`)}>
                        Delete
                      </Button>
                    }
                    title={`Delete ${r.name}?`}
                    description="This removes the recording document and its compiled entry from the workspace. Already-published script versions are not affected."
                    onConfirm={() => remove(r)}
                  />
                </div>
              </TableCell>
            </>
          )}
          empty={{
            icon: <Film className="size-4" aria-hidden />,
            title: 'No recordings yet',
            description: 'Open a device, switch the screen to Record, and start recording — a finished recording lands here once it is saved.',
          }}
        />
      </div>
    </>
  )
}
