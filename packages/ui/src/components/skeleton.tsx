import { cn } from "../lib/utils"

/**
 * Upstream shadcn fills this with `bg-accent`, where `accent` is a muted
 * hover surface. Our tokens give that name to the brand colour instead
 * (`docs/design.md`), so the upstream default renders a placeholder as a
 * block of bright blue. It stays on a surface step — do not restore
 * `bg-accent` when resyncing this file from upstream.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-surface-3', className)}
      {...props}
    />
  )
}

export { Skeleton }
