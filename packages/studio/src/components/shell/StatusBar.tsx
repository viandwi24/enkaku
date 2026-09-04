'use client'

import { StatusDot, cn } from '@enkaku/ui'
import { NotificationBell } from '@/components/NotificationBell'
import { useNow } from '@/lib/useNow'
import { useShellState, type HealthState } from '@/lib/shell-state'

/**
 * The 44px status bar (design handoff, "Global shell"):
 *   height: 44px; background: var(--panel); border: 1px solid var(--border);
 *   border-radius: 14px; padding: 0 8px 0 14px; 1px x 18px var(--line-2)
 *   dividers between four groups.
 *
 * Three of the four groups are the handoff's unchanged. The third loses the
 * `ph-terminal-window` log-window toggle the handoff draws and keeps Alerts,
 * per MVP 15 §0.1.4: that log window is removed entirely, everywhere in this
 * series (see plan 200 §2.4's vocabulary table). The status bar keeps System
 * OK, the counters, Alerts, and the clock.
 *
 * The first group also absorbs what two deleted floating banners used to say
 * (the first-run provisioning banner and the adb-restart banner; MVP 13
 * A.6, plan 213 §3.6): first-run toolchain provisioning and an adb server
 * restart both turn the dot amber and replace the sentence. Neither is a
 * per-page concern and neither has anywhere else to go in the handoff's
 * shell.
 */
function Divider() {
  return <div aria-hidden className="h-[18px] w-px shrink-0 bg-line-2" />
}

function healthLabel(h: HealthState): { text: string; title: string; dot: 'ok' | 'warn' | 'danger'; pulse: boolean } {
  switch (h.kind) {
    case 'offline':
      return { text: 'Core offline', title: 'the connection to the core is down', dot: 'danger', pulse: false }
    case 'adb':
      return { text: h.detail, title: `adb server: ${h.phase}`, dot: 'warn', pulse: true }
    case 'provisioning':
      return { text: h.detail, title: 'first-run toolchain provisioning', dot: 'warn', pulse: true }
    case 'degraded':
      return { text: 'Core degraded', title: h.detail, dot: 'warn', pulse: true }
    case 'ok':
      return { text: 'System OK', title: 'the core is reachable and healthy', dot: 'ok', pulse: true }
  }
}

function Stat({ label, value, accent }: { label: string; value: string; accent: boolean }) {
  return (
    <div className="flex flex-none items-center gap-2 px-[14px]">
      <span className="text-[12px] text-faint">{label}</span>
      <span className={cn('font-mono text-body font-semibold', accent ? 'text-accent' : 'text-text')}>{value}</span>
    </div>
  )
}

export function StatusBar() {
  const { devices, jobs, health } = useShellState()
  const now = useNow(1000)
  const h = healthLabel(health)
  const p = (n: number) => String(n).padStart(2, '0')
  const d = new Date(now)
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`

  return (
    <div className="flex h-[44px] flex-none items-center gap-[2px] rounded-card border border-border bg-panel pr-[8px] pl-[14px]">
      <div className="flex flex-none items-center gap-2 pr-[14px]" title={h.title}>
        {/* The handoff's 7px `var(--ok)` dot with `enkakuPulse 2.6s`. `StatusDot`
            (plan 204 §4.6) carries the pulse and the five state colours; the
            size is passed because 7px is this dot's alone. */}
        <StatusDot
          state={h.dot === 'ok' ? 'free' : h.dot === 'warn' ? 'unauthorized' : 'job'}
          pulse={h.pulse}
          className="size-[7px]"
          title={h.text}
        />
        <span className="text-[12px] text-text-3">{h.text}</span>
      </div>

      <Divider />

      <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
        <Stat label="Devices" value={`${devices.online}/${devices.total}`} accent />
        <Stat label="Jobs" value={`${jobs.running}/${jobs.running + jobs.queued}`} accent={false} />
      </div>

      <Divider />

      <div className="flex flex-none items-center gap-1 px-2">
        <NotificationBell />
      </div>

      <Divider />

      <div className="flex-none px-3 font-mono text-[12px] text-text-3">{clock}</div>
    </div>
  )
}
