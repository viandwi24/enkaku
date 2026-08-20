'use client'

import { Power } from 'lucide-react'
import { Button } from '@enkaku/ui'
import { AppRestartDialog } from './AppRestartDialog'

/** Shown on the button for a non-admin — the same string `tools/page.tsx` already uses for every other `tool.manage` control. */
const ADMIN_ONLY = 'Only an admin can do this'

/**
 * "Restart Enkaku" (plan 120 §4) — deliberately its own card, visually and
 * textually distinct from `AdbServerCard` right above it on the Tools page,
 * because the two buttons must never be mistaken for each other: restarting
 * adb drops every program's adb connection on this machine for a few
 * seconds; restarting Enkaku itself drops every live session/stream,
 * interrupts every running job, and makes the farm briefly fully
 * unreachable. A danger-tinted border and a full sentence naming the
 * difference sit here rather than trusting a button label alone to carry
 * that distinction.
 */
export function AppRestartCard({ canManage }: { canManage: boolean }) {
  return (
    <div className="rounded-lg border border-led-danger/30 bg-led-danger/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight">Restart Enkaku</h2>
          <p className="mt-0.5 max-w-prose text-[12px] text-fg-muted">
            Restarts the whole application, not just the adb connection above — every live session drops and every running job is interrupted.
            Use this when a plugin or code change on disk isn't taking effect, or when something feels stuck and the instinct is "just restart it."
          </p>
        </div>
        <AppRestartDialog
          trigger={
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-led-danger/40 text-[12px] text-led-danger hover:bg-led-danger/10"
              disabled={!canManage}
              title={canManage ? undefined : ADMIN_ONLY}
            >
              <Power className="size-4" aria-hidden />
              Restart Enkaku
            </Button>
          }
        />
      </div>
    </div>
  )
}
