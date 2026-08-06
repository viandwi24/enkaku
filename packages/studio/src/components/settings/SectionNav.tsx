'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SettingsSection {
  id: string
  title: string
  /** Rendered when the section is active. */
  render(): ReactNode
  /** Hidden entirely when false — e.g. a section whose feature is switched off farm-wide. */
  visible?: boolean
  /**
   * Plan 73 §3.4, §4.4 — an optional heading the nav renders above a run of
   * CONSECUTIVE sections that share it, in declaration order (Devices ·
   * Jobs · AI Agents · Farm on the Settings page). Purely additive: a
   * section that declares no `group` renders exactly as it did before this
   * existed — one flat list of tabs, no headings anywhere — which is what
   * keeps plan 46's own tests (none of which ever set this field) passing
   * unedited, and is why the device page's and the agent editor's own
   * (ungrouped) section lists need no changes here at all.
   */
  group?: string
}

/**
 * The section actually shown. `active` falls back to the first visible
 * section whenever it names none of them (missing, stale, or a typo in a
 * hand-edited URL) — a section is always rendered, never a blank pane
 * (plan 46 §3.4, §6.4).
 */
export function resolveActiveSection(sections: SettingsSection[], active: string): SettingsSection | undefined {
  const visible = sections.filter((s) => s.visible !== false)
  return visible.find((s) => s.id === active) ?? visible[0]
}

/**
 * The section one arrow-key press away from `active`, wrapping at either
 * end and skipping hidden sections. Used for both axes — Up/Down in the
 * vertical (wide) layout, Left/Right in the collapsed horizontal-scroller
 * layout (plan 46 §4.1) — since the underlying order is the same list
 * either way, only the CSS direction differs.
 */
export function adjacentSectionId(
  sections: SettingsSection[],
  active: string,
  direction: 1 | -1,
): string | undefined {
  const visible = sections.filter((s) => s.visible !== false)
  if (visible.length === 0) return undefined
  const current = visible.findIndex((s) => s.id === active)
  const from = current === -1 ? 0 : current
  const next = (from + direction + visible.length) % visible.length
  return visible[next]?.id
}

/**
 * Vertical section navigation for a settings surface with more than a
 * handful of fields (plan 46). A two-column grid — a narrow left column of
 * tabs, a content column — that collapses to a single column below ~640px
 * with the tab list becoming a horizontal scroller, because a fixed-width
 * side column leaves nothing for the form on a phone (§4.1).
 *
 * Full keyboard and ARIA support is not optional here: the current form
 * this replaces is entirely keyboard-navigable, and a mouse-only tab strip
 * would be a regression against it.
 */
export function SectionNav({
  sections,
  active,
  onChange,
}: {
  sections: SettingsSection[]
  active: string
  onChange(id: string): void
}): ReactNode {
  const visible = sections.filter((s) => s.visible !== false)
  const resolved = resolveActiveSection(sections, active)

  const move = (direction: 1 | -1) => {
    const id = adjacentSectionId(sections, resolved?.id ?? active, direction)
    if (!id) return
    onChange(id)
    // Roving tabindex means the browser's own focus does not follow the
    // selection change on its own — move it to the newly active tab so
    // arrow-key users see the focus ring where the selection actually is.
    // Guarded because this component is also called directly (no DOM) in
    // unit tests that exercise this handler.
    if (typeof document !== 'undefined') document.getElementById(`section-tab-${id}`)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      const first = visible[0]
      if (first) onChange(first.id)
    } else if (e.key === 'End') {
      e.preventDefault()
      const last = visible[visible.length - 1]
      if (last) onChange(last.id)
    }
  }

  // Consecutive sections sharing a `group` (declaration order) become one run under a heading;
  // `null` is its own run of one-or-more UNGROUPED sections, rendered with no heading at all. When
  // nothing declares `group`, this is exactly one run of `null` holding every visible section —
  // which is why the "no groups" branch below renders byte-identical to the pre-grouping markup.
  const runs: { group: string | null; items: SettingsSection[] }[] = []
  for (const s of visible) {
    const g = s.group ?? null
    const last = runs[runs.length - 1]
    if (last && last.group === g) last.items.push(s)
    else runs.push({ group: g, items: [s] })
  }
  const hasGroups = runs.some((r) => r.group !== null)

  const tab = (s: SettingsSection) => {
    const isActive = resolved?.id === s.id
    return (
      <button
        key={s.id}
        type="button"
        role="tab"
        id={`section-tab-${s.id}`}
        aria-selected={isActive}
        aria-controls={`section-panel-${s.id}`}
        tabIndex={isActive ? 0 : -1}
        onClick={() => onChange(s.id)}
        onKeyDown={onKeyDown}
        className={cn(
          'shrink-0 rounded-md px-3 py-2 text-left text-[13px] transition-colors sm:w-full',
          isActive
            ? 'bg-surface-2 font-medium text-fg'
            : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
        )}
      >
        {s.title}
      </button>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
        className="flex gap-1 overflow-x-auto pb-1 sm:flex-col sm:overflow-visible sm:pb-0"
      >
        {hasGroups
          ? runs.map((r, i) => (
              <div key={r.group ?? `ungrouped-${i}`} className="contents sm:block">
                {r.group && <p className="rack-label px-3 pb-1 pt-3 text-fg-subtle first:pt-0">{r.group}</p>}
                {r.items.map(tab)}
              </div>
            ))
          : visible.map(tab)}
      </div>
      <div
        role="tabpanel"
        id={resolved ? `section-panel-${resolved.id}` : undefined}
        aria-labelledby={resolved ? `section-tab-${resolved.id}` : undefined}
        tabIndex={0}
        className="min-w-0"
      >
        {resolved?.render()}
      </div>
    </div>
  )
}
