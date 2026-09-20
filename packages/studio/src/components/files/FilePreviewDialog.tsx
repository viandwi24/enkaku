'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ArtifactReference } from '@enkaku/protocol'
import {
  Button,
  CaretLeftIcon,
  CaretRightIcon,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogTitle,
  DownloadSimpleIcon,
  FileIcon,
  FloppyDiskIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  SpeakerHighIcon,
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
import { fileName, previewKindOf } from './files-view'
import { MediaPlayer } from './MediaPlayer'

/**
 * Quick Look for the farm's media library (owner, 2026-09-20).
 *
 * One file filling the screen, the real player under it, and ← / → to walk the
 * library without going back to the grid first — which is the whole point. The
 * job this screen exists for is "which of these forty clips do I post", and
 * that is a comparison: it is answered by stepping between files at full size,
 * never by squinting at forty tiles.
 *
 * It navigates the ORDERED, FILTERED list the screen is showing, not the page.
 * Stepping off the end of page 2 into page 3 is what an operator means by
 * "next" — a preview that stopped at a page boundary would expose a pagination
 * detail that has nothing to do with the file they are looking at.
 */
export function FilePreviewDialog({
  items,
  openId,
  onOpenChange,
  onNavigate,
  references,
  onTogglePin,
  onDelete,
  busy,
}: {
  /** The whole filtered, sorted list — not the current page. See the note above. */
  items: readonly FileItem[]
  /** The file being previewed, or null when the dialog is closed. */
  openId: string | null
  onOpenChange: (open: boolean) => void
  onNavigate: (id: string) => void
  references: Record<string, ArtifactReference[]>
  onTogglePin: (item: FileItem) => void
  onDelete: (item: FileItem) => void
  /** True while this file's own pin or delete is in flight — the same per-action gate the tiles use, never a screen-wide freeze. */
  busy: boolean
}) {
  const index = openId === null ? -1 : items.findIndex((i) => i.id === openId)
  const item = index === -1 ? null : (items[index] as FileItem)

  const step = useCallback(
    (delta: number) => {
      if (index === -1) return
      const next = items[index + delta]
      if (next) onNavigate(next.id)
    },
    [index, items, onNavigate],
  )

  /*
   * ← and → belong to this dialog, which is why the player is told not to
   * bind them (`hotkeys="noarrowleft noarrowright"` in `MediaPlayer`). The
   * listener skips a keystroke aimed at a text field so that a rename started
   * elsewhere on the page can never be hijacked into a navigation.
   */
  useEffect(() => {
    if (item === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, step])

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent
        // The stage is the point, so the dialog's own padding and grid gap are
        // dropped and the whole thing is given the width of the window.
        className="grid max-h-[92dvh] w-[min(1280px,calc(100vw-3rem))] max-w-[calc(100vw-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)]"
        showCloseButton
      >
        {item === null ? (
          // Radix requires a title for every dialog; this branch only renders
          // in the frame between the last file closing and the dialog leaving.
          <DialogTitle className="sr-only">File preview</DialogTitle>
        ) : (
          <PreviewBody
            item={item}
            position={`${index + 1} of ${items.length}`}
            hasPrevious={index > 0}
            hasNext={index < items.length - 1}
            onPrevious={() => step(-1)}
            onNext={() => step(1)}
            references={references[item.id] ?? []}
            onTogglePin={() => onTogglePin(item)}
            onDelete={() => onDelete(item)}
            busy={busy}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PreviewBody({
  item,
  position,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  references,
  onTogglePin,
  onDelete,
  busy,
}: {
  item: FileItem
  position: string
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  references: ArtifactReference[]
  onTogglePin: () => void
  onDelete: () => void
  busy: boolean
}) {
  const kind = previewKindOf(item)
  const name = fileName(item)
  const ext = fileExtOf(item)
  const url = uploadContentUrl(item.id)
  const blocking = references.filter((r) => r.blocking)

  return (
    <>
      <header className="flex min-w-0 items-center gap-3 border-b px-4 py-2.5 pr-12">
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-[13px] font-medium" title={name}>
            {name}
          </DialogTitle>
          <p className="truncate text-[11.5px] text-faint">
            {[ext, item.sizeBytes !== null ? fileSize(item.sizeBytes) : null, position]
              .filter((part): part is string => part !== null)
              .join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon" variant="ghost" onClick={onPrevious} disabled={!hasPrevious} aria-label="Previous file" title="Previous file (←)">
            <CaretLeftIcon className="size-4" aria-hidden />
          </Button>
          <Button size="icon" variant="ghost" onClick={onNext} disabled={!hasNext} aria-label="Next file" title="Next file (→)">
            <CaretRightIcon className="size-4" aria-hidden />
          </Button>
        </div>
      </header>

      {/*
       * `key` on the stage, not on the dialog. Stepping to the next file must
       * build a NEW <video>/<img>: React would otherwise keep the element and
       * only swap `src`, which leaves the outgoing clip's currentTime, play
       * state and decoded frame on screen while the incoming one loads — the
       * previous video visibly playing under the next one's name.
       */}
      <div key={item.id} className="flex min-h-0 items-center justify-center bg-black">
        {kind === 'image' ? (
          <ImageStage src={url} alt={name} />
        ) : kind === 'video' || kind === 'audio' ? (
          <MediaPlayer src={url} kind={kind} className="size-full" />
        ) : (
          <NoPreview item={item} />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2.5">
        <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
          <Fact label="Added" value={relativeTime(item.createdAt)} />
          {item.width !== null && item.height !== null && <Fact label="Dimensions" value={`${item.width} × ${item.height}`} />}
          {formatDuration(item.durationMs) !== null && <Fact label="Duration" value={formatDuration(item.durationMs) as string} />}
          <Fact label="Type" value={item.mimeType ?? 'unknown'} />
          {references.length > 0 && (
            <span
              className={`truncate ${blocking.length > 0 ? 'text-danger' : 'text-warn'}`}
              title={references.map(describeReference).join('\n')}
            >
              Used by {describeReference(references[0] as ArtifactReference)}
              {references.length > 1 ? ` +${references.length - 1} more` : ''}
            </span>
          )}
        </dl>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={onTogglePin}
            disabled={busy}
            className={item.pinned ? 'text-accent' : undefined}
            title={item.pinned ? 'Unpin — retention can delete this again' : 'Pin — retention will never delete this'}
          >
            <FloppyDiskIcon className="size-3.5" aria-hidden />
            {item.pinned ? 'Pinned' : 'Pin'}
          </Button>
          <Button size="sm" variant="outline" asChild>
            {/* A plain anchor, not `next/link`: this leaves Studio for the
                core's byte route, which is exactly the navigation `next/link`
                must not be used for. `download` names the saved file when the
                origins match; the core's own Content-Disposition covers the
                dev split where they do not. */}
            <a href={uploadDownloadUrl(item.id)} download={name}>
              <DownloadSimpleIcon className="size-3.5" aria-hidden />
              Download
            </a>
          </Button>
          <ConfirmDialog
            trigger={
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || item.pinned || blocking.length > 0}
                title={item.pinned ? 'Unpin it first' : blocking.length > 0 ? 'A queued or running job still uses this file' : 'Delete'}
                className="text-faint hover:text-danger"
              >
                <TrashIcon className="size-3.5" aria-hidden />
                Delete
              </Button>
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
      </footer>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <dt className="text-faint">{label}</dt>
      <dd className="truncate text-dim">{value}</dd>
    </span>
  )
}

/**
 * Fit, or 1:1.
 *
 * A screenshot off a 1080 × 2400 phone is taller than any window it will ever
 * be shown in, so fitting it is the only way to see the whole screen — and
 * fitting it also shrinks the text on that screen past reading. Both are
 * needed, and neither is a default that works for both questions, so it is a
 * toggle: fit to judge the layout, 1:1 to read the words in it.
 */
function ImageStage({ src, alt }: { src: string; alt: string }) {
  const [actualSize, setActualSize] = useState(false)

  return (
    <div className={`relative size-full ${actualSize ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden'}`}>
      <img
        src={src}
        alt={alt}
        className={actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
      />
      <Button
        size="icon"
        variant="ghost"
        onClick={() => setActualSize((v) => !v)}
        aria-label={actualSize ? 'Fit to window' : 'Actual size'}
        title={actualSize ? 'Fit to window' : 'Actual size'}
        // Sticky rather than absolute so the button stays reachable once the
        // container is scrolling a 1:1 image larger than the stage.
        className="sticky bottom-3 left-[calc(100%-3rem)] z-10 bg-panel/80 text-text backdrop-blur hover:bg-panel"
      >
        {actualSize ? <MagnifyingGlassMinusIcon className="size-4" aria-hidden /> : <MagnifyingGlassPlusIcon className="size-4" aria-hidden />}
      </Button>
    </div>
  )
}

/** An apk, a log, a zip: there is nothing to show, so the dialog says what the file is instead of drawing an empty frame. */
function NoPreview({ item }: { item: FileItem }) {
  const kind = previewKindOf(item)
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      {kind === 'audio' ? <SpeakerHighIcon className="size-8 text-faint" aria-hidden /> : <FileIcon className="size-8 text-faint" aria-hidden />}
      <p className="text-[12.5px] text-dim">No preview for this kind of file</p>
      <p className="text-[11.5px] text-faint">{item.mimeType ?? fileExtOf(item) ?? 'unknown type'} · download it to open it</p>
    </div>
  )
}
