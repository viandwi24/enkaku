import type { ReactNode } from 'react'

/**
 * Page head: the title answers "where am I", the right side carries the one
 * primary action. Every screen uses it so the position never moves.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  titlePill = false,
}: {
  title: string
  description?: string
  actions?: ReactNode
  meta?: ReactNode
  /**
   * Plan 101 §5 step 101.8 (owner-specified, 2026-08-16) — `refs/ui`'s own
   * Devices header renders `Devices | <count>` as ONE floating pill object,
   * not a heading beside a separate badge. This is the one optional prop
   * that lets a single screen opt into that shape without forking
   * `PageHeader` itself: the other 26 callers pass nothing and render
   * byte-for-byte what they always have (the sticky bar, the plain `<h1>`,
   * `description` underneath it). When `true`, `title` and `meta` merge
   * into one pill (a 1px divider between them, `meta` omitted entirely when
   * absent) and `description` is not rendered — a floating pill has no room
   * for a subtitle line, and the one caller that uses this prop today
   * (`app/page.tsx`) does not pass one.
   */
  titlePill?: boolean
}) {
  return (
    <div className="sticky top-0 z-10 border-b bg-bg/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          {titlePill ? (
            <div className="inline-flex h-9 items-center gap-2.5 rounded-full border border-line bg-surface-2/55 px-4 text-[14px] font-semibold shadow-lg backdrop-blur-[18px] backdrop-saturate-[150%]">
              {/* A real `<h1>` (not a `<span>`) — the pill is a different
                  SHAPE for the title, not a different semantic level; every
                  other screen's `<h1>` above still answers "where am I" the
                  same way for assistive tech. */}
              <h1 className="m-0 truncate text-inherit">{title}</h1>
              {meta && (
                <>
                  <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden />
                  {meta}
                </>
              )}
            </div>
          ) : (
            <>
              <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
              {description && <p className="mt-0.5 truncate text-[12px] text-fg-muted">{description}</p>}
            </>
          )}
        </div>
        {!titlePill && meta}
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
