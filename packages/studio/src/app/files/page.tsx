'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  ConfirmDialog,
  FileIcon,
  FilmSlateIcon,
  FloppyDiskIcon,
  ImageIcon,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  TrashIcon,
  UploadSimpleIcon,
  fileSize,
  relativeTime,
  useAction,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  deleteUpload,
  familyOf,
  formatDuration,
  listUploads,
  renameUpload,
  setUploadPinned,
  uploadContentUrl,
  uploadFile,
  type FileFilter,
  type FileItem,
} from '@/components/files/files-api'

/**
 * `/files` — the media library (plan 800 wave 5).
 *
 * Shows only files an OPERATOR uploaded (`?kind=upload`). A run's screenshots
 * and a device's logs are artifacts too, and they belong on the job that
 * produced them: they are swept on a different policy, and deleting one here
 * would tear a hole in a run's own evidence.
 *
 * **No thumbnail is fetched or stored** (plan 800 wave 4). There is no ffmpeg
 * in this repo, and there does not need to be: the browser already has a
 * decoder, so an image is an `<img>` and a video is a `<video>` seeked to its
 * first tenth of a second. Storing a poster frame server-side would add a
 * dependency, a file to write, and a file for retention to sweep, to duplicate
 * what the tile below does for free.
 */

const FILTERS: { value: FileFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'other', label: 'Other' },
]

export default function FilesPage() {
  const [items, setItems] = useState<FileItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FileFilter>('all')
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const { run, pending } = useAction()
  // `useAction` exposes `isPending(key)`; this screen only needs "is anything
  // in flight", because every control here mutates the same list.
  const busy = pending !== null

  const reload = async () => {
    try {
      setItems(await listUploads())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((item) => {
      if (filter !== 'all' && familyOf(item) !== filter) return false
      if (q.length === 0) return true
      return (item.label ?? item.id).toLowerCase().includes(q)
    })
  }, [items, filter, query])

  const onPick = (file: File | undefined) => {
    if (!file) return
    void run(`upload-${file.name}`, () => uploadFile(file), {
      success: `${file.name} uploaded`,
      failure: 'Could not upload the file',
      onSuccess: () => void reload(),
    })
  }

  const commitRename = () => {
    if (!renaming) return
    const next = renaming.value.trim()
    const target = renaming
    setRenaming(null)
    if (next.length === 0) return
    void run(`rename-${target.id}`, () => renameUpload(target.id, next), {
      success: 'Renamed',
      failure: 'Could not rename the file',
      onSuccess: () => void reload(),
    })
  }

  const togglePin = (item: FileItem) =>
    run(`pin-${item.id}`, () => setUploadPinned(item.id, !item.pinned), {
      success: item.pinned ? 'Unpinned — retention can delete this again' : 'Pinned — retention will never delete this',
      failure: 'Could not change the pin',
      onSuccess: () => void reload(),
    })

  const remove = (item: FileItem) =>
    run(`del-${item.id}`, () => deleteUpload(item.id), {
      success: `${item.label ?? item.id} deleted`,
      failure: 'Could not delete the file',
      onSuccess: () => void reload(),
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Files"
        description="Videos, images and other files you uploaded — push them to a device, or use them as a script's input"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => {
                onPick(e.target.files?.[0])
                // Cleared so picking the SAME file twice in a row still fires
                // a change event — otherwise a failed upload cannot be retried
                // without choosing something else first.
                e.target.value = ''
              }}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={busy}>
              <UploadSimpleIcon className="size-4" aria-hidden />
              Upload
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as FileFilter)}>
              <TabsList>
                {FILTERS.map((f) => (
                  <TabsTrigger key={f.value} value={f.value}>
                    {f.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name"
              className="h-8 max-w-64"
              aria-label="Search files"
            />
            <span className="text-[12px] text-faint">
              {items === null ? '' : `${shown.length} of ${items.length}`}
            </span>
          </div>

          {error !== null ? (
            <p className="rounded-md border bg-panel-2/40 px-3 py-2 text-[12.5px] text-danger">{error}</p>
          ) : items === null ? (
            <p className="text-[12.5px] text-faint">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="rounded-md border bg-panel-2/40 px-3 py-6 text-center text-[12.5px] text-dim">
              {items.length === 0 ? 'Nothing uploaded yet. Upload a video or an image to get started.' : 'No file matches this filter.'}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {shown.map((item) => (
                <FileTile
                  key={item.id}
                  item={item}
                  renaming={renaming?.id === item.id ? renaming.value : null}
                  onStartRename={() => setRenaming({ id: item.id, value: item.label ?? '' })}
                  onRenameChange={(value) => setRenaming({ id: item.id, value })}
                  onRenameCommit={commitRename}
                  onRenameCancel={() => setRenaming(null)}
                  onTogglePin={() => void togglePin(item)}
                  onDelete={() => void remove(item)}
                  disabled={busy}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

    </div>
  )
}

/** One card. The preview is whatever the browser can decode; everything else is what the probe read at upload. */
function FileTile({
  item,
  renaming,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onTogglePin,
  onDelete,
  disabled,
}: {
  item: FileItem
  renaming: string | null
  onStartRename: () => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onTogglePin: () => void
  onDelete: () => void
  disabled: boolean
}) {
  const family = familyOf(item)
  const duration = formatDuration(item.durationMs)
  const name = item.label ?? item.id
  const url = uploadContentUrl(item.id)

  return (
    <li className="flex flex-col overflow-hidden rounded-lg border bg-panel">
      <div className="relative flex aspect-video items-center justify-center bg-panel-2">
        {family === 'image' ? (
          <img src={url} alt="" loading="lazy" className="size-full object-contain" />
        ) : family === 'video' ? (
          /*
           * `#t=0.1` asks the browser to seek a tenth of a second in, which is
           * what makes it paint a frame — `preload="metadata"` alone leaves
           * many browsers showing a blank element. No canvas, no stored poster.
           */
          <video src={`${url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-contain" />
        ) : (
          <FileIcon className="size-8 text-faint" aria-hidden />
        )}

        <span className="absolute left-1.5 top-1.5 rounded bg-panel/90 p-1 text-faint">
          {family === 'image' ? (
            <ImageIcon className="size-3.5" aria-hidden />
          ) : family === 'video' ? (
            <FilmSlateIcon className="size-3.5" aria-hidden />
          ) : (
            <FileIcon className="size-3.5" aria-hidden />
          )}
        </span>

        {duration !== null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-panel/90 px-1.5 py-0.5 text-[11px] tabular-nums text-dim">{duration}</span>
        )}
        {item.pinned && (
          <span className="absolute right-1.5 top-1.5 rounded bg-panel/90 p-1 text-accent" title="Pinned — retention will never delete this">
            <FloppyDiskIcon className="size-3.5" aria-hidden />
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1 p-2.5">
        {renaming !== null ? (
          <Input
            autoFocus
            value={renaming}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit()
              if (e.key === 'Escape') onRenameCancel()
            }}
            className="h-7 text-[12.5px]"
            aria-label={`Rename ${name}`}
          />
        ) : (
          <button
            type="button"
            onClick={onStartRename}
            disabled={disabled}
            title={`${name} — click to rename`}
            className="truncate text-left text-[12.5px] hover:underline disabled:opacity-50"
          >
            {name}
          </button>
        )}

        <p className="truncate text-[11.5px] text-faint">
          {[
            item.sizeBytes !== null ? fileSize(item.sizeBytes) : null,
            item.width !== null && item.height !== null ? `${item.width}×${item.height}` : null,
            relativeTime(item.createdAt),
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </p>

        <div className="mt-0.5 flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={onTogglePin}
            disabled={disabled}
            aria-label={item.pinned ? `Unpin ${name}` : `Pin ${name}`}
            title={item.pinned ? 'Unpin — retention can delete this again' : 'Pin — retention will never delete this'}
            className={`rounded p-1 hover:bg-panel-2 disabled:opacity-50 ${item.pinned ? 'text-accent' : 'text-faint'}`}
          >
            <FloppyDiskIcon className="size-3.5" aria-hidden />
          </button>
          <ConfirmDialog
            trigger={
              <button
                type="button"
                // A pinned file cannot be deleted: the server refuses it, and
                // the pin means "never delete this automatically" — so the
                // button says so here rather than letting the click fail.
                disabled={disabled || item.pinned}
                aria-label={`Delete ${name}`}
                title={item.pinned ? 'Unpin it first' : 'Delete'}
                className="rounded p-1 text-faint hover:bg-panel-2 hover:text-danger disabled:opacity-50"
              >
                <TrashIcon className="size-3.5" aria-hidden />
              </button>
            }
            title={`Delete ${name}?`}
            description="The file is removed from the farm and its bytes deleted. Anything still referencing it — a workflow, a queue entry — will stop resolving."
            confirmLabel="Delete"
            onConfirm={onDelete}
          />
        </div>
      </div>
    </li>
  )
}
