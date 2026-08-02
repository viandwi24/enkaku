import type { ReactNode } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The states every list has to handle. Kept as components so no screen
 * invents its own — and so the empty and failed states get designed too,
 * instead of ending up as a stray line of grey text.
 */

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-md" />
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
    <div className="rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="mx-auto mb-3 grid size-9 place-items-center rounded-full bg-surface-2 text-fg-muted">
        {icon ?? <Inbox className="size-4" aria-hidden />}
      </div>
      <p className="text-[13px] font-medium">{title}</p>
      <div className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-fg-muted">{description}</div>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-led-danger/40 bg-led-danger/5 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-led-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Could not load</p>
          <p className="mt-0.5 break-words text-[12px] text-fg-muted">{message}</p>
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
