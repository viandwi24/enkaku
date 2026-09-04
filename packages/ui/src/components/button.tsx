import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-button text-row font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-accent-soft data-[active=true]:text-accent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-accent hover:bg-accent-2",
        outline: "border border-border-2 bg-muted text-text hover:bg-muted-2",
        secondary: "bg-muted text-text hover:bg-muted-2",
        ghost: "text-faint hover:bg-muted-2 hover:text-text",
        destructive: "bg-danger-soft text-danger hover:bg-danger/15",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[34px] px-[13px]",
        sm: "h-[26px] rounded-small px-[10px] text-[12px]",
        icon: "size-8",
        "icon-sm": "size-[26px] rounded-small",
        "icon-lg": "size-[34px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  active,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** The handoff's "active (menu open or filter applied)" state for icon buttons: accent-soft / accent. */
    active?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-active={active}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
