'use client'

import type { ToolProvisionProgress } from '@enkaku/protocol'
import { useEffect, useState } from 'react'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/**
 * First-run toolchain provisioning, made visible.
 *
 * `packages/core/src/tools/provision.ts` has broadcast `tool.provision.progress`
 * from three points — `start`, once per tool, and `done` — since it was
 * written, and until this component nothing rendered it. `daemon.ts:1260`
 * even says so in a comment: "HTTP and WS come up FIRST so clients can watch
 * provisioning progress". The server was built for a watcher that never
 * existed, so a first run downloading adb, scrcpy-server and ui-server showed
 * a still screen for the best part of a minute.
 *
 * The banner is deliberately part of the shell rather than the Tools page:
 * provisioning happens at boot, before anyone has navigated anywhere, and the
 * one moment it matters is the moment a new operator is wondering whether the
 * thing is broken.
 */
type Phase = ToolProvisionProgress['payload']['phase']

interface State {
  step: ToolProvisionProgress['payload']['step']
  toolId?: string | undefined
  phase?: Phase
  percent?: number | null | undefined
  error?: { code: string; message: string } | undefined
}

const PHASE_LABEL: Record<NonNullable<Phase>, string> = {
  download: 'Downloading',
  verify: 'Verifying',
  extract: 'Extracting',
  activate: 'Activating',
}

/** What the operator is told, per step. `error` only ever comes from a critical tool (adb). */
function describe(s: State): { text: string; tone: 'info' | 'warn' | 'danger' } {
  if (s.step === 'error') {
    return { text: `Could not set up the toolchain — ${s.error?.message ?? 'unknown error'}`, tone: 'danger' }
  }
  if (s.step === 'degraded') {
    return { text: `${s.toolId ?? 'A tool'} could not be set up; the farm started without it`, tone: 'warn' }
  }
  if (s.step === 'tool' && s.toolId) {
    const phase = s.phase ? PHASE_LABEL[s.phase] : 'Setting up'
    const pct = typeof s.percent === 'number' ? ` ${Math.round(s.percent)}%` : ''
    return { text: `${phase} ${s.toolId}${pct}`, tone: 'info' }
  }
  return { text: 'Setting up the toolchain — this happens once, and takes about a minute', tone: 'info' }
}

export function ProvisioningBanner() {
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    const off = ws.on((m) => {
      if (m.type !== 'tool.provision.progress') return
      const p = m.payload
      // `done` is the only step that clears the banner. `degraded` and `error`
      // stay: a farm that started without an optional tool, or failed on a
      // critical one, is a fact the operator needs after the noise has passed.
      if (p.step === 'done') {
        setState(null)
        return
      }
      setState({ step: p.step, toolId: p.toolId, phase: p.phase, percent: p.percent, error: p.error })
    })
    return off
  }, [])

  if (!state) return null

  const { text, tone } = describe(state)
  const settled = state.step === 'degraded' || state.step === 'error'

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 border-b px-4 py-2 text-[13px]',
        tone === 'danger' && 'border-danger/30 bg-danger/10 text-danger',
        tone === 'warn' && 'border-warning/30 bg-warning/10 text-warning',
        tone === 'info' && 'bg-surface-2 text-fg-muted',
      )}
    >
      {!settled && <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </div>
  )
}
