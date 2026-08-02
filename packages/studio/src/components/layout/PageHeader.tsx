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
}: {
  title: string
  description?: string
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="sticky top-0 z-10 border-b bg-bg/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 truncate text-[12px] text-fg-muted">{description}</p>}
        </div>
        {meta}
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
