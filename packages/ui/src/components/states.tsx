'use client'

import type { ReactNode } from 'react'
import { TrayIcon, WarningIcon } from '../icons'
import { Button } from './button'
import { Skeleton } from './skeleton'

/**
 * The states every list has to handle. Kept as components so no screen
 * invents its own — and so the empty and failed states get designed too,
 * instead of ending up as a stray line of grey text.
 *
 * Extracted from Studio (plan 111 §3.3) because "no screen invents its own"
 * has to include a plugin's screen: the first tier-C pack wrote forty lines
 * of near-identical panels, and its error state said something subtly
 * different from Studio's for the same failure. These three are the
 * difference between a plugin screen that BEHAVES like a Studio screen and
 * one that merely borrows its buttons.
 */

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-inner" />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description: ReactNode
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="rounded-card border border-dashed border-border-3 px-6 py-12 text-center">
      <div className="mx-auto mb-3 grid size-9 place-items-center rounded-pill bg-muted text-faint">
        {icon ?? <TrayIcon className="size-4" aria-hidden />}
      </div>
      <p className="text-row font-medium text-text">{title}</p>
      <div className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-faint">{description}</div>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-card border border-danger/30 bg-danger-soft px-4 py-4">
      <div className="flex items-start gap-2.5">
        <WarningIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-row font-medium text-text">Could not load</p>
          <p className="mt-0.5 break-words text-[12px] text-text-3">{message}</p>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}
