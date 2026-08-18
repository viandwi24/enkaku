'use client'

import type { ReactNode } from 'react'
import { cn } from '@enkaku/ui'

/**
 * The one-of-several choice the network panel is built out of (plan 114 §3.10)
 * — the mode selector itself, and the "where is the proxy?" question inside
 * HTTP mode.
 *
 * A real `<input type="radio">` in a real `<fieldset>`, not a list of buttons
 * pretending to be one: arrow keys move between options, the group is one tab
 * stop, and a screen reader announces "2 of 3" without any `aria-*` of our
 * own. `@enkaku/ui` has no radio component (only `Select`), and a `Select`
 * is the wrong control here for a reason that is the whole point of this
 * screen — a dropdown shows one option at a time, so the sentence explaining
 * that HTTP proxy is bypassable would only ever be visible AFTER the operator
 * had already chosen it. Plan 114 §3.1 rule 1: the difference between the
 * modes is stated where the choice is made, which means every option's
 * description is on screen at once.
 *
 * `description` is a required prop, deliberately. An option with a bare title
 * is exactly how "HTTP proxy" and "VPN" end up looking like two interchangeable
 * settings.
 */
export function ChoiceGroup({
  label,
  children,
  className,
}: {
  /** Rendered as the fieldset's legend, in the same `rack-label` voice as the panel's other headings. */
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <fieldset className={cn('rounded-lg border bg-surface p-3.5', className)}>
      <legend className="rack-label px-1">{label}</legend>
      <div className="space-y-0.5">{children}</div>
    </fieldset>
  )
}

export function Choice({
  name,
  value,
  checked,
  onSelect,
  title,
  description,
  disabled = false,
}: {
  /** Shared across every `Choice` in one group — this is what makes them one radio group. Include the device id: two panels can be mounted at once (the device page tab and the popup). */
  name: string
  value: string
  checked: boolean
  onSelect: () => void
  title: string
  /** What this option actually does, and what it does not. Required — see the component's own note. */
  description: ReactNode
  /**
   * A choice that cannot be taken is genuinely disabled and still rendered
   * (docs/design.md quality floor) — never dropped from the list, which would
   * teach the operator the farm cannot do it at all.
   */
  disabled?: boolean
}) {
  const id = `${name}-${value}`
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors',
        checked ? 'border-line bg-bg' : 'border-transparent',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-line',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 size-3.5 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-fg">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-muted">{description}</span>
      </span>
    </label>
  )
}
