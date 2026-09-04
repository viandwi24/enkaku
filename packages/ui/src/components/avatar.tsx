import * as React from "react"

import { cn } from "../lib/utils"

/**
 * The 30px initials chip (plan 204 §4.6). New: `@enkaku/ui` had no avatar
 * before this plan (G9). No radix — it renders nothing interactive.
 */
function Avatar({
  initials,
  className,
  ...props
}: React.ComponentProps<"span"> & { initials: string }) {
  return (
    <span
      data-slot="avatar"
      className={cn(
        "inline-flex size-[30px] shrink-0 select-none items-center justify-center rounded-pill bg-avatar-bg text-label font-semibold text-avatar-fg",
        className
      )}
      {...props}
    >
      {initials}
    </span>
  )
}

export { Avatar }
