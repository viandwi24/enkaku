"use client"

import * as React from "react"

import { cn } from "../lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-row", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("sticky top-0 z-10 bg-panel-2 [&_tr]:border-b [&_tr]:border-line", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-line bg-panel-2 font-medium", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-muted-2 transition-colors hover:bg-hover data-[state=selected]:bg-accent-soft data-[state=selected]:shadow-selected-row",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-[38px] px-2 text-left align-middle text-label font-medium whitespace-nowrap text-faint [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

/**
 * Cells WRAP, unlike shadcn's default.
 *
 * The upstream default is `whitespace-nowrap`, which suits a dashboard of
 * short values and is wrong for this product: a failed job's error, a plugin's
 * verify failure, and a connector's status message are all long, and under
 * `nowrap` a single one of them runs on forever and pushes every other column
 * off the screen. Three call sites had already grown their own workaround for
 * it — `whitespace-pre-wrap break-words` on the plugins page, `max-w-xs
 * truncate` in settings, and a `line-clamp-1` on the jobs page that did
 * nothing at all, because clamping needs text that is allowed to wrap. Three
 * patches for one primitive's default is the primitive's problem.
 *
 * `wrap-anywhere` (`overflow-wrap: anywhere`) is here for the unbroken strings
 * this product is full of — device serials, workspace paths, and error
 * messages quoting a URL the script typed. It is deliberately NOT
 * `break-words`, which was the first attempt and was not enough: both allow a
 * long word to break when rendered, but only `anywhere` reduces the cell's
 * MIN-CONTENT width. A table sizes its columns from min-content, so under
 * `break-words` a 300-character unbroken string still widened the column and
 * pushed every other one off screen — the exact symptom the wrap change was
 * made to fix, reported again with a screenshot of an error quoting a
 * repeated hostname.
 *
 * A column of short readouts that looks better on one line asks for
 * `whitespace-nowrap` itself; `TableHead` keeps it, since a wrapped header is
 * never what anyone wants.
 */
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle text-body wrap-anywhere [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-meta text-faint", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
