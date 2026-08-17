'use client'

import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog'

/**
 * Confirmation for actions that cannot be undone.
 *
 * The title must name the thing at stake ("Delete script hello-no-device@1.0.0?")
 * — a dialog that only asks "Are you sure?" helps nobody, because it never
 * says what is about to happen.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Delete',
  destructive = true,
  onConfirm,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  trigger: ReactNode
  title: string
  description: ReactNode
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => unknown
  /**
   * Controlled open state — for the (rare) case a dialog must open from
   * somewhere OTHER than its own `trigger` node, e.g. a `DropdownMenuItem`
   * (plan 83 §3.6): Radix closes the menu the instant an item is selected,
   * which would unmount a `trigger`-nested `AlertDialog` before it ever
   * showed. Omit both for the ordinary, self-contained case every existing
   * call site already uses — internal state takes over unchanged.
   */
  open?: boolean
  onOpenChange?(open: boolean): void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = onOpenChangeProp ?? setUncontrolledOpen
  const [busy, setBusy] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-[13px] leading-relaxed text-fg-muted">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={destructive ? 'bg-led-danger text-white hover:bg-led-danger/90' : undefined}
            onClick={async (e) => {
              e.preventDefault()
              setBusy(true)
              try {
                await onConfirm()
                setOpen(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
