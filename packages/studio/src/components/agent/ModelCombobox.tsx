'use client'

import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@enkaku/ui'

/**
 * Plan 83 §3.5, §4.4 — the model selector replaces a plain `<Select>` over a
 * `.map()`: a connector can return dozens of model ids, and a native select
 * over that is a scroll hunt with no way to type-to-find. This is a
 * combobox instead — `components/ui/command` (already in the repo, plan 78
 * §4.4) over `components/ui/popover` — text filter, arrow-key navigation,
 * Enter to choose, Escape to dismiss and change nothing (all native `cmdk`
 * behaviour, not hand-rolled here).
 *
 * `value` is always shown and pre-highlighted, even when it is not (or no
 * longer) in `options` — a connector that stopped listing the currently
 * configured model must not make it disappear from view (criterion 13).
 *
 * `error`, when set, replaces the list with a failed-state message instead
 * of rendering an empty one indistinguishable from "no models" (criterion
 * 8/§3.3) — the caller (`Chat.tsx`) passes it straight through from the
 * `/api/connectors/:id/models` fetch's own catch.
 */
export function ModelCombobox({
  value,
  options,
  onValueChange,
  disabled,
  error,
}: {
  value: string
  options: string[]
  onValueChange(v: string): void
  disabled?: boolean
  error?: string | null
}) {
  const [open, setOpen] = useState(false)
  const merged = [...new Set([value, ...options])]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Model"
          disabled={disabled}
          className="h-8 justify-between gap-1 rounded-md border-none bg-transparent px-2 font-medium text-fg-muted shadow-none hover:bg-surface-2 hover:text-fg aria-expanded:bg-surface-2 aria-expanded:text-fg"
        >
          <span className="readout max-w-40 truncate">{value || 'Select a model'}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {/* `defaultValue` pre-highlights the CURRENT model the instant the list opens (criterion
            13) — cmdk otherwise defaults to highlighting the first item in the list, which is not
            necessarily the one already selected. */}
        <Command defaultValue={value}>
          <CommandInput placeholder="Filter models…" />
          <CommandList>
            {error ? (
              <div className="px-3 py-4 text-[12px] text-fg-subtle">The model list failed to load — {error}</div>
            ) : (
              <>
                <CommandEmpty>No matching model.</CommandEmpty>
                <CommandGroup>
                  {merged.map((id) => (
                    <CommandItem
                      key={id}
                      value={id}
                      onSelect={(v) => {
                        onValueChange(v)
                        setOpen(false)
                      }}
                    >
                      <Check className={cn('size-3.5', id === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                      <span className="readout truncate">{id}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
