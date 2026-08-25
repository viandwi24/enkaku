'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from './button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { cn } from '../lib/utils'

/**
 * A `<Select>` you can type into — plan 124 §3.3, §3.4, §4.3.
 *
 * ## This is not a new invention
 *
 * `packages/studio/src/components/agent/ModelCombobox.tsx` (plan 83 §3.5) is
 * the proven pattern and this is that file, generalised: the same `Popover`
 * over `cmdk`, the same `Check` mark, the same `<Command defaultValue>` trick,
 * the same "the current value is always shown" rule. Its own header states the
 * reason it replaced a `<Select>` over a `.map()`: "a connector can return
 * dozens of model ids, and a native select over that is a scroll hunt with no
 * way to type-to-find."
 *
 * That sentence describes a farm of 45 modems and 100 phones word for word,
 * which is why it moved here. `ModelCombobox` lived in `packages/studio`, and
 * a plugin UI can only import `@enkaku/ui` (plan 111 §3.3) — so the Mikrotik
 * "Add a device…" dropdown and the Proxy Manager per-row proxy select could
 * not have used it even if someone had thought to, and both shipped as
 * unsearchable Radix `Select`s over the whole fleet (plan 124 §0.2, §0.3).
 *
 * ## The four behaviours that are not optional
 *
 * Every one of them is inherited from `ModelCombobox`, and every one is a
 * behaviour a plain `<Select>` gets wrong:
 *
 * 1. **The current `value` is always present in the list and pre-highlighted**,
 *    even when it is absent from `options`. In `ModelCombobox` that covered a
 *    connector that stopped listing the configured model. Here it matters more
 *    (§3.4): a Mikrotik group can name a device that has since been forgotten,
 *    and a picker that silently drops it turns "this group points at a device
 *    that no longer exists" into "this group points at nothing", which reads
 *    as a UI that lost the setting rather than a farm that lost the phone.
 * 2. **Escape dismisses and changes nothing.** Native `cmdk`/Radix behaviour,
 *    not hand-rolled — which is precisely why it is worth not hand-rolling.
 * 3. **`error` REPLACES the list.** An empty list and a failed fetch look
 *    identical, and "no devices" is a very different statement from "we could
 *    not ask". The caller passes its fetch's own message straight through.
 * 4. **A `disabled` option renders, dimmed, with its reason, and cannot be
 *    chosen.** The farm-wide rule (plan 19 §4.4, `DevicePicker`'s own header):
 *    a thing you cannot pick stays visible with the reason, it is never
 *    silently removed — an absent row is indistinguishable from a row that
 *    never existed, and the operator goes looking for a device that is right
 *    there.
 */
export type ComboboxOption = {
  /**
   * The identity handed back to `onValueChange` — a device id, a path name, a
   * script id. It is NOT what the filter matches against on its own: nobody
   * types a uuid, so the label, the hint and `keywords` carry the searching.
   */
  value: string
  label: string
  /** Extra strings the filter matches — device number, stableId, tags. `deviceSearchTerms()` produces exactly this array. */
  keywords?: string[]
  /** Rendered under the label, dimmed — a stableId, an address, a script's group. */
  hint?: string
  disabled?: boolean
  /** Why. Rendered on the row itself; a disabled row with no stated reason is the failure this prop exists to prevent. */
  disabledReason?: string
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Filter…',
  emptyText = 'No match.',
  error = null,
  disabled,
  align = 'start',
  ariaLabel,
  className,
  triggerClassName,
  renderOption,
}: {
  value: string
  onValueChange(value: string): void
  options: ComboboxOption[]
  /** Trigger text when `value` is empty. */
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Replaces the list. Never an empty list that looks like "none" — see behaviour 3 above. */
  error?: string | null
  disabled?: boolean
  align?: 'start' | 'end'
  /**
   * The trigger's accessible name. Not in plan 124 §4.3's sketch, added here
   * because a combobox whose only visible text is its current value has no
   * accessible name at all otherwise — and because `ModelCombobox`'s tests
   * find it by `getByRole('combobox', { name: 'Model' })`, which is the right
   * way for a test to find it and would be impossible without this.
   */
  ariaLabel?: string
  /** Applied to the dropdown panel — its width, mostly. */
  className?: string
  /** Applied to the trigger button. */
  triggerClassName?: string
  /** Replaces the default label/hint/reason stack inside a row. The `Check` mark stays. */
  renderOption?(option: ComboboxOption): ReactNode
}) {
  const [open, setOpen] = useState(false)

  /**
   * Behaviour 1. The synthetic entry is labelled with the raw `value` because
   * that is genuinely all we know about it — the whole point is that it is not
   * in `options`, so there is no label to look up. A caller that can do better
   * (a Mikrotik group that remembers the forgotten device's last known label)
   * passes it in `options` itself with a `disabled` + `disabledReason`, which
   * is strictly the better shape and is why this fallback stays this dumb.
   */
  const merged = useMemo(() => {
    if (!value || options.some((o) => o.value === value)) return options
    return [{ value, label: value }, ...options]
  }, [options, value])

  const selected = merged.find((o) => o.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('w-full justify-between gap-2 font-normal', triggerClassName)}
        >
          <span className={cn('truncate', selected ? undefined : 'text-fg-subtle')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className={cn('w-(--radix-popover-trigger-width) min-w-64 p-0', className)}>
        {/* `defaultValue` pre-highlights the CURRENT selection the instant the
            list opens — `cmdk` otherwise highlights the first row, so Enter on
            a freshly opened list would change the value instead of confirming
            it. `|| undefined` because an empty string is not "no default" to
            `cmdk`; it is a default that matches nothing. */}
        <Command defaultValue={value || undefined}>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            {error ? (
              <div className="px-3 py-4 text-[12px] text-fg-subtle">{error}</div>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {merged.map((o) => (
                    <CommandItem
                      key={o.value}
                      value={o.value}
                      keywords={keywordsFor(o)}
                      disabled={o.disabled}
                      /**
                       * `cmdk` hands `onSelect` its OWN copy of the item value
                       * — trimmed, and derived from `children` rather than
                       * from this prop if the prop is ever dropped.
                       * `ModelCombobox` passed that argument straight through.
                       * The closure's `o.value` is used here instead so the
                       * caller gets back exactly the string it put in, with no
                       * dependence on how the primitive derives or normalises
                       * it; a device id is an identity, not a display string.
                       */
                      onSelect={() => {
                        if (o.disabled) return
                        onValueChange(o.value)
                        setOpen(false)
                      }}
                    >
                      <Check className={cn('size-3.5 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                      {renderOption ? (
                        renderOption(o)
                      ) : (
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{o.label}</span>
                          {o.hint && <span className="block truncate text-[11px] text-fg-subtle">{o.hint}</span>}
                          {o.disabled && o.disabledReason && (
                            <span className="block truncate text-[11px] text-fg-subtle">{o.disabledReason}</span>
                          )}
                        </span>
                      )}
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

/**
 * What the filter actually matches a row against, beside its `value`.
 *
 * The label leads because it is what an operator types first; the hint is
 * included because a stableId shown on the row is a string the operator can
 * see and would reasonably expect to be searchable. Empties are dropped: an
 * empty keyword scores every row identically in `cmdk` and would turn the
 * filter off for the whole list.
 */
function keywordsFor(o: ComboboxOption): string[] {
  return [o.label, o.hint, ...(o.keywords ?? [])].filter((k): k is string => typeof k === 'string' && k.length > 0)
}
