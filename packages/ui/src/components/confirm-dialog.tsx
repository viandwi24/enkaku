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
            <div className="text-row leading-relaxed text-dim">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/*
            The variant, not a hand-written copy of it. Spelling the
            destructive colours out here left the button carrying BOTH these
            classes and the default variant's, and the stylesheet — not the
            intent — picked the winner: red background, near-black
            `text-on-accent` text, a button that reads as disabled while being
            perfectly clickable (owner, 2026-09-05).
          */}
          <AlertDialogAction
            disabled={busy}
            variant={destructive ? 'destructive' : 'default'}
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
