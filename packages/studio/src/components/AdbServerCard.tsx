'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { AdbStatsResponseSchema, type AdbServerHealth } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/actions'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'
import { AdbRestartDialog } from './AdbRestartDialog'

/** Shown on the Restart button for a non-admin — the same string `tools/page.tsx` already uses for every other `tool.manage` control. */
const ADMIN_ONLY = 'Only an admin can do this'

const HEALTH_TONE: Record<AdbServerHealth['status'], string> = {
  ok: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  degraded: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  stuck: 'text-led-danger border-led-danger/40 bg-led-danger/10',
}

const SYMPTOM_LABEL: Record<AdbServerHealth['symptoms'][number]['symptom'], string> = {
  'server-unreachable': 'adb server unreachable',
  'server-unresponsive': 'adb server unresponsive',
  'transports-wedged': 'transports wedged',
  'reconnect-ineffective': 'reconnect not helping',
  'timeout-storm': 'timeout storm',
}

/**
 * "Is adb stuck?" (plan 88 §3.9) leads, "restart it" follows — the button
 * below is not offered on its own. `restartAdvised` is `AdbServerHealth`'s
 * own verdict (`packages/core/src/device/adb-health.ts`): it is `true` for
 * exactly two of five symptoms (`server-unresponsive`, `transports-wedged`);
 * the other three name a DIFFERENT remedy and this card says so rather than
 * defaulting to "click restart" for everything.
 */
export function AdbServerCard({ canManage }: { canManage: boolean }) {
  const [health, setHealth] = useState<AdbServerHealth | null>(null)

  useEffect(() => {
    const load = () => {
      api('/api/adb/stats', AdbStatsResponseSchema)
        .then((b) => setHealth(b.adbHealth))
        .catch(() => {
          // The card simply does not render rather than showing a broken
          // panel — `/api/tools` (right below it) already has its own
          // `ErrorState` for a core that is unreachable.
        })
    }
    load()
    // Transition-only, matching the server's own broadcast discipline
    // (`adb.health` fires on a status CHANGE, never on a timer) — no polling here.
    const off = ws.on((m) => {
      if (m.type === 'adb.health') setHealth(m.payload)
    })
    return off
  }, [])

  if (!health) return null

  return (
    <div className="rounded-lg border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold tracking-tight">adb server</h2>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
              HEALTH_TONE[health.status],
            )}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {health.status}
          </span>
        </div>
        <AdbRestartDialog
          trigger={
            <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={!canManage} title={canManage ? undefined : ADMIN_ONLY}>
              <RefreshCw className="size-4" aria-hidden />
              Restart adb server
            </Button>
          }
        />
      </div>

      {health.symptoms.length > 0 && (
        <dl className="mt-3 space-y-1.5 rounded border px-3 py-2">
          {health.symptoms.map((s) => (
            <div key={s.symptom} className="text-[12px] leading-relaxed">
              <dt className="inline font-medium text-fg">{SYMPTOM_LABEL[s.symptom]}</dt>
              <dd className="inline text-fg-muted"> — {s.detail}</dd>
            </div>
          ))}
        </dl>
      )}

      {health.status !== 'ok' && (
        <p className="mt-2 text-[11.5px] text-fg-muted">
          {health.restartAdvised
            ? 'A restart is likely to fix this.'
            : 'A restart probably will not fix this — see the symptom above for why, and what to try instead.'}
        </p>
      )}
    </div>
  )
}
