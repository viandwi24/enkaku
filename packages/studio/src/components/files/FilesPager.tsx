'use client'

import { Button, CaretLeftIcon, CaretRightIcon } from '@enkaku/ui'
import { pagerItems } from './files-view'

/**
 * The Files screen's pager (owner, 2026-09-20 — "tolong menu /files itu
 * dibuat pagination yah").
 *
 * Numbered pages, not a Load more button. The two are not interchangeable: the
 * rest of Studio pages a TIMELINE (jobs, runs — always newest first, always
 * read from the top, so a growing list is the right shape), and this is a
 * LIBRARY, sorted by whatever the operator picked. "The third page of largest
 * first" is a place you go back to; "twelve more" is not.
 *
 * It renders nothing at all for a single page. A pager under a library of nine
 * files is a control that can only ever say "1".
 */
export function FilesPager({
  page,
  pages,
  total,
  shownFrom,
  shownTo,
  onPage,
}: {
  page: number
  pages: number
  /** Files in the filtered list — the number the range below counts against. */
  total: number
  /** 1-based, inclusive, for the "21–40 of 137" line. */
  shownFrom: number
  shownTo: number
  onPage: (page: number) => void
}) {
  if (pages <= 1) return null

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 py-1" aria-label="File pages">
      <p className="text-[12px] text-faint">
        {shownFrom}–{shownTo} of {total}
      </p>
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <CaretLeftIcon className="size-3.5" aria-hidden />
        </Button>
        {pagerItems(page, pages).map((entry, i) =>
          entry === null ? (
            // A gap, not a button: the pages it stands for are reachable from
            // whichever neighbour you land on.
            <span key={`gap-${i}`} className="px-1 text-[12px] text-faint" aria-hidden>
              …
            </span>
          ) : (
            <Button
              key={entry}
              size="icon-sm"
              variant={entry === page ? 'secondary' : 'ghost'}
              active={entry === page}
              onClick={() => onPage(entry)}
              aria-label={`Page ${entry}`}
              aria-current={entry === page ? 'page' : undefined}
              className="tabular-nums"
            >
              {entry}
            </Button>
          ),
        )}
        <Button size="icon-sm" variant="ghost" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
          <CaretRightIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
    </nav>
  )
}
