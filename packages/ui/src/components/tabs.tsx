"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "../lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

/**
 * `line` renders exactly as `default` (plan 204 §3.6, §4.6): two plugin
 * views name it and are re-authored under §9 Q2. `pill` is the only variant
 * with its own container styling; `default`/`line`/`compact` differ only on
 * the trigger.
 */
const tabsListVariants = cva("group/tabs-list inline-flex w-fit items-center gap-1", {
  variants: {
    variant: {
      default: "",
      line: "",
      compact: "",
      pill: "max-w-full overflow-x-auto rounded-pill bg-muted p-1",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-dim transition-colors outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-accent-soft data-[state=active]:text-accent [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=default]/tabs-list:rounded-input group-data-[variant=default]/tabs-list:px-3 group-data-[variant=default]/tabs-list:py-[7px] group-data-[variant=default]/tabs-list:text-row",
        "group-data-[variant=line]/tabs-list:rounded-input group-data-[variant=line]/tabs-list:px-3 group-data-[variant=line]/tabs-list:py-[7px] group-data-[variant=line]/tabs-list:text-row",
        "group-data-[variant=compact]/tabs-list:rounded-chip group-data-[variant=compact]/tabs-list:px-[10px] group-data-[variant=compact]/tabs-list:py-1 group-data-[variant=compact]/tabs-list:text-[12px]",
        "group-data-[variant=pill]/tabs-list:rounded-pill group-data-[variant=pill]/tabs-list:px-[14px] group-data-[variant=pill]/tabs-list:py-[7px] group-data-[variant=pill]/tabs-list:text-body group-data-[variant=pill]/tabs-list:data-[state=active]:bg-panel group-data-[variant=pill]/tabs-list:data-[state=active]:font-semibold group-data-[variant=pill]/tabs-list:data-[state=active]:text-text group-data-[variant=pill]/tabs-list:data-[state=active]:shadow-active-pill",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
