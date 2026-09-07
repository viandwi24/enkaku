'use client'

import { useState } from 'react'
import type { Target } from '@enkaku/protocol'
import { CaretDownIcon, TagIcon, XIcon, cn } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'
import type { ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import type { DeviceInfo } from '@enkaku/protocol'
import { LabelAssign } from '@/components/labels/LabelAssign'
import { ActionMenu } from './ActionMenu'

/**
 * The floating pair (design handoff, "Bulk actions (floating, bottom-right of
 * the panel)"; plan 214 §4.12) — click-to-open, never always-expanded.
 */
export function BulkPill({
  count,
  target,
  devices,
  onLabelsChanged,
  onClear,
}: {
  count: number
  target: Target
  /** The selected devices as live rows — `LabelAssign` shows a per-label answer across them, not a boolean. */
  devices: DeviceInfo[]
  /** A label was created or a count moved, so the caller's own list is stale. */
  onLabelsChanged: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  useOverlay('menu', open, () => setOpen(false))

  const handleDone = (verb: ActionDialogVerb) => {
    setOpen(false)
    if (verb === 'forget') onClear()
  }

  return (
    <div className="absolute right-[14px] bottom-[14px] z-30 flex items-center gap-2" data-menu-root="1">
      {open && (
        <div className="absolute right-0 bottom-[52px] w-[226px] rounded-card bg-panel p-1 shadow-menu">
          <div className="flex items-center justify-between px-[10px] py-1.5">
            <span className="text-meta text-faint">Bulk action</span>
            <button type="button" className="text-meta text-accent" onClick={onClear}>
              Clear
            </button>
          </div>
          {/*
            Labels, where an operator selecting devices actually looks for it.

            The same panel the right-click menu has always shown, and the same
            multi-device contract: right-clicking a device inside a selection
            already targeted the whole selection, so bulk labelling WORKED —
            it was simply absent from the "N selected" pill, which is the
            surface built for acting on a selection (owner, 2026-09-07).
          */}
          <button
            type="button"
            onClick={() => setLabelsOpen((v) => !v)}
            className={cn(
              'flex w-full items-center gap-2 rounded-button px-[10px] py-2 text-left text-body text-text hover:bg-muted',
              labelsOpen && 'bg-muted',
            )}
          >
            <TagIcon className="size-4 text-faint" aria-hidden />
            <span className="flex-1">Labels</span>
          </button>
          {labelsOpen && (
            <div
              className="mt-1 rounded-card border border-border-2 bg-panel p-1 shadow-panel-2"
              // The panel stays open across many ticks; a click inside it must
              // not reach the menu behind and close everything.
              onClick={(e) => e.stopPropagation()}
            >
              <LabelAssign devices={devices} onChanged={onLabelsChanged} onDone={() => setLabelsOpen(false)} />
            </div>
          )}
          <ActionMenu target={target} onDone={handleDone} />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-2 rounded-pill bg-accent px-4 text-body font-medium text-on-accent shadow-bulk-pill"
      >
        {count} selected
        <CaretDownIcon className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="flex size-10 items-center justify-center rounded-pill border border-border-2 bg-panel text-faint transition-colors hover:border-danger hover:text-danger"
      >
        <XIcon className="size-4" aria-hidden />
      </button>
    </div>
  )
}
