import * as React from "react"

import { cn } from "../lib/utils"

function Input({
  className,
  type,
  variant = "default",
  mono,
  ...props
}: React.ComponentProps<"input"> & {
  variant?: "default" | "search"
  /** Paths and addresses (plan 204 §4.6): `font-mono`. */
  mono?: boolean
}) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        "h-[34px] w-full min-w-0 rounded-input border border-border-2 bg-panel-2 px-3 text-body text-text outline-none transition-colors placeholder:text-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger file:border-0 file:bg-transparent file:text-row file:font-medium",
        variant === "search" && "rounded-button border-transparent bg-muted",
        mono && "font-mono",
        className
      )}
      {...props}
    />
  )
}

export { Input }
