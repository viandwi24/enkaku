'use client'

import { useEffect, useRef, useState } from 'react'
import type { ActionResponse, ActionResult, DeviceInfo, GroupInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, cn, describeApiError } from '@enkaku/ui'
import { toast } from 'sonner'
import { useOverlay } from '@/lib/overlays'
import { groupResults, runAction } from '@/lib/actions'
import { detachOperation, dismissOperation, getOperation, trackOperation, useOperation, whenSettled } from '@/lib/operations'
import { DevicePicker } from '@/components/target/DevicePicker'
import { useTarget, type TargetContext } from '@/components/target/useTarget'
import { ActionOutcome } from './ActionOutcome'
import type { VerbDialogSpec } from './verb-dialogs'

/**
 * The one shell (§4.4). It is the only file in the workspace that renders
 * `<DevicePicker>` inside a dialog — `DevicePickerDialog` (`components/host`)
 * is the other, non-verb consumer of the picker (§4.10) — which is what
 * makes "the same container at the same position in every modal" a
 * structural fact rather than a convention.
 */
export function ActionDialog<P>({
  spec,
  ctx,
  prefill,
  devices,
  groups,
  onClose,
}: {
  spec: VerbDialogSpec<P>
  ctx: TargetContext
  /** Seeds the verb's own draft on open (a script id, a package name) — MVP 07 §2.1. */
  prefill?: Record<string, unknown>
  devices: DeviceInfo[]
  groups: GroupInfo[]
  onClose: () => void
}) {
  const target = useTarget({ devices, groups, initial: ctx, maxTargets: spec.maxTargets })
  const [value, setValue] = useState<P>(() => (prefill ? { ...spec.initial, ...prefill } : spec.initial))
  const [results, setResults] = useState<ActionResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * The operation this dialog is watching, once the core has accepted the
   * work and gone away to do it. Held in the shared store rather than here,
   * so closing this dialog hands the work over instead of orphaning it.
   */
  const [opId, setOpId] = useState<string | null>(null)
  const tracked = useOperation(opId)
  const opRef = useRef<string | null>(null)
  opRef.current = opId

  // Any way out while work is still running — Minimise, Cancel, Escape, the X
  // — is the same act: the dialog stops watching and the tray starts. One
  // unmount handler rather than four call sites, so no route out of this
  // dialog can forget.
  useEffect(() => {
    return () => {
      if (opRef.current) detachOperation(opRef.current)
    }
  }, [])

  // Rule 4 (§4.4): Escape closes through the shell's own tier stack, not
  // through Radix's own DismissableLayer — `onEscapeKeyDown` below prevents
  // that.
  useOverlay('window', true, onClose)

  const label = busy
    ? 'Working…'
    : target.needsForce
      ? `Continue for ${target.warnedIds.length} device${target.warnedIds.length === 1 ? '' : 's'}`
      : spec.submitLabel(target.count)

  async function submit(force: boolean) {
    if (!target.target) return
    setBusy(true)
    try {
      const params = await spec.toParams(value)
      const res: ActionResponse = await runAction(spec.verb, target.target, params as never, { force })
      let final = res.results
      target.applyResults(final)
      setResults(final)
      if (final.some((r) => r.status === 'accepted')) {
        // Hand it to the store BEFORE awaiting it: from here on the work
        // belongs to the operation, not to this component, and the operator
        // can walk away from the modal without losing it.
        trackOperation({ id: res.operationId, verb: spec.verb, title: spec.title(target.count), results: final, visible: false })
        setOpId(res.operationId)
        final = (await whenSettled(res.operationId)).results
        // Still ours means still on screen: the outcome is about to be shown
        // right here, so the tray does not also need a card for it. Minimised
        // means the operator is watching the card instead — leave it alone.
        if (getOperation(res.operationId)?.visible === false) dismissOperation(res.operationId)
        setOpId(null)
        target.applyResults(final)
        setResults(final)
      }
      const grouped = groupResults(final)
      spec.onDone?.(res, grouped)
      if (grouped.failed.length === 0 && grouped.forbidden.length === 0 && grouped.warned.length === 0) onClose()
    } catch (err) {
      toast.error(describeApiError(err))
    } finally {
      setBusy(false)
    }
  }

  const Fields = spec.Fields

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* `p-0 gap-0`: `DialogContent`'s own `p-6 gap-4` would put 24px of
          padding and a 16px gap between the title and the picker, and MVP 07
          §2.1 says "flush under the modal title, with nothing between the
          title and the picker". Every band below sets its own padding. */}
      {/*
        `flex flex-col overflow-hidden` overrides `DialogContent`'s own
        `grid ... overflow-y-auto`. The primitive scrolls its whole body,
        and the form band below scrolled too, so a tall form produced TWO
        nested scrollbars — one moving the picker and title out of view, one
        moving the fields (owner, 2026-09-04). A modal has one scrolling
        region: the header, the picker and the footer are fixed, and only the
        form moves. Changed here rather than in the primitive, since other
        dialogs are short and legitimately scroll as a whole.
      */}
      <DialogContent
        className={cn('flex w-full max-h-[90dvh] flex-col gap-0 overflow-hidden p-0', spec.wide ? 'sm:max-w-[820px]' : 'sm:max-w-[520px]')}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-none px-[14px] pt-[14px] pb-[10px]">
          <DialogTitle>{spec.title(target.count)}</DialogTitle>
        </DialogHeader>

        {/* 1. The picker. Its own container, its own surface, full width, and
               the FIRST child after the title in every single dialog. */}
        <DevicePicker state={target} />

        {/* 2. The form. A separate container, below the picker's own
               `border-b border-line` divider, on `bg-panel`, with no border
               of its own: "The two never share a background or a border." */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-panel px-[14px] py-3">
          {Fields ? <Fields value={value} onChange={setValue} target={target} /> : spec.note ? <p className="text-body text-dim">{spec.note}</p> : null}
          {(tracked?.results ?? results) && <ActionOutcome results={tracked?.results ?? results ?? []} devices={devices} />}
        </div>

        <DialogFooter className="flex-none border-t border-line px-[14px] py-3">
          {/* While the core is working, Cancel would be a lie — nothing here
              can call the install back. The honest verb is Minimise: the work
              carries on and moves to the tray in the corner (CEO,
              2026-09-05). */}
          <Button variant="outline" onClick={onClose}>
            {opId ? 'Minimise' : 'Cancel'}
          </Button>
          <Button
            variant={spec.destructive ? 'destructive' : 'default'}
            disabled={busy || target.count === 0 || target.allForbidden || !spec.canSubmit(value)}
            onClick={() => void submit(target.needsForce)}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
