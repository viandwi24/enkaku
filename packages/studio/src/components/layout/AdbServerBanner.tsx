'use client'

import { useEffect, useState } from 'react'
import type { AdbServerPhase } from '@enkaku/protocol'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/**
 * The adb server's drain/stop/start/reattach cycle, made visible farm-wide
 * (plan 88 §3.10, §4.8, §5 step 88.8) — mirrors `ProvisioningBanner`'s own
 * reasoning exactly: `adb.server.phase` has broadcast every phase since
 * `adb-server-control.ts` shipped, and until this component nothing
 * rendered it. Lives in the shell, not the Tools page, for the same reason
 * `ProvisioningBanner` does: a restart affects every device on every page,
 * not just whoever happens to be looking at Tools when it fires. This is
 * the "one banner instead of twenty offline toasts" plan 88 §3.10 asks for.
 */
type Reason = 'swap' | 'restart'

interface State {
  phase: AdbServerPhase
  reason: Reason
  detail: string
}

const PHASE_LABEL: Record<AdbServerPhase, string> = {
  draining: 'Draining',
  stopping: 'Stopping the adb server',
  swapping: 'Swapping the adb binary',
  starting: 'Starting the adb server',
  reattaching: 'Reattaching network devices',
  reconciling: 'Reconciling',
  done: 'Done',
  failed: 'Failed',
}

const REASON_LABEL: Record<Reason, string> = {
  swap: 'adb version swap',
  restart: 'adb restart',
}

export function AdbServerBanner() {
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type !== 'adb.server.phase') return
      const { phase, reason, detail } = m.payload
      // `done` is the only phase that clears the banner — `failed` stays
      // visible (mirrors `ProvisioningBanner`'s `degraded`/`error`): a
      // restart that did not complete cleanly is a fact worth keeping on
      // screen, not noise to dismiss automatically.
      if (phase === 'done') {
        setState(null)
        return
      }
      setState({ phase, reason, detail })
    })
    return off
  }, [])

  if (!state) return null

  const failed = state.phase === 'failed'

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 border-b px-4 py-2 text-[13px]',
        failed ? 'border-danger/30 bg-danger/10 text-danger' : 'bg-surface-2 text-fg-muted',
      )}
    >
      {!failed && (
        <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">
        {REASON_LABEL[state.reason]}: {PHASE_LABEL[state.phase]}
        {state.detail ? ` — ${state.detail}` : ''}
        {!failed && ' — every device reconnects automatically'}
      </span>
    </div>
  )
}
