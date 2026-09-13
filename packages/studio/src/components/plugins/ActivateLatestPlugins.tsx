'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { PluginActivateResponseSchema, PluginVerifyResponseSchema } from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  api,
  describeApiError,
  ArrowUpIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from '@enkaku/ui'
import type { LatestActivationBlock, LatestActivationPlan } from '@/app/plugins/plugin-list'

/**
 * "Activate newest" — one button for the upgrade an operator otherwise applies
 * by hand, plugin by plugin (owner request, 2026-09-13).
 *
 * The shape of the problem it removes: a core upgrade seeds its bundled packs
 * `staged`, never `active` (`plugins/seed-embedded.ts` — activation is a
 * deliberate click). So a farm that has taken three releases is running three
 * old versions with three new ones one collapsed `<select>` away, and clearing
 * that means, per plugin: open the version dropdown, pick the staged row, read
 * the confirm, click Activate. This does that loop, in order, over the
 * existing `POST /api/plugins/:id/activate` — the same endpoint the row's own
 * Activate button posts, one plugin at a time, so nothing here can activate
 * something the row could not.
 *
 * NO NEW CORE ENDPOINT, on purpose. The one thing a batch has that a single
 * click does not is a failure in the middle, and a server-side loop would have
 * to invent a partial-success envelope to report it. Here each step is its own
 * request with its own outcome, and the panel below shows all of them.
 *
 * The two footguns it must not hide:
 *
 *  - A staged version that was never verified. `runtime.activate` refuses it
 *    (`plugin_not_verified`), and this page has no Verify control anywhere, so
 *    reporting the refusal would leave a dead end. The step runs
 *    `POST /:id/verify` first — the documented stage → verify → activate
 *    order — and says so, both in the confirm dialog beforehand and on the
 *    row afterwards.
 *  - Anything that fails. It stays on screen, named, with the server's own
 *    message, and the batch carries on to the next plugin rather than stopping
 *    on the first red.
 */

type StepState = 'pending' | 'verifying' | 'activating' | 'activated' | 'failed'

interface Step {
  name: string
  from: string
  to: string
  verified: boolean
  state: StepState
  detail: string | null
}

export interface ActivateLatestRun {
  running: boolean
  steps: Step[]
  alreadyLatest: string[]
  blocked: LatestActivationBlock[]
}

export function useActivateLatest(onChanged: () => void) {
  const [run, setRun] = useState<ActivateLatestRun | null>(null)

  const start = useCallback(
    async (plan: LatestActivationPlan) => {
      const steps: Step[] = plan.upgrades.map((u) => ({
        name: u.name,
        from: u.from,
        to: u.to.version,
        verified: !u.needsVerify,
        state: 'pending',
        detail: null,
      }))
      const publish = (running: boolean) =>
        setRun({ running, steps: steps.map((s) => ({ ...s })), alreadyLatest: plan.alreadyLatest, blocked: plan.blocked })
      publish(true)

      for (const [i, target] of plan.upgrades.entries()) {
        const step = steps[i] as Step
        try {
          if (target.needsVerify) {
            step.state = 'verifying'
            publish(true)
            const report = await api(`/api/plugins/${encodeURIComponent(target.to.id)}/verify`, PluginVerifyResponseSchema, { method: 'POST' })
            if (!report.verify.ok) {
              step.state = 'failed'
              step.detail = `verification failed — ${report.verify.errorCode ?? 'E_PLUGIN_VERIFY_FAILED'}: ${report.verify.error ?? 'no reason reported'}`
              publish(true)
              continue
            }
            step.verified = true
          }
          step.state = 'activating'
          publish(true)
          const body = await api(`/api/plugins/${encodeURIComponent(target.to.id)}/activate`, PluginActivateResponseSchema, { method: 'POST' })
          step.state = 'activated'
          step.detail =
            body.queuedKeepingPrevious > 0
              ? `${body.scriptsMoved} script${body.scriptsMoved === 1 ? '' : 's'} moved; ${body.queuedKeepingPrevious} queued job${body.queuedKeepingPrevious === 1 ? '' : 's'} kept ${target.from}`
              : `${body.scriptsMoved} script${body.scriptsMoved === 1 ? '' : 's'} moved`
        } catch (err) {
          step.state = 'failed'
          step.detail = describeApiError(err)
        }
        publish(true)
      }

      publish(false)
      const activated = steps.filter((s) => s.state === 'activated').length
      const failed = steps.length - activated
      if (failed === 0) toast.success(`${activated} plugin${activated === 1 ? '' : 's'} moved to the newest installed version`)
      else
        toast.error(`${failed} of ${steps.length} could not be activated`, {
          description: 'Each one is listed below with the reason the farm gave.',
        })
      // Once, at the end: a reload per step would renumber the table under the
      // operator while the batch is still walking it.
      onChanged()
    },
    [onChanged],
  )

  return { run, start, dismiss: () => setRun(null), busy: run?.running === true }
}

/** The header control. Disabled — never hidden — when there is nothing to move. */
export function ActivateLatestButton({
  plan,
  busy,
  onConfirm,
}: {
  plan: LatestActivationPlan
  busy: boolean
  onConfirm: () => void
}) {
  const n = plan.upgrades.length
  const needVerify = plan.upgrades.filter((u) => u.needsVerify).length

  if (n === 0) {
    return (
      <Button
        size="sm"
        variant="secondary"
        disabled
        title={
          plan.alreadyLatest.length > 0
            ? 'Every plugin already runs the newest version installed on this farm'
            : 'No plugin has a newer installed version waiting'
        }
      >
        <ArrowUpIcon className="size-3.5" aria-hidden />
        Activate newest
      </Button>
    )
  }

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary" disabled={busy}>
          <ArrowUpIcon className="size-3.5" aria-hidden />
          Activate newest ({n})
        </Button>
      }
      title={`Activate the newest installed version of ${n} plugin${n === 1 ? '' : 's'}?`}
      destructive={false}
      confirmLabel="Activate newest"
      description={
        <>
          <p>Each of these already has a newer version on this farm, staged and doing nothing until it is activated:</p>
          <ul className="mt-2 space-y-0.5">
            {plan.upgrades.map((u) => (
              <li key={u.name} className="font-mono text-meta">
                {u.name} {u.from} → {u.to.version}
                {u.needsVerify ? ' (unverified)' : ''}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            They are activated one at a time, in that order. Any job already queued or running against the version a plugin runs now keeps
            running against it — it is not moved.
          </p>
          {needVerify > 0 && (
            <p className="mt-2">
              {needVerify} of them {needVerify === 1 ? 'was' : 'were'} staged without being verified, so the farm verifies{' '}
              {needVerify === 1 ? 'it' : 'them'} first — activation refuses an unverified version. A version that fails verification is left
              failed and reported, not activated.
            </p>
          )}
          {plan.alreadyLatest.length > 0 && (
            <p className="mt-2 text-faint">
              {plan.alreadyLatest.length} other plugin{plan.alreadyLatest.length === 1 ? '' : 's'} already run
              {plan.alreadyLatest.length === 1 ? 's' : ''} the newest version installed — untouched.
            </p>
          )}
          {plan.blocked.length > 0 && (
            <p className="mt-2 text-warn">
              {plan.blocked.length} plugin{plan.blocked.length === 1 ? ' is' : 's are'} left alone for a reason listed after the run:{' '}
              {plan.blocked.map((b) => b.name).join(', ')}.
            </p>
          )}
        </>
      }
      onConfirm={onConfirm}
    />
  )
}

/** The per-plugin result — never a bare count, and it stays until dismissed. */
export function ActivateLatestReport({ run, onDismiss }: { run: ActivateLatestRun; onDismiss: () => void }) {
  const done = run.steps.filter((s) => s.state === 'activated' || s.state === 'failed').length
  const failed = run.steps.filter((s) => s.state === 'failed').length

  return (
    <div className="mb-4 rounded-card border border-line-2 bg-panel-2 px-3.5 py-3">
      <div className="flex items-center gap-2">
        {run.running ? (
          <CircleNotchIcon className="size-4 animate-spin text-accent" aria-hidden />
        ) : failed > 0 ? (
          <WarningIcon className="size-4 text-warn" aria-hidden />
        ) : (
          <CheckCircleIcon className="size-4 text-ok" aria-hidden />
        )}
        <span className="text-row font-semibold text-text">
          {run.running
            ? `Activating the newest installed version — ${done} of ${run.steps.length} done`
            : failed > 0
              ? `${run.steps.length - failed} of ${run.steps.length} activated, ${failed} failed`
              : `${run.steps.length} plugin${run.steps.length === 1 ? '' : 's'} moved to the newest installed version`}
        </span>
        {!run.running && (
          <button type="button" aria-label="Dismiss this result" onClick={onDismiss} className="ml-auto text-faint hover:text-text">
            <XIcon className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {run.steps.map((s) => (
          <li key={s.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-meta">
            <StepMark state={s.state} />
            <span className="font-mono text-text-2">
              {s.name} {s.from} → {s.to}
            </span>
            <span className={s.state === 'failed' ? 'text-danger' : 'text-faint'}>{stepWords(s)}</span>
          </li>
        ))}
      </ul>

      {run.alreadyLatest.length > 0 && (
        <p className="mt-2 text-meta text-faint">
          Already on the newest installed version, untouched: <span className="font-mono">{run.alreadyLatest.join(', ')}</span>
        </p>
      )}

      {run.blocked.length > 0 && (
        <div className="mt-2">
          <p className="text-meta text-warn">Not touched by this button:</p>
          <ul className="mt-0.5 space-y-0.5">
            {run.blocked.map((b) => (
              <li key={b.name} className="text-meta text-faint">
                <span className="font-mono text-text-2">{b.name}</span> — {b.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function StepMark({ state }: { state: StepState }) {
  if (state === 'activated') return <CheckCircleIcon className="size-3.5 shrink-0 text-ok" aria-hidden />
  if (state === 'failed') return <XCircleIcon className="size-3.5 shrink-0 text-danger" aria-hidden />
  if (state === 'pending') return <span className="size-3.5 shrink-0" aria-hidden />
  return <CircleNotchIcon className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
}

function stepWords(s: Step): string {
  switch (s.state) {
    case 'pending':
      return 'waiting'
    case 'verifying':
      return 'verifying first (it was staged unverified)…'
    case 'activating':
      return 'activating…'
    case 'activated':
      return s.detail ? `activated — ${s.detail}` : 'activated'
    case 'failed':
      return s.detail ?? 'failed'
  }
}
