'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ArtifactBulkDeleteResponse, ArtifactReference } from '@enkaku/protocol'
import {
  CaretUpDownIcon,
  Button,
  CheckCircleIcon,
  Checkbox,
  CircleNotchIcon,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  ListDashesIcon,
  RowsIcon,
  SquaresFourIcon,
  Tabs,
  TabsList,
  TabsTrigger,
  TrashIcon,
  UploadSimpleIcon,
  XCircleIcon,
  XIcon,
  fileSize,
  useAction,
} from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { newId } from '@/lib/ws'
import { readLocalPrefs, writeLocalPrefs } from '@/lib/prefs'
import { BulkDeleteDialog, type BulkDeleteTarget } from '@/components/files/BulkDeleteDialog'
import { FilePreviewDialog } from '@/components/files/FilePreviewDialog'
import { FilesGrid, FilesList, FilesTable, TILE_WIDTHS, type FileActions, type TileSize } from '@/components/files/FileViews'
import { FilesPager } from '@/components/files/FilesPager'
import {
  deleteUpload,
  listUploadReferences,
  listUploads,
  renameUpload,
  setUploadPinned,
  uploadFile,
  type FileFilter,
  type FileItem,
} from '@/components/files/files-api'
import {
  PAGE_SIZES,
  SORT_DIRECTION_LABELS,
  SORT_LABELS,
  compareFiles,
  defaultDirectionFor,
  filterFiles,
  pageCount,
  pageSlice,
  type FilesSort,
  type FilesView,
  type PageSize,
  type SortDir,
} from '@/components/files/files-view'

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
 * `/files` — the media library (plan 800 wave 5), rebuilt as a file manager
 * (owner, 2026-09-20: pagination, a real player, and "mode show, order, dll
 * biar kaya file manager/finder beneran").
 *
 * Shows only files an OPERATOR uploaded (`?kind=upload`). A run's screenshots
 * and a device's logs are artifacts too, and they belong on the job that
 * produced them: they are swept on a different policy, and deleting one here
 * would tear a hole in a run's own evidence.
 *
 * **No thumbnail is fetched or stored** (plan 800 wave 4). There is no ffmpeg
 * in this repo, and there does not need to be: the browser already has a
 * decoder, so an image is an `<img>` and a video is a `<video>` seeked to its
 * first tenth of a second (`FileThumb`).
 *
 * ## The pipeline, in one place
 *
 * Every file the screen holds goes through the same four steps in this order,
 * and each one is a pure function in `files-view.ts`: FILTER (the family tab
 * and the search box) → SORT (the operator's column and direction) → PAGE
 * (`pageSlice`) → RENDER (one of three lenses). They are separate on purpose:
 *
 * - The sort is over the FILTERED list, not the page, so "largest first"
 *   means largest in the library rather than largest among the forty-eight
 *   that happen to be on screen.
 * - The preview's ← / → walk the filtered list too, straight across a page
 *   boundary — a page is a way to render a long list, not a fact about a file.
 * - Selection and the bulk delete keep working on ids from every page, which
 *   is why `selected` is a Set of ids and never an index.
 */

const FILTERS: { value: FileFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'other', label: 'Other' },
]

const VIEWS: { value: FilesView; label: string; icon: typeof SquaresFourIcon }[] = [
  { value: 'grid', label: 'Tiles', icon: SquaresFourIcon },
  { value: 'list', label: 'List', icon: RowsIcon },
  { value: 'details', label: 'Details', icon: ListDashesIcon },
]

const SORTS: FilesSort[] = ['name', 'added', 'size', 'duration', 'kind']

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
  /** The file the preview lightbox is showing, or null when it is closed. */
  const [previewId, setPreviewId] = useState<string | null>(null)
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const { run, pending } = useAction()

  /*
   * The view choices, read from `localStorage` ONCE on mount and never during
   * render.
   *
   * Studio is a static export: every page is prerendered in Node, where
   * `localStorage` does not exist. Seeding `useState` from it directly would
   * throw at build time; seeding it from the schema default and then adopting
   * the stored value in an effect is the shape that survives both, and it also
   * keeps the first client render identical to the prerendered HTML instead of
   * hydrating into a mismatch.
   */
  const [view, setView] = useState<FilesView>('grid')
  const [tileSize, setTileSize] = useState<TileSize>('m')
  const [sort, setSort] = useState<FilesSort>('added')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [pageSize, setPageSize] = useState<PageSize>(48)
  const [page, setPage] = useState(1)

  useEffect(() => {
    const prefs = readLocalPrefs()
    setView(prefs.filesView)
    setTileSize(prefs.filesTileSize)
    setSort(prefs.filesSort)
    setSortDir(prefs.filesSortDir)
    setPageSize(prefs.filesPageSize)
  }, [])

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
      // A file deleted from under an open preview closes it rather than
      // leaving the dialog showing bytes the farm no longer has.
      setPreviewId((prev) => (prev !== null && present.has(prev) ? prev : null))
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

  /** FILTER then SORT — over the whole library, never over a page. See the module note. */
  const shown = useMemo(() => {
    const matched = filterFiles(items ?? [], filter, query)
    return matched.sort(compareFiles(sort, sortDir))
  }, [items, filter, query, sort, sortDir])

  const pages = pageCount(shown.length, pageSize)
  /*
   * The page number is CLAMPED on read rather than corrected in an effect.
   *
   * Narrowing the search from page 7 down to two pages of results, or deleting
   * the last file on the last page, both leave `page` past the end — and an
   * effect that fixed it would render one empty frame first. Reading it
   * clamped means the screen is never on a page that does not exist; the state
   * catches up on the next click.
   */
  const currentPage = Math.min(Math.max(1, page), pages)
  const pageItems = useMemo(() => pageSlice(shown, currentPage, pageSize), [shown, currentPage, pageSize])

  // Anything that changes WHICH files are listed sends the pager back to the
  // first page: staying on page 5 of a fresh search is how an operator ends up
  // looking at an empty screen and concluding the search found nothing.
  useEffect(() => {
    setPage(1)
  }, [filter, query, sort, sortDir, pageSize])

  const shownSelected = pageItems.filter((item) => selected.has(item.id))
  const allShownSelected = pageItems.length > 0 && shownSelected.length === pageItems.length
  const selectedItems = (items ?? []).filter((item) => selected.has(item.id))
  const selectedBytes = selectedItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)

  /**
   * One file or forty — same path. Uploads run ONE AT A TIME (`for` loop, not
   * `Promise.all`): the core sits on the same laptop as every phone it is
   * driving, and 40 uploads in parallel would fight the farm for the same
   * disk and network the phones need. A file that fails is recorded and the
   * loop moves on — one bad file must never abort the other 39.
   */
  const startBatch = (files: File[]) => {
    if (batchRunning || files.length === 0) return
    const queued: QueueItem[] = files.map((file) => ({ id: newId(), file, status: 'pending', pct: 0, error: null }))
    setQueue(queued)
    setBatchRunning(true)
    void (async () => {
      let ok = 0
      let failed = 0
      for (const item of queued) {
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
      if (failed === 0) toast.success(queued.length === 1 ? `${queued[0]?.file.name} uploaded` : `${ok} uploaded`)
      else if (ok === 0) toast.error(queued.length === 1 ? `Could not upload ${queued[0]?.file.name}` : `${failed} failed to upload`)
      else toast.warning(`${ok} uploaded, ${failed} failed`)
    })()
  }

  const toggleSelected = (item: FileItem) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })

  /** Select-all is per PAGE, which is what the checkbox sits above. The "select every match" escape hatch is the button beside it. */
  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (allShownSelected) for (const item of pageItems) next.delete(item.id)
      else for (const item of pageItems) next.add(item.id)
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

  /** Picking a column sorts by it; picking the SAME column again reverses it — the one gesture every file manager shares. */
  const applySort = (next: FilesSort) => {
    const dir = next === sort ? (sortDir === 'asc' ? 'desc' : 'asc') : defaultDirectionFor(next)
    setSort(next)
    setSortDir(dir)
    writeLocalPrefs({ filesSort: next, filesSortDir: dir })
  }

  const applyView = (next: FilesView) => {
    setView(next)
    writeLocalPrefs({ filesView: next })
  }

  const goToPage = (next: number) => {
    setPage(Math.min(Math.max(1, next), pages))
    // The list starts at the top of a new page. Without this, paging from the
    // bottom of page 2 lands halfway down page 3 with no visible change.
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const actions: FileActions = {
    selected: (item) => selected.has(item.id),
    onToggleSelect: toggleSelected,
    onOpen: (item) => setPreviewId(item.id),
    references: (item) => references[item.id] ?? [],
    renaming: (item) => (renaming?.id === item.id ? renaming.value : null),
    onStartRename: (item) => setRenaming({ id: item.id, value: item.label ?? '' }),
    onRenameChange: (value) => setRenaming((prev) => (prev === null ? prev : { ...prev, value })),
    onRenameCommit: commitRename,
    onRenameCancel: () => setRenaming(null),
    onTogglePin: (item) => void togglePin(item),
    onDelete: (item) => void remove(item),
    busy: (item) => pending === `pin-${item.id}` || pending === `del-${item.id}` || pending === `rename-${item.id}`,
  }

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
        ref={scrollRef}
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
          <div className="flex flex-wrap items-center gap-2">
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
              className="h-8 max-w-56"
              aria-label="Search files"
            />

            {/* Sort. The menu is the only sort control in the tiles and list
                lenses; the details table's headers do the same thing through
                the same `applySort`, so the two can never disagree. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" title="Sort files">
                  <CaretUpDownIcon className="size-3.5" aria-hidden />
                  {SORT_LABELS[sort]}
                  <span className="text-faint">· {SORT_DIRECTION_LABELS[sort][sortDir]}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => applySort(v as FilesSort)}>
                  {SORTS.map((key) => (
                    <DropdownMenuRadioItem key={key} value={key}>
                      {SORT_LABELS[key]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Order</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sortDir}
                  onValueChange={(v) => {
                    const dir = v as SortDir
                    setSortDir(dir)
                    writeLocalPrefs({ filesSortDir: dir })
                  }}
                >
                  {(['asc', 'desc'] as const).map((dir) => (
                    <DropdownMenuRadioItem key={dir} value={dir}>
                      {SORT_DIRECTION_LABELS[sort][dir]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* View: the lens, the tile size and the page size. One menu
                because all three answer "how do I want to look at this", and
                three separate controls in the toolbar would crowd out the
                search box at 1280 px. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" title="Change the view">
                  {(() => {
                    const Icon = (VIEWS.find((v) => v.value === view) ?? VIEWS[0]).icon
                    return <Icon className="size-3.5" aria-hidden />
                  })()}
                  View
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>Show as</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={view} onValueChange={(v) => applyView(v as FilesView)}>
                  {VIEWS.map((v) => (
                    <DropdownMenuRadioItem key={v.value} value={v.value}>
                      {v.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {view === 'grid' && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Tile size</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={tileSize}
                      onValueChange={(v) => {
                        const next = v as TileSize
                        setTileSize(next)
                        writeLocalPrefs({ filesTileSize: next })
                      }}
                    >
                      {(Object.keys(TILE_WIDTHS) as TileSize[]).map((size) => (
                        <DropdownMenuRadioItem key={size} value={size}>
                          {{ s: 'Small', m: 'Medium', l: 'Large' }[size]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Files per page</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(pageSize)}
                  onValueChange={(v) => {
                    const next = Number(v) as PageSize
                    setPageSize(next)
                    writeLocalPrefs({ filesPageSize: next })
                  }}
                >
                  {PAGE_SIZES.map((size) => (
                    <DropdownMenuRadioItem key={size} value={String(size)}>
                      {size}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="text-[12px] text-faint">
              {items === null ? '' : `${shown.length} of ${items.length}`}
            </span>

            {/* The details table carries its own select-all in the header row,
                the way a table does; the other two lenses need it out here. */}
            {pageItems.length > 0 && view !== 'details' && (
              <label className="flex items-center gap-1.5 text-[12px] text-dim">
                <Checkbox
                  checked={allShownSelected ? true : shownSelected.length > 0 ? 'indeterminate' : false}
                  onCheckedChange={toggleAllShown}
                  aria-label="Select every file on this page"
                />
                Select page
              </label>
            )}

            {selected.size > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[12px] text-dim">
                  {selected.size} selected · {fileSize(selectedBytes)}
                </span>
                {/* Selection spans pages, so "select every match" has to be
                    its own action — ticking the page checkbox on each of nine
                    pages is not a workflow. */}
                {shown.length > pageItems.length && selected.size < shown.length && (
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(shown.map((i) => i.id)))}>
                    Select all {shown.length}
                  </Button>
                )}
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
            <>
              {view === 'grid' ? (
                <FilesGrid items={pageItems} actions={actions} tileSize={tileSize} />
              ) : view === 'list' ? (
                <FilesList items={pageItems} actions={actions} />
              ) : (
                <FilesTable
                  items={pageItems}
                  actions={actions}
                  sort={sort}
                  sortDir={sortDir}
                  onSort={applySort}
                  allShownSelected={allShownSelected}
                  someShownSelected={shownSelected.length > 0}
                  onToggleAllShown={toggleAllShown}
                />
              )}
              <FilesPager
                page={currentPage}
                pages={pages}
                total={shown.length}
                shownFrom={(currentPage - 1) * pageSize + 1}
                shownTo={(currentPage - 1) * pageSize + pageItems.length}
                onPage={goToPage}
              />
            </>
          )}
        </div>
      </div>

      <FilePreviewDialog
        items={shown}
        openId={previewId}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null)
        }}
        onNavigate={setPreviewId}
        references={references}
        onTogglePin={(item) => void togglePin(item)}
        onDelete={(item) => void remove(item)}
        busy={previewId !== null && (pending === `pin-${previewId}` || pending === `del-${previewId}`)}
      />

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
