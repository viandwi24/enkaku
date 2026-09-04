import { CircleNotchIcon } from "../icons"
import { cn } from "../lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <CircleNotchIcon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-enkaku-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
