'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ArtifactReference } from '@enkaku/protocol'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Checkbox,
  ConfirmDialog,
  DownloadSimpleIcon,
  FileIcon,
  FilmSlateIcon,
  FloppyDiskIcon,
  ImageIcon,
  Input,
  PlayIcon,
  SpeakerHighIcon,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrashIcon,
  fileSize,
  relativeTime,
} from '@enkaku/ui'
import {
  describeReference,
  fileExtOf,
  formatDuration,
  uploadContentUrl,
  uploadDownloadUrl,
  type FileItem,
} from './files-api'
import {
  SORT_LABELS,
  fileName,
  previewKindOf,
  type FilesSort,
  type SortDir,
} from './files-view'

/**
 * The Files screen's three lenses — tiles, compact rows, and the details table
 * (owner, 2026-09-20). One file, because they are three renderings of ONE
 * thing: the same page of the same ordered list, the same selection, the same
 * four per-file actions. Split across three files they would drift, and the
 * first symptom of that is always an action that exists in one view and not
 * the others.
 *
 * Every view gets `FileActions` and nothing else, so "what can I do to a file"
 * is defined once, here, and adding a fifth action cannot reach two lenses and
 * miss the third.
 */
export interface FileActions {
  selected: (item: FileItem) => boolean
  onToggleSelect: (item: FileItem) => void
  /** Opens the preview lightbox. The primary gesture in every view: a file manager opens a file when you click it. */
  onOpen: (item: FileItem) => void
  references: (item: FileItem) => ArtifactReference[]
  /** The in-progress rename for this file, or null. Kept by the page so exactly one rename can be open at a time. */
  renaming: (item: FileItem) => string | null
  onStartRename: (item: FileItem) => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onTogglePin: (item: FileItem) => void
  onDelete: (item: FileItem) => void
  /** True while THIS file's own action is in flight — never a screen-wide freeze (see the page's note on `uploading`). */
  busy: (item: FileItem) => boolean
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether an element has ever come near the viewport.
 *
 * A page of 192 tiles is 192 `<video preload="metadata">` elements, and each
 * one opens its own request to the core the moment it mounts — on the machine
 * that is also driving every phone in the farm. This holds the `src` back until
 * the tile is within a screen of being seen, and never takes it away again:
 * flipping a `src` off on scroll would throw away a decoded frame and make the
 * grid flicker on the way back up.
 *
 * `rootMargin` is generous on purpose — the preview should already be there
 * when the tile arrives, not start loading once it does.
 */
function useNearViewport<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    if (near) return
    const el = ref.current
    // No IntersectionObserver (or no element yet): show everything rather than
    // nothing. A missing optimisation must never become a blank library.
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true)
      },
      { rootMargin: '600px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])

  return [ref, near]
}

/** The glyph for a file's kind, used wherever a preview is too small or does not exist. */
function KindIcon({ item, className }: { item: FileItem; className?: string }) {
  const kind = previewKindOf(item)
  if (kind === 'image') return <ImageIcon className={className} aria-hidden />
  if (kind === 'video') return <FilmSlateIcon className={className} aria-hidden />
  if (kind === 'audio') return <SpeakerHighIcon className={className} aria-hidden />
  return <FileIcon className={className} aria-hidden />
}

/**
 * A file's own picture, at whatever size the lens asks for.
 *
 * **Nothing is generated and nothing is stored** (plan 800 wave 4): an image is
 * an `<img>`, and a video is a `<video>` seeked to `#t=0.1`, which is the
 * fragment that makes a browser decode and paint a frame — `preload="metadata"`
 * alone leaves many of them showing a blank element.
 *
 * The video here has NO `controls`, which is the change from what this screen
 * used to be. A control bar on a 200 px tile is unusable, it collides with the
 * click that opens the file, and it made every tile on the page an independent
 * player. Scrubbing happens at full size in the preview dialog, where there is
 * room for a real one.
 */
function FileThumb({ item, className }: { item: FileItem; className?: string }) {
  const [ref, near] = useNearViewport<HTMLDivElement>()
  const kind = previewKindOf(item)
  const url = uploadContentUrl(item.id)

  return (
    <div ref={ref} className={`relative flex items-center justify-center overflow-hidden bg-panel-2 ${className ?? ''}`}>
      {kind === 'image' && near ? (
        <img src={url} alt="" loading="lazy" className="size-full object-contain" />
      ) : kind === 'video' && near ? (
        <>
          <video src={`${url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-contain" />
          {/* The badge is what says "this is a video and it will play" now
              that the tile itself no longer carries a control bar. */}
          <span className="pointer-events-none absolute grid size-8 place-items-center rounded-full bg-black/55 text-white">
            <PlayIcon className="size-4" aria-hidden />
          </span>
        </>
      ) : (
        <KindIcon item={item} className="size-7 text-faint" />
      )}
    </div>
  )
}

/** The name, or the input that is renaming it. Every lens renames the same way. */
function NameCell({ item, actions, className }: { item: FileItem; actions: FileActions; className?: string }) {
  const renaming = actions.renaming(item)
  const name = fileName(item)

  if (renaming !== null) {
    return (
      <Input
        autoFocus
        value={renaming}
        onChange={(e) => actions.onRenameChange(e.target.value)}
        onBlur={actions.onRenameCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') actions.onRenameCommit()
          if (e.key === 'Escape') actions.onRenameCancel()
        }}
        // A rename inside a row must not reach the row's own click handler,
        // which would open the preview over the field being typed into.
        onClick={(e) => e.stopPropagation()}
        className={`h-7 text-[12.5px] ${className ?? ''}`}
        aria-label={`Rename ${name}`}
      />
    )
  }
  return (
    <span className={`truncate ${className ?? ''}`} title={name}>
      {name}
    </span>
  )
}

/** Pin, download, delete — in that order in every lens. */
function RowActions({ item, actions, references }: { item: FileItem; actions: FileActions; references: ArtifactReference[] }) {
  const name = fileName(item)
  const blocking = references.filter((r) => r.blocking)
  const busy = actions.busy(item)

  return (
    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => actions.onTogglePin(item)}
        disabled={busy}
        aria-label={item.pinned ? `Unpin ${name}` : `Pin ${name}`}
        title={item.pinned ? 'Unpin — retention can delete this again' : 'Pin — retention will never delete this'}
        className={`rounded p-1 hover:bg-panel-2 disabled:opacity-50 ${item.pinned ? 'text-accent' : 'text-faint'}`}
      >
        <FloppyDiskIcon className="size-3.5" aria-hidden />
      </button>
      {/* Leaves Studio for the core's byte route, so a plain anchor is correct
          here — `next/link` is for navigation inside the static export. */}
      <a
        href={uploadDownloadUrl(item.id)}
        download={name}
        aria-label={`Download ${name}`}
        title="Download"
        className="rounded p-1 text-faint hover:bg-panel-2 hover:text-text"
      >
        <DownloadSimpleIcon className="size-3.5" aria-hidden />
      </a>
      <ConfirmDialog
        trigger={
          <button
            type="button"
            // A pinned file cannot be deleted: the server refuses it, and the
            // pin means "never delete this automatically" — so the button says
            // so here rather than letting the click fail.
            disabled={busy || item.pinned || blocking.length > 0}
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
        onConfirm={() => actions.onDelete(item)}
      />
    </div>
  )
}

/** The amber/red "Used by" line. Same words, same colours, all three lenses. */
function UsedBy({ references, className }: { references: ArtifactReference[]; className?: string }) {
  if (references.length === 0) return null
  const blocking = references.filter((r) => r.blocking)
  return (
    <span
      className={`truncate ${blocking.length > 0 ? 'text-danger' : 'text-warn'} ${className ?? ''}`}
      title={references.map(describeReference).join('\n')}
    >
      Used by {describeReference(references[0] as ArtifactReference)}
      {references.length > 1 ? ` +${references.length - 1} more` : ''}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                       */
/* -------------------------------------------------------------------------- */

/** The tile width presets the toolbar's View menu offers, in px. Wider than a phone screenshot is tall at every step, so a portrait tile is never cropped. */
export const TILE_WIDTHS = { s: 150, m: 200, l: 270 } as const
export type TileSize = keyof typeof TILE_WIDTHS

export function FilesGrid({ items, actions, tileSize }: { items: readonly FileItem[]; actions: FileActions; tileSize: TileSize }) {
  return (
    <ul
      className="grid gap-3"
      // `auto-fill` with a minimum, not a fixed column count: the wall of
      // tiles then reflows with the sidebar collapsing and the window
      // resizing, instead of holding five columns at 960 px and clipping.
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_WIDTHS[tileSize]}px, 1fr))` }}
    >
      {items.map((item) => (
        <FileTile key={item.id} item={item} actions={actions} />
      ))}
    </ul>
  )
}

function FileTile({ item, actions }: { item: FileItem; actions: FileActions }) {
  const references = actions.references(item)
  const duration = formatDuration(item.durationMs)
  const selected = actions.selected(item)
  const name = fileName(item)

  return (
    <li className={`flex flex-col overflow-hidden rounded-lg border bg-panel ${selected ? 'outline outline-2 -outline-offset-1 outline-accent' : ''}`}>
      <button
        type="button"
        onClick={() => actions.onOpen(item)}
        aria-label={`Open ${name}`}
        className="group relative block aspect-video w-full cursor-pointer"
      >
        <FileThumb item={item} className="size-full" />
        <span className="absolute left-1.5 top-1.5 rounded bg-panel/90 p-1 text-faint">
          <KindIcon item={item} className="size-3.5" />
        </span>
        {duration !== null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-panel/90 px-1.5 py-0.5 text-[11px] tabular-nums text-dim">{duration}</span>
        )}
        {item.pinned && (
          <span className="absolute right-1.5 top-1.5 rounded bg-panel/90 p-1 text-accent" title="Pinned — retention will never delete this">
            <FloppyDiskIcon className="size-3.5" aria-hidden />
          </span>
        )}
      </button>

      <div className="flex min-w-0 flex-col gap-1 p-2.5">
        {actions.renaming(item) !== null ? (
          <NameCell item={item} actions={actions} />
        ) : (
          <button
            type="button"
            onClick={() => actions.onStartRename(item)}
            disabled={actions.busy(item)}
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

        <UsedBy references={references} className="text-[11.5px]" />

        <div className="mt-0.5 flex items-center justify-end gap-0.5">
          <label className="mr-auto flex items-center gap-1.5 text-[11.5px] text-faint">
            <Checkbox checked={selected} onCheckedChange={() => actions.onToggleSelect(item)} aria-label={`Select ${name}`} />
            Select
          </label>
          <RowActions item={item} actions={actions} references={references} />
        </div>
      </div>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

/** The middle lens: a thumbnail small enough to scan a hundred of, with the facts on one line beside it. */
export function FilesList({ items, actions }: { items: readonly FileItem[]; actions: FileActions }) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-panel">
      {items.map((item) => {
        const references = actions.references(item)
        const selected = actions.selected(item)
        const name = fileName(item)
        const duration = formatDuration(item.durationMs)
        return (
          <li
            key={item.id}
            onClick={() => actions.onOpen(item)}
            className={`flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover ${selected ? 'bg-accent-soft' : ''}`}
          >
            <span onClick={(e) => e.stopPropagation()} className="shrink-0">
              <Checkbox checked={selected} onCheckedChange={() => actions.onToggleSelect(item)} aria-label={`Select ${name}`} />
            </span>
            <FileThumb item={item} className="size-11 shrink-0 rounded-small" />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                <NameCell item={item} actions={actions} />
                {item.pinned && <FloppyDiskIcon className="size-3 shrink-0 text-accent" aria-label="Pinned" />}
              </div>
              <p className="truncate text-[11.5px] text-faint">
                {[
                  fileExtOf(item),
                  item.sizeBytes !== null ? fileSize(item.sizeBytes) : null,
                  item.width !== null && item.height !== null ? `${item.width}×${item.height}` : null,
                  duration,
                  relativeTime(item.createdAt),
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
              </p>
            </div>
            <UsedBy references={references} className="hidden max-w-56 text-[11.5px] lg:block" />
            <RowActions item={item} actions={actions} references={references} />
          </li>
        )
      })}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */
/* Details                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The third lens: one column per fact, and the column headers are the sort.
 *
 * Clicking a header is how every file manager sorts, and it is the reason this
 * view exists at all — the toolbar's sort menu works everywhere, but a table
 * whose headers are inert is a table that looks broken.
 */
export function FilesTable({
  items,
  actions,
  sort,
  sortDir,
  onSort,
  allShownSelected,
  someShownSelected,
  onToggleAllShown,
}: {
  items: readonly FileItem[]
  actions: FileActions
  sort: FilesSort
  sortDir: SortDir
  onSort: (sort: FilesSort) => void
  allShownSelected: boolean
  someShownSelected: boolean
  onToggleAllShown: () => void
}) {
  const header = (key: FilesSort, className?: string): ReactNode => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(key)}
        title={`Sort by ${SORT_LABELS[key].toLowerCase()}${sort === key ? ' — click to reverse' : ''}`}
        className={`flex items-center gap-1 hover:text-text ${sort === key ? 'text-text' : ''}`}
      >
        {SORT_LABELS[key]}
        {sort === key &&
          (sortDir === 'asc' ? <ArrowUpIcon className="size-3" aria-label="ascending" /> : <ArrowDownIcon className="size-3" aria-label="descending" />)}
      </button>
    </TableHead>
  )

  return (
    <div className="overflow-hidden rounded-lg border bg-panel">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-9">
              <Checkbox
                checked={allShownSelected ? true : someShownSelected ? 'indeterminate' : false}
                onCheckedChange={onToggleAllShown}
                aria-label="Select every file on this page"
              />
            </TableHead>
            <TableHead className="w-12" />
            {header('name')}
            {header('kind', 'w-24')}
            {header('size', 'w-24')}
            {header('duration', 'w-24')}
            {header('added', 'w-32')}
            <TableHead className="w-24 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const references = actions.references(item)
            const selected = actions.selected(item)
            const name = fileName(item)
            return (
              <TableRow
                key={item.id}
                onClick={() => actions.onOpen(item)}
                className={`cursor-pointer ${selected ? 'bg-accent-soft' : ''}`}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox checked={selected} onCheckedChange={() => actions.onToggleSelect(item)} aria-label={`Select ${name}`} />
                </TableCell>
                <TableCell>
                  <FileThumb item={item} className="size-8 rounded-small" />
                </TableCell>
                <TableCell className="max-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <NameCell item={item} actions={actions} />
                    {item.pinned && <FloppyDiskIcon className="size-3 shrink-0 text-accent" aria-label="Pinned" />}
                  </div>
                  <UsedBy references={references} className="block text-[11px]" />
                </TableCell>
                <TableCell className="text-faint">{fileExtOf(item) ?? '—'}</TableCell>
                <TableCell className="tabular-nums text-faint">{item.sizeBytes !== null ? fileSize(item.sizeBytes) : '—'}</TableCell>
                <TableCell className="tabular-nums text-faint">{formatDuration(item.durationMs) ?? '—'}</TableCell>
                <TableCell className="text-faint" title={new Date(item.createdAt * 1000).toLocaleString()}>
                  {relativeTime(item.createdAt)}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end">
                    <RowActions item={item} actions={actions} references={references} />
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
