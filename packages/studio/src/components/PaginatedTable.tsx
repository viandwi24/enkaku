'use client'

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { EmptyState, ErrorState, LoadingRows, Button, Table, TableBody, TableHeader, TableRow } from '@enkaku/ui'

/**
 * The one keyset envelope every list endpoint returns (plan 30 §3.3, §4.1).
 * Kept in sync with `packages/core/src/api/pagination.ts` — this is the
 * client-side mirror of the same shape, not a re-export, because Studio
 * cannot import across the core/studio package boundary.
 */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number | null
}

export interface PaginatedTableHandle<T> {
  /**
   * Prepend a live row without disturbing the cursor — the cursor only ever
   * moves backwards in time, so a live row is never counted against it
   * (plan 30 §3.5). If a row with the same key is already loaded, it is
   * replaced in place instead of duplicated.
   */
  pushLive: (row: T) => void
  /**
   * Same replace-in-place rule as `pushLive`, but for a WS payload that only
   * carries a partial row (e.g. `batch.status` sends `{ id, status, counts }`,
   * not a full `BatchInfo`) — merged onto the existing row instead of ever
   * being prepended as an incomplete one. A key not currently loaded is a
   * no-op, same as before this component existed.
   */
  mergeLive: (key: string, patch: Partial<T>) => void
  /** Re-fetches from the start, discarding whatever was loaded. */
  reload: () => void
}

interface EmptyProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
}

interface PaginatedTableProps<T> {
  /** Called with the current cursor (null for the first page). */
  fetchPage: (cursor: string | null) => Promise<Page<T>>
  /** A stable identity for each row — also the live-row dedupe key (plan 30 §3.5). */
  rowKey: (row: T) => string
  /** The `<TableRow>` of `<TableHead>` cells. */
  header: ReactNode
  /** The `<TableCell>`s for one row — wrapped in a `<TableRow>` automatically. */
  renderRow: (row: T) => ReactNode
  empty: EmptyProps
  /** 'button' (default) or 'scroll' for log-like views (plan 30 §4.3). */
  loadMore?: 'button' | 'scroll'
  /** Changing this re-fetches from the start (e.g. a status filter). */
  resetKey?: unknown
  /**
   * Transforms the currently loaded rows for display — reordering (e.g.
   * running jobs first) or narrowing (e.g. a client-side search box over
   * what is already loaded). Purely a presentation choice over data already
   * fetched — it does not change what is fetched or how paging works, so it
   * stays within plan 30's "pagination only" non-goal.
   */
  sort?: (items: T[]) => T[]
  /** Shown instead of an empty table body when `sort` narrows a non-empty load down to nothing (e.g. "Nothing matches"). */
  emptyFiltered?: EmptyProps
  className?: string
}

function PaginatedTableInner<T>(
  {
    fetchPage,
    rowKey,
    header,
    renderRow,
    empty,
    loadMore = 'button',
    resetKey,
    sort,
    emptyFiltered,
    className,
  }: PaginatedTableProps<T>,
  ref: React.ForwardedRef<PaginatedTableHandle<T>>,
) {
  const [items, setItems] = useState<T[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Guards a scroll-triggered fetch from firing twice for one scroll event.
  const fetchingRef = useRef(false)

  const load = useCallback(
    (cursor: string | null) => {
      setError(null)
      if (cursor === null) setItems(null)
      else setLoadingMore(true)
      fetchingRef.current = true
      fetchPage(cursor)
        .then((page) => {
          setItems((prev) => (cursor === null ? page.items : [...(prev ?? []), ...page.items]))
          setNextCursor(page.nextCursor)
          setTotal(page.total)
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          setLoadingMore(false)
          fetchingRef.current = false
        })
    },
    [fetchPage],
  )

  useEffect(() => {
    load(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  useImperativeHandle(
    ref,
    () => ({
      pushLive: (row) => {
        setItems((prev) => {
          if (!prev) return prev
          const key = rowKey(row)
          const i = prev.findIndex((r) => rowKey(r) === key)
          if (i === -1) return [row, ...prev]
          const next = [...prev]
          next[i] = row
          return next
        })
      },
      mergeLive: (key, patch) => {
        setItems((prev) => {
          if (!prev) return prev
          const i = prev.findIndex((r) => rowKey(r) === key)
          if (i === -1) return prev
          const next = [...prev]
          next[i] = { ...next[i]!, ...patch }
          return next
        })
      },
      reload: () => load(null),
    }),
    [load, rowKey],
  )

  const loadMoreNow = () => {
    if (nextCursor === null || loadingMore) return
    load(nextCursor)
  }

  function onScroll() {
    if (loadMore !== 'scroll' || fetchingRef.current) return
    const el = scrollRef.current
    if (!el || nextCursor === null) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadMoreNow()
  }

  if (error && items === null) {
    return <ErrorState message={error} onRetry={() => load(null)} />
  }
  if (items === null) {
    return <LoadingRows rows={4} />
  }
  if (items.length === 0) {
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description ?? ''} action={empty.action} />
  }

  const displayItems = sort ? sort(items) : items

  if (displayItems.length === 0 && emptyFiltered) {
    return <EmptyState icon={emptyFiltered.icon} title={emptyFiltered.title} description={emptyFiltered.description ?? ''} action={emptyFiltered.action} />
  }

  const body = (
    <Table className={className}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">{header}</TableRow>
      </TableHeader>
      <TableBody>
        {displayItems.map((row) => (
          <TableRow key={rowKey(row)}>{renderRow(row)}</TableRow>
        ))}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-3">
      {loadMore === 'scroll' ? (
        <div ref={scrollRef} onScroll={onScroll} className="max-h-[32rem] overflow-y-auto rounded-lg border">
          {body}
          {loadingMore && (
            <div className="px-3.5 py-2">
              <LoadingRows rows={1} />
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">{body}</div>
      )}

      {error && items.length > 0 && (
        <p className="text-[11.5px] text-led-danger">Could not load more: {error}</p>
      )}

      <div className="flex items-center justify-between px-0.5">
        <p className="readout text-[11px] text-fg-subtle">
          {items.length} loaded{total !== null ? ` of ${total}` : ''}
        </p>
        {loadMore === 'button' && nextCursor !== null && (
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMoreNow}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * One component owns paging for every list in Studio (plan 30 §3.4, §4.3):
 * the cursor state, the load-more control, the loading row, the empty
 * state, and the "N loaded" count. A screen supplies a fetch function and
 * the row renderer — nothing else about paging is its concern.
 */
export const PaginatedTable = forwardRef(PaginatedTableInner) as <T>(
  props: PaginatedTableProps<T> & { ref?: React.ForwardedRef<PaginatedTableHandle<T>> },
) => ReturnType<typeof PaginatedTableInner>
