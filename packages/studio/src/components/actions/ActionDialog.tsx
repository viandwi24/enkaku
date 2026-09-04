'use client'

import { useState } from 'react'
import type { ActionResponse, ActionResult, DeviceInfo, GroupInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, describeApiError } from '@enkaku/ui'
import { toast } from 'sonner'
import { useOverlay } from '@/lib/overlays'
import { awaitOperation, groupResults, runAction } from '@/lib/actions'
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
        final = (await awaitOperation(res.operationId)).results
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
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]" onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader className="px-[14px] pt-[14px] pb-[10px]">
          <DialogTitle>{spec.title(target.count)}</DialogTitle>
        </DialogHeader>

        {/* 1. The picker. Its own container, its own surface, full width, and
               the FIRST child after the title in every single dialog. */}
        <DevicePicker state={target} />

        {/* 2. The form. A separate container, below the picker's own
               `border-b border-line` divider, on `bg-panel`, with no border
               of its own: "The two never share a background or a border." */}
        <div className="max-h-[46dvh] space-y-3 overflow-y-auto bg-panel px-[14px] py-3">
          {Fields ? <Fields value={value} onChange={setValue} target={target} /> : spec.note ? <p className="text-body text-dim">{spec.note}</p> : null}
          {results && <ActionOutcome results={results} devices={devices} />}
        </div>

        <DialogFooter className="border-t border-line px-[14px] py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
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
