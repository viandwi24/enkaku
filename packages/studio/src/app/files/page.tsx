'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { artifactFamilyOf, type ArtifactBulkDeleteResponse, type ArtifactReference } from '@enkaku/protocol'
import {
  Button,
  CheckCircleIcon,
  Checkbox,
  CircleNotchIcon,
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
  XCircleIcon,
  XIcon,
  fileSize,
  relativeTime,
  useAction,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { newId } from '@/lib/ws'
import { BulkDeleteDialog, type BulkDeleteTarget } from '@/components/files/BulkDeleteDialog'
import {
  deleteUpload,
  describeReference,
  formatDuration,
  listUploadReferences,
  listUploads,
  renameUpload,
  setUploadPinned,
  uploadContentUrl,
  uploadFile,
  type FileFilter,
  type FileItem,
} from '@/components/files/files-api'

/**
 * One row of the upload queue (plan 800+ owner request — a farm loading
 * ~40 videos for ~40 devices in one sitting, not one file at a time). Each
 * file gets its own outcome: a batch is 40 independent uploads run one after
 * another, never 40 parallel requests against a core sharing the laptop with
 * every phone it drives.
 */
type QueueItem = {
  id: string
  file: File
  status: 'pending' | 'uploading' | 'done' | 'error'
  pct: number
  error: string | null
}

/**
 * Best-effort recursive walk of whatever a drop handed us. `DataTransferItem
 * .webkitGetAsEntry()` is how Chromium-family browsers expose a dropped
 * FOLDER as a tree rather than nothing — Safari and Firefox fall back to
 * `dataTransfer.files`, which still carries every plain file selected or
 * dropped, just not a folder's contents. Either way this never throws: a
 * browser that offers less just yields less.
 */
async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? [])
  const hasEntrySupport = items.length > 0 && typeof items[0]?.webkitGetAsEntry === 'function'
  if (!hasEntrySupport) return Array.from(dataTransfer.files ?? [])

  const out: File[] = []
  const walk = (entry: FileSystemEntry): Promise<void> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        ;(entry as FileSystemFileEntry).file(
          (file) => {
            out.push(file)
            resolve()
          },
          () => resolve(),
        )
        return
      }
      if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader()
        const readAll = () => {
          reader.readEntries(async (entries) => {
            if (entries.length === 0) {
              resolve()
              return
            }
            await Promise.all(entries.map(walk))
            // `readEntries` can require more than one call to exhaust a large
            // directory — keep asking until it returns nothing.
            readAll()
          }, () => resolve())
        }
        readAll()
        return
      }
      resolve()
    })

  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => e !== null && e !== undefined)
  if (entries.length === 0) return Array.from(dataTransfer.files ?? [])
  await Promise.all(entries.map(walk))
  return out
}

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
  /** Ticked files, by id. Pruned on every reload so a deleted file never stays selected. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** Who still uses each upload (a queued job, plugin data…). Empty when the caller may not manage files. */
  const [references, setReferences] = useState<Record<string, ArtifactReference[]>>({})
  const [bulkTarget, setBulkTarget] = useState<BulkDeleteTarget | null>(null)
  /**
   * The upload queue (null = no batch has run yet; `[]` never happens once a
   * batch starts, since it always seeds with the picked/dropped files). Kept
   * on screen after the batch finishes so a partial failure stays visible —
   * cleared only by the operator or by starting a new batch.
   */
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  /** True only while the sequential runner below is actually walking the queue. */
  const [batchRunning, setBatchRunning] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const { run, pending } = useAction()
  /*
   * Deliberately NOT a screen-wide "anything in flight" flag.
   *
   * The cap on an upload is a gigabyte, so one can run for minutes — and
   * disabling every tile for its duration made the whole page look frozen
   * while a video copied. Only the control that is actually busy is disabled:
   * the tile whose own action is running, and the Upload button while a
   * batch holds the input.
   */
  const uploading = batchRunning

  // Leaving mid-batch must not read as success: warn before the tab closes or
  // navigates away while files are still queued.
  useEffect(() => {
    if (!batchRunning) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [batchRunning])

  const reload = async () => {
    try {
      const next = await listUploads()
      setItems(next)
      setError(null)
      const present = new Set(next.map((i) => i.id))
      setSelected((prev) => new Set([...prev].filter((id) => present.has(id))))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // Best effort: a caller without the files permission gets a 403 here, and
    // simply sees no "Used by" hints — the server still refuses what it must.
    listUploadReferences()
      .then(setReferences)
      .catch(() => setReferences({}))
  }

  useEffect(() => {
    void reload()
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((item) => {
      if (filter !== 'all' && artifactFamilyOf(item) !== filter) return false
      if (q.length === 0) return true
      return (item.label ?? item.id).toLowerCase().includes(q)
    })
  }, [items, filter, query])

  /**
   * One file or forty — same path. Uploads run ONE AT A TIME (`for` loop, not
   * `Promise.all`): the core sits on the same laptop as every phone it is
   * driving, and 40 uploads in parallel would fight the farm for the same
   * disk and network the phones need. A file that fails is recorded and the
   * loop moves on — one bad file must never abort the other 39.
   */
  const startBatch = (files: File[]) => {
    if (batchRunning || files.length === 0) return
    const items: QueueItem[] = files.map((file) => ({ id: newId(), file, status: 'pending', pct: 0, error: null }))
    setQueue(items)
    setBatchRunning(true)
    void (async () => {
      let ok = 0
      let failed = 0
      for (const item of items) {
        setQueue((q) => (q ?? []).map((i) => (i.id === item.id ? { ...i, status: 'uploading' } : i)))
        try {
          await uploadFile(item.file, (pct) => setQueue((q) => (q ?? []).map((i) => (i.id === item.id ? { ...i, pct } : i))))
          ok += 1
          setQueue((q) => (q ?? []).map((i) => (i.id === item.id ? { ...i, status: 'done', pct: 1 } : i)))
        } catch (err) {
          failed += 1
          const message = err instanceof Error ? err.message : String(err)
          setQueue((q) => (q ?? []).map((i) => (i.id === item.id ? { ...i, status: 'error', error: message } : i)))
        }
      }
      setBatchRunning(false)
      void reload()
      if (failed === 0) toast.success(items.length === 1 ? `${items[0]?.file.name} uploaded` : `${ok} uploaded`)
      else if (ok === 0) toast.error(items.length === 1 ? `Could not upload ${items[0]?.file.name}` : `${failed} failed to upload`)
      else toast.warning(`${ok} uploaded, ${failed} failed`)
    })()
  }

  const shownSelected = shown.filter((item) => selected.has(item.id))
  const allShownSelected = shown.length > 0 && shownSelected.length === shown.length
  const selectedItems = (items ?? []).filter((item) => selected.has(item.id))
  const selectedBytes = selectedItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (allShownSelected) for (const item of shown) next.delete(item.id)
      else for (const item of shown) next.add(item.id)
      return next
    })

  const onBulkDone = (result: ArtifactBulkDeleteResponse) => {
    const gone = new Set(result.items.filter((i) => i.outcome === 'deleted').map((i) => i.id))
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))))
    void reload()
  }

  const onPick = (files: FileList | null) => {
    if (!files || files.length === 0) return
    startBatch(Array.from(files))
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
        description="Videos, images and other files you uploaded. Pick one as a script's input, or push it to a device from Device Control."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onPick(e.target.files)
                // Cleared so picking the SAME file(s) twice in a row still
                // fires a change event — otherwise a failed upload cannot be
                // retried without choosing something else first.
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              onClick={() => setBulkTarget({ mode: 'cleanup', family: filter, query })}
              disabled={items === null || items.length === 0}
              title="Delete old or unused files by rule"
            >
              <TrashIcon className="size-4" aria-hidden />
              Clean up
            </Button>
            <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
              <UploadSimpleIcon className="size-4" aria-hidden />
              {uploading ? `Uploading ${queue?.filter((i) => i.status === 'done' || i.status === 'error').length ?? 0}/${queue?.length ?? 0}` : 'Upload'}
            </Button>
          </>
        }
      />

      {queue !== null && (
        <UploadQueuePanel queue={queue} onDismiss={() => setQueue(null)} disabled={batchRunning} />
      )}

      <div
        className={`relative min-h-0 flex-1 overflow-y-auto ${dragOver ? 'outline outline-2 -outline-offset-2 outline-accent' : ''}`}
        onDragOver={(e) => {
          // Only files (not e.g. a dragged text selection) count as a drop target.
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void filesFromDataTransfer(e.dataTransfer).then((files) => startBatch(files))
        }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-panel/80">
            <p className="rounded-md border bg-panel px-4 py-2 text-[13px] text-text">Drop to upload — one at a time, in order</p>
          </div>
        )}
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
            {shown.length > 0 && (
              <label className="flex items-center gap-1.5 text-[12px] text-dim">
                <Checkbox
                  checked={allShownSelected ? true : shownSelected.length > 0 ? 'indeterminate' : false}
                  onCheckedChange={toggleAllShown}
                  aria-label="Select every file shown"
                />
                Select all shown
              </label>
            )}
            {selected.size > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[12px] text-dim">
                  {selected.size} selected · {fileSize(selectedBytes)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setBulkTarget({ mode: 'selection', ids: [...selected] })}>
                  <TrashIcon className="size-3.5" aria-hidden />
                  Delete selected
                </Button>
              </div>
            )}
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
                  selected={selected.has(item.id)}
                  onToggleSelect={() => toggleSelected(item.id)}
                  references={references[item.id] ?? []}
                  renaming={renaming?.id === item.id ? renaming.value : null}
                  onStartRename={() => setRenaming({ id: item.id, value: item.label ?? '' })}
                  onRenameChange={(value) => setRenaming({ id: item.id, value })}
                  onRenameCommit={commitRename}
                  onRenameCancel={() => setRenaming(null)}
                  onTogglePin={() => void togglePin(item)}
                  onDelete={() => void remove(item)}
                  disabled={pending === `pin-${item.id}` || pending === `del-${item.id}` || pending === `rename-${item.id}`}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <BulkDeleteDialog target={bulkTarget} onClose={() => setBulkTarget(null)} onDone={onBulkDone} />
    </div>
  )
}

/**
 * The batch's own list: one row per file, its progress or its outcome. Stays
 * on screen once the batch finishes — a farm loading 40 videos needs to see
 * which two failed and why, not a toast that already scrolled away.
 */
function UploadQueuePanel({ queue, onDismiss, disabled }: { queue: QueueItem[]; onDismiss: () => void; disabled: boolean }) {
  const done = queue.filter((i) => i.status === 'done').length
  const failed = queue.filter((i) => i.status === 'error').length
  const finished = done + failed === queue.length

  return (
    <div className="mx-5 mt-2 rounded-md border bg-panel-2/40">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <p className="text-[12px] text-faint">
          {finished ? `${done} uploaded, ${failed} failed` : `Uploading ${done + failed} of ${queue.length}…`}
        </p>
        {!disabled && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss upload queue" className="rounded p-1 text-faint hover:bg-panel-2 hover:text-text">
            <XIcon className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <ul className="max-h-40 overflow-y-auto">
        {queue.map((item) => (
          <li key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
            <span className="shrink-0">
              {item.status === 'done' ? (
                <CheckCircleIcon className="size-4 text-ok" aria-hidden />
              ) : item.status === 'error' ? (
                <XCircleIcon className="size-4 text-danger" aria-hidden />
              ) : item.status === 'uploading' ? (
                <CircleNotchIcon className="size-4 animate-spin text-accent" aria-hidden />
              ) : (
                <span className="size-4" aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate" title={item.file.name}>
              {item.file.name}
            </span>
            {item.status === 'error' ? (
              <span className="max-w-[45%] truncate text-danger" title={item.error ?? undefined}>
                {item.error}
              </span>
            ) : item.status === 'uploading' ? (
              <span className="w-9 shrink-0 text-right tabular-nums text-faint">{Math.round(item.pct * 100)}%</span>
            ) : item.status === 'done' ? (
              <span className="shrink-0 text-faint">{fileSize(item.file.size)}</span>
            ) : (
              <span className="shrink-0 text-faint">Waiting…</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One card. The preview is whatever the browser can decode; everything else is what the probe read at upload. */
function FileTile({
  item,
  selected,
  onToggleSelect,
  references,
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
  selected: boolean
  onToggleSelect: () => void
  references: ArtifactReference[]
  renaming: string | null
  onStartRename: () => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onTogglePin: () => void
  onDelete: () => void
  disabled: boolean
}) {
  const family = artifactFamilyOf(item)
  const blocking = references.filter((r) => r.blocking)
  const usedBy = references.length === 0 ? null : `${describeReference(references[0] as ArtifactReference)}${references.length > 1 ? ` +${references.length - 1} more` : ''}`
  const duration = formatDuration(item.durationMs)
  const name = item.label ?? item.id
  const url = uploadContentUrl(item.id)

  return (
    <li className={`flex flex-col overflow-hidden rounded-lg border bg-panel ${selected ? 'outline outline-2 -outline-offset-1 outline-accent' : ''}`}>
      <div className="relative flex aspect-video items-center justify-center bg-panel-2">
        {family === 'image' ? (
          <img src={url} alt="" loading="lazy" className="size-full object-contain" />
        ) : family === 'video' ? (
          /*
           * `#t=0.1` asks the browser to seek a tenth of a second in, which is
           * what makes it paint a frame — `preload="metadata"` alone leaves
           * many browsers showing a blank element. No canvas, no stored poster.
           */
          /*
           * `controls` matters more than it looks. This library exists so an
           * operator can pick the RIGHT clip to post, and a poster frame alone
           * cannot tell two similar videos apart — they often share a first
           * frame. Being able to scrub is the difference between recognising a
           * video and guessing at it.
           */
          <video src={`${url}#t=0.1`} preload="metadata" controls muted playsInline className="size-full object-contain" />
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

        {usedBy !== null && (
          <p
            className={`truncate text-[11.5px] ${blocking.length > 0 ? 'text-danger' : 'text-warn'}`}
            title={references.map(describeReference).join('\n')}
          >
            Used by {usedBy}
          </p>
        )}

        <div className="mt-0.5 flex items-center justify-end gap-0.5">
          <label className="mr-auto flex items-center gap-1.5 text-[11.5px] text-faint">
            <Checkbox checked={selected} onCheckedChange={onToggleSelect} aria-label={`Select ${name}`} />
            Select
          </label>
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
                disabled={disabled || item.pinned || blocking.length > 0}
                aria-label={`Delete ${name}`}
                title={item.pinned ? 'Unpin it first' : blocking.length > 0 ? 'A queued or running job still uses this file' : 'Delete'}
                className="rounded p-1 text-faint hover:bg-panel-2 hover:text-danger disabled:opacity-50"
              >
                <TrashIcon className="size-3.5" aria-hidden />
              </button>
            }
            title={`Delete ${name}?`}
            description={
              references.length === 0 ? (
                'The file is removed from the farm and its bytes deleted. The farm found nothing that still uses it, but it cannot see a file a plugin keeps outside its stored data.'
              ) : (
                <div className="space-y-2">
                  <p className="text-danger">This file is still referenced. Deleting it makes whatever uses it fail — a post, a retry, a scheduled run.</p>
                  <ul className="list-disc pl-5">
                    {references.map((ref, i) => (
                      <li key={i}>{describeReference(ref)}</li>
                    ))}
                  </ul>
                </div>
              )
            }
            confirmLabel={references.length > 0 ? 'Delete anyway' : 'Delete'}
            onConfirm={onDelete}
          />
        </div>
      </div>
    </li>
  )
}
