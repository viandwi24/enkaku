import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../lib/utils"

/**
 * The handoff's task chip, status pill and state badge are one component
 * (plan 204 §4.6).
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-pill px-[9px] py-[3px] text-meta font-medium [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        /** Script running: accent-soft / accent. */
        default: "bg-accent-soft text-accent",
        /** System action: warn-soft / warn. */
        warn: "bg-warn-soft text-warn",
        /** Queued: muted-2 / dim. */
        secondary: "bg-muted-2 text-dim",
        destructive: "bg-danger-soft text-danger",
        /** The version chip: `var(--muted)`, radius 6. */
        outline: "rounded-[6px] bg-muted text-text-2",
        /** Idle: plain `faint-2` text, no pill. */
        ghost: "bg-transparent px-0 py-0 text-faint-2",
        link: "bg-transparent px-0 py-0 text-accent underline-offset-2 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
