'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@enkaku/ui'

/**
 * Plan 93 §3.14 guards 2 and the acknowledgement, step 93.7 — a SCALE
 * confirmation, never a security control (the code comment beside the
 * server's own check says the identical thing, `api/command-runs.ts`):
 * confirming the blast radius, not the system judging the command. Opened
 * by the console page only when at least one of two things is true —
 * the target is above `shell.fanoutConfirmThreshold`, or the command
 * matches the shared high-consequence guard AND targets more than one
 * device (property 2 of this step's brief: at N = 1 that guard never fires
 * at all, on the server or here).
 */
export function ConfirmFanout({
  open,
  onOpenChange,
  cmd,
  targetCount,
  threshold,
  highConsequence,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cmd: string
  targetCount: number
  /** `shell.fanoutConfirmThreshold` (default 5). 0 means "always ask". */
  threshold: number
  highConsequence: { hit: boolean; pattern?: string } | null
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const requireTyped = targetCount > threshold
  const canConfirm = !requireTyped || typed.trim() === String(targetCount)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Run on {targetCount} device{targetCount === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2.5 text-[13px] leading-relaxed text-fg-muted">
              <code className="readout block rounded-md bg-surface-2 px-2 py-1.5 text-[12px] break-all text-fg">{cmd}</code>

              {highConsequence?.hit && (
                <p className="rounded-md border border-led-warn/40 bg-led-warn/5 px-2.5 py-2 text-led-warn">
                  This looks like it could affect the whole device{highConsequence.pattern ? ` (matches "${highConsequence.pattern}")` : ''} — on{' '}
                  {targetCount} devices at once. This is a scale confirmation, not a security check: the command runs exactly as typed either way.
                </p>
              )}

              {requireTyped && (
                <div className="space-y-1">
                  <Label htmlFor="confirm-fanout-count" className="text-[11.5px] text-fg-muted">
                    Type <span className="font-semibold text-fg">{targetCount}</span> to confirm the device count.
                  </Label>
                  <Input
                    id="confirm-fanout-count"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    className="h-8 w-24 text-[12.5px]"
                    autoComplete="off"
                  />
                </div>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canConfirm} onClick={onConfirm}>
            Run on {targetCount} device{targetCount === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
