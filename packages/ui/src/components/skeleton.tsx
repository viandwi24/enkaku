import { cn } from "../lib/utils"

/**
 * Upstream shadcn fills this with `bg-accent`, where `accent` is a muted
 * hover surface. Our tokens give that name to the brand colour instead
 * (`docs/design.md`), so the upstream default renders a placeholder as a
 * block of bright green. It stays on a surface step — do not use `bg-accent`
 * here.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-inner bg-muted-2', className)}
      {...props}
    />
  )
}

export { Skeleton }
