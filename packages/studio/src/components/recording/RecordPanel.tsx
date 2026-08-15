'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Square, Trash2 } from 'lucide-react'
import type { RecordingStoppedReason } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { mmss } from '@/components/device/DeviceHeader'
import { describeApiError } from '@/lib/actions'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { createRecording } from './recording-api'
import type { RecordedStepEntry, RecordingPhase } from './useRecording'

/**
 * Record mode's own edge panel (plan 94 §4.10, §5 step 94.4) — the step
 * strip, the duration/step counter, Stop and Discard, and the review state
 * an operator lands on after stopping. Purely presentational: every piece of
 * state comes from `useRecording` at `ScreenCard`'s own top level, so this
 * component can be conditionally rendered by `mode` without losing anything
 * — the hook, not this panel, is what stays alive across a mode switch.
 */

const STEP_LABEL: Record<RecordedStepEntry['kind'], string> = {
  tap: 'Tap',
  longPress: 'Long press',
  gesture: 'Gesture',
  swipe: 'Swipe',
  key: 'Key',
  text: 'Text',
}

/**
 * Plan 94 §4.9's own three reasons, worded for an operator who did not press
 * Stop and needs to know why the recording ended anyway.
 */
const STOPPED_REASON_TEXT: Record<RecordingStoppedReason, string> = {
  'max-steps': 'reached the maximum number of steps for one recording.',
  'max-duration': 'reached the maximum recording duration.',
  'lease-lost': 'ended because control of this device was lost — released, taken over, or timed out.',
}

export function RecordPanel({
  deviceId,
  phase,
  steps,
  stepCount,
  startedAt,
  endedAt,
  stoppedReason,
  error,
  disabledReason,
  onStart,
  onStop,
  onDiscard,
  onReset,
}: {
  /** Plan 94 §5 step 94.5 — needed to pull the finished, in-memory document off `RecordingService.lastFinished(deviceId)` when the operator names and saves it (the "Save & review" form below). */
  deviceId: string
  phase: RecordingPhase
  steps: RecordedStepEntry[]
  stepCount: number
  /** This tab's own clock, ms epoch — `useRecording`'s own field, straight through. */
  startedAt: number | null
  endedAt: number | null
  stoppedReason: RecordingStoppedReason | null
  /** The last `start()`/`stop()` refusal from the core (`E_RECORDING_ACTIVE`, a lease code, …) — shown, never thrown. */
  error: string | null
  /** Why `Start recording` cannot be pressed right now — the same "genuinely disabled, with a reason" floor every other control on this card holds to. */
  disabledReason?: string
  onStart: () => void
  onStop: () => void
  onDiscard: () => void
  onReset: () => void
}) {
  // Ticks only while THIS panel is mounted — which is only while `mode ===
  // 'record'` (`ScreenCard`'s own conditional render) — rather than a global
  // interval `ScreenCard` would otherwise run on every device page view
  // regardless of whether anyone is recording. `useRecording` itself stays
  // free of wall-clock polling; only the on-screen duration needs one.
  const now = useNow(1000)
  const elapsedMs =
    startedAt === null ? 0 : phase === 'active' ? Math.max(0, now - startedAt) : Math.max(0, (endedAt ?? startedAt) - startedAt)
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const showStrip = phase === 'active' || phase === 'stopping' || phase === 'reviewing'
  return (
    <div className="space-y-2.5 rounded-lg border bg-surface p-3" data-testid="record-panel">
      {/* Plan 94 §5 step 94.4's own requirement: stated ON SCREEN, not only
          in the plan document (§4.6: "In memory... A core restart loses an
          in-progress recording"). Shown in every phase — an operator who
          reads it only once, before starting, is the operator most likely
          to lose ten minutes of taps to a restart they did not see coming. */}
      <p className="text-[11px] leading-relaxed text-fg-muted">
        A recording lives only in this core&apos;s memory until it is saved — a core restart, or losing control of
        this device, discards anything not yet published.
      </p>

      {phase === 'idle' && (
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Plan 94's own step 94.3 flag, resolved here (§4.6 decision 3):
              `recording.start` never auto-attaches an inspector, so a
              recording opened with no Inspect tab ever opened for this
              device gets no element candidates and no screenshots — never a
              failed recording, but worth saying before the operator starts,
              not after they discover it in the review panel. */}
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            Element candidates and screenshots need the Inspect tab to have attached an inspector to this device
            first. A recording still captures every tap, swipe and key by coordinate without one.
          </p>
          <Button size="sm" disabled={Boolean(disabledReason)} onClick={onStart}>
            Start recording
          </Button>
        </div>
      )}
      {disabledReason && phase === 'idle' && <p className="text-[11px] text-led-danger">{disabledReason}</p>}
      {error && <p className="text-[11px] text-led-danger">{error}</p>}

      {phase === 'starting' && <p className="text-[12px] text-fg-muted">Starting…</p>}

      {(phase === 'active' || phase === 'stopping') && (
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="flex items-center gap-2">
            <span className="size-2 animate-pulse rounded-full bg-led-danger" aria-hidden />
            <span className="rack-label text-led-danger">Recording</span>
            <span className="readout text-[11px] text-fg-muted">{mmss(seconds)}</span>
            <span className="text-[11px] text-fg-muted">
              {stepCount} {stepCount === 1 ? 'step' : 'steps'}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={phase === 'stopping'} onClick={onStop}>
              <Square className="size-3.5" aria-hidden />
              Stop
            </Button>
            <Button size="sm" variant="outline" disabled={phase === 'stopping'} onClick={onDiscard}>
              <Trash2 className="size-3.5" aria-hidden />
              Discard
            </Button>
          </span>
        </div>
      )}

      {phase === 'reviewing' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <span className="rack-label text-fg">Review</span>
            <span className="text-[11px] text-fg-muted">
              {stepCount} {stepCount === 1 ? 'step' : 'steps'} · {mmss(seconds)}
            </span>
          </div>
          {stoppedReason && (
            <p className="text-[11.5px] text-led-warn">Recording {STOPPED_REASON_TEXT[stoppedReason]}</p>
          )}
        </div>
      )}

      {showStrip && <StepStrip steps={steps} />}

      {phase === 'reviewing' && (
        <div className="flex flex-wrap items-center gap-2">
          <SaveAndReview deviceId={deviceId} startedAt={startedAt} />
          <Button size="sm" variant="outline" onClick={onReset}>
            Start a new recording
          </Button>
        </div>
      )}
    </div>
  )
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/**
 * The "Review" state's own save form (plan 94 §5 step 94.5) — the piece
 * `RecordPanel`'s own comment on step 94.4 named as missing: 94.4
 * "deliberately does NOT navigate anywhere (94.5's `/recordings/detail?slug=…`
 * does not exist yet)". It does now: naming and saving a finished recording
 * turns `RecordingService.lastFinished(deviceId)` (in-memory only, per
 * `RecordPanel`'s own core-restart caveat above) into the first
 * `/recordings/<slug>.recording.json` on disk, so it survives past this tab.
 */
function SaveAndReview({ deviceId, startedAt }: { deviceId: string; startedAt: number | null }) {
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedSlug, setSavedSlug] = useState<string | null>(null)

  // A fresh recording (a new `startedAt`) never inherits a stale saved link or a stale name typed for a previous one.
  useEffect(() => {
    setName('')
    setVersion('1.0.0')
    setSaveError(null)
    setSavedSlug(null)
  }, [startedAt])

  if (savedSlug) {
    return (
      <Button asChild size="sm">
        <Link href={`/recordings/detail?slug=${encodeURIComponent(savedSlug)}`}>Review &quot;{savedSlug}&quot; →</Link>
      </Button>
    )
  }

  const valid = NAME_RE.test(name) && VERSION_RE.test(version)

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name, e.g. checkout-flow" className="h-8 w-40 text-[11.5px]" />
      <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" className="h-8 w-20 text-[11.5px]" />
      <Button
        size="sm"
        disabled={!valid || saving}
        onClick={() => {
          setSaving(true)
          setSaveError(null)
          createRecording({ deviceId, name, version })
            .then((res) => setSavedSlug(res.slug))
            .catch((err: unknown) => setSaveError(describeApiError(err)))
            .finally(() => setSaving(false))
        }}
      >
        {saving ? 'Saving…' : 'Save & review'}
      </Button>
      {saveError && <p className="w-full text-[11px] text-led-danger">{saveError}</p>}
    </div>
  )
}

function StepStrip({ steps }: { steps: RecordedStepEntry[] }) {
  if (steps.length === 0) {
    return <p className="text-[11px] text-fg-subtle">No steps yet — tap or swipe on the screen above.</p>
  }
  return (
    <ol className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Recorded steps">
      {steps.map((step) => (
        <li
          key={step.index}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px]',
            step.hasCandidate ? 'border-led-active/40 bg-led-active/5 text-fg' : 'text-fg-muted',
          )}
          title={step.hasCandidate ? `${STEP_LABEL[step.kind]} — has an element candidate` : STEP_LABEL[step.kind]}
        >
          <span className="readout text-[10px] text-fg-subtle">{step.index + 1}</span>
          {STEP_LABEL[step.kind]}
        </li>
      ))}
    </ol>
  )
}
