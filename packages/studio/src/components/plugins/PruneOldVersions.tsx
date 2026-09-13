'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button, ConfirmDialog, describeApiError, CheckCircleIcon, CircleNotchIcon, TrashIcon, WarningIcon, XCircleIcon, XIcon } from '@enkaku/ui'
import type { PluginGroup } from '@/app/plugins/plugin-list'
import { previewBulkRemoval, requestBulkRemoval, summariseBulkRemoval } from '@/lib/plugin-removal'

/**
 * "Remove old versions" — one button that prunes every plugin's history down to what is live
 * (owner request, 2026-09-14: *"satu tombol ini untuk menghapus semua versi yang lama jadi keep
 * satu yang paling latest atau aktif sekarang … semakin banyak update app plugin lama itu numpuk
 * semua"*).
 *
 * Version history accumulates on every publish and every core upgrade (bundled packs are seeded
 * `staged`), and nothing ever collects it: a farm that has taken a dozen releases carries a dozen
 * rows per pack. The per-plugin Remove menu already offers "all except latest"; this runs that SAME
 * request over every plugin that has anything to prune.
 *
 * ## Nothing here decides what gets deleted
 *
 * The plan in the confirm dialog comes from `previewBulkRemoval`, which calls the protocol's
 * `planPluginVersionRemoval` — the function the core itself plans the removal with — and each plugin
 * is then sent to `POST /api/plugins/:name/versions/remove` with scope `except-latest`. So the
 * dialog cannot promise something the server will not do. That rule keeps more than "the newest":
 * the ACTIVE version too when a rollback left it behind, a disabled one, and anything mid-verify;
 * and the core refuses a version a queued or running job still uses (`script_in_use`), which the
 * report names.
 *
 * ## Never the plugin's data
 *
 * `deleteKv` is never sent. Every version of a plugin shares one key/value namespace, so deleting it
 * while keeping the newest version would empty the store under the version being kept — the
 * sessions, settings and accounts a plugin like Social Media Manager holds.
 *
 * NO NEW CORE ENDPOINT, for the reason `ActivateLatestPlugins` gives: each plugin is its own request
 * with its own outcome, and a failure in the middle is reported per plugin, not invented as a
 * partial-success envelope.
 */

export interface PrunePlanItem {
  name: string
  going: string[]
  staying: { version: string; reason: string }[]
}

export interface PrunePlan {
  items: PrunePlanItem[]
  /** Every version the plan removes, across all plugins. */
  total: number
}

/** What the button would remove, computed from the WHOLE list — never from a search's matches. */
export function planPruneOldVersions(groups: readonly PluginGroup[]): PrunePlan {
  const items: PrunePlanItem[] = []
  for (const group of groups) {
    if (group.versions.length < 2) continue
    const preview = previewBulkRemoval(group.versions, 'all-except-latest')
    if (preview.going.length === 0) continue
    items.push({ name: group.name, going: preview.going, staying: preview.staying })
  }
  return { items, total: items.reduce((n, i) => n + i.going.length, 0) }
}

type StepState = 'pending' | 'removing' | 'done' | 'partial' | 'failed'

interface Step {
  name: string
  state: StepState
  planned: number
  removed: number
  kept: string[]
  refused: { version: string; code: string; message: string }[]
  detail: string | null
}

export interface PruneRun {
  running: boolean
  steps: Step[]
}

export function usePruneOldVersions(onChanged: () => void) {
  const [run, setRun] = useState<PruneRun | null>(null)

  const start = useCallback(
    async (plan: PrunePlan) => {
      const steps: Step[] = plan.items.map((i) => ({ name: i.name, state: 'pending', planned: i.going.length, removed: 0, kept: [], refused: [], detail: null }))
      const publish = (running: boolean) => setRun({ running, steps: steps.map((s) => ({ ...s })) })
      publish(true)

      for (const step of steps) {
        step.state = 'removing'
        publish(true)
        try {
          const summary = summariseBulkRemoval(step.name, await requestBulkRemoval(step.name, 'all-except-latest', false))
          step.removed = summary.removed.length
          step.kept = summary.kept
          step.refused = summary.failed
          step.state = summary.failed.length === 0 ? 'done' : summary.removed.length > 0 ? 'partial' : 'failed'
        } catch (err) {
          step.state = 'failed'
          step.detail = describeApiError(err)
        }
        publish(true)
      }

      publish(false)
      const removed = steps.reduce((n, s) => n + s.removed, 0)
      const troubled = steps.filter((s) => s.state === 'partial' || s.state === 'failed').length
      if (troubled === 0) toast.success(`${removed} old version${removed === 1 ? '' : 's'} removed from ${steps.length} plugin${steps.length === 1 ? '' : 's'}`)
      else
        toast.warning(`${removed} old version${removed === 1 ? '' : 's'} removed — ${troubled} plugin${troubled === 1 ? '' : 's'} kept some`, {
          description: 'Each refusal is listed below with the reason the farm gave.',
        })
      // Once, at the end: reloading per plugin would reshuffle the table while the batch walks it.
      onChanged()
    },
    [onChanged],
  )

  return { run, start, dismiss: () => setRun(null), busy: run?.running === true }
}

/** The header control. Disabled — never hidden — when there is nothing old to remove. */
export function PruneOldVersionsButton({ plan, busy, onConfirm }: { plan: PrunePlan; busy: boolean; onConfirm: () => void }) {
  if (plan.total === 0) {
    return (
      <Button size="sm" variant="secondary" disabled title="Every plugin keeps only what is live — its newest and active versions">
        <TrashIcon className="size-3.5" aria-hidden />
        Remove old versions
      </Button>
    )
  }

  const plugins = plan.items.length
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary" disabled={busy}>
          <TrashIcon className="size-3.5" aria-hidden />
          Remove old versions ({plan.total})
        </Button>
      }
      title={`Remove ${plan.total} old version${plan.total === 1 ? '' : 's'} from ${plugins} plugin${plugins === 1 ? '' : 's'}?`}
      confirmLabel="Remove old versions"
      description={
        <>
          <p>Each plugin keeps what is live — its newest version, and its active one when that is a different version:</p>
          <ul className="mt-2 space-y-1">
            {plan.items.map((i) => (
              <li key={i.name} className="text-meta">
                <span className="font-mono text-text-2">{i.name}</span> — removes {i.going.length}, keeps{' '}
                <span className="font-mono">{i.staying.map((s) => `${s.version} (${s.reason})`).join(', ')}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            A version a queued or running job still uses is refused and left in place. Each plugin&apos;s stored data — sessions, settings,
            accounts — is shared by all its versions and is not touched.
          </p>
          <p className="mt-2 text-warn">A removed version cannot be rolled back to.</p>
        </>
      }
      onConfirm={onConfirm}
    />
  )
}

/** The per-plugin result — never a bare count, and it stays until dismissed. */
export function PruneOldVersionsReport({ run, onDismiss }: { run: PruneRun; onDismiss: () => void }) {
  const done = run.steps.filter((s) => s.state !== 'pending' && s.state !== 'removing').length
  const removed = run.steps.reduce((n, s) => n + s.removed, 0)
  const troubled = run.steps.filter((s) => s.state === 'partial' || s.state === 'failed').length

  return (
    <div className="mb-4 rounded-card border border-line-2 bg-panel-2 px-3.5 py-3">
      <div className="flex items-center gap-2">
        {run.running ? (
          <CircleNotchIcon className="size-4 animate-spin text-accent" aria-hidden />
        ) : troubled > 0 ? (
          <WarningIcon className="size-4 text-warn" aria-hidden />
        ) : (
          <CheckCircleIcon className="size-4 text-ok" aria-hidden />
        )}
        <span className="text-row font-semibold text-text">
          {run.running
            ? `Removing old versions — ${done} of ${run.steps.length} plugins done`
            : troubled > 0
              ? `${removed} old version${removed === 1 ? '' : 's'} removed; ${troubled} plugin${troubled === 1 ? '' : 's'} kept some`
              : `${removed} old version${removed === 1 ? '' : 's'} removed`}
        </span>
        {!run.running && (
          <button type="button" aria-label="Dismiss this result" onClick={onDismiss} className="ml-auto text-faint hover:text-text">
            <XIcon className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {run.steps.map((s) => (
          <li key={s.name} className="text-meta">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <StepMark state={s.state} />
              <span className="font-mono text-text-2">{s.name}</span>
              <span className={s.state === 'failed' ? 'text-danger' : s.state === 'partial' ? 'text-warn' : 'text-faint'}>{stepWords(s)}</span>
            </div>
            {s.refused.length > 0 && (
              <ul className="ml-5 mt-0.5 space-y-0.5">
                {s.refused.map((r) => (
                  <li key={r.version} className="text-faint">
                    <span className="font-mono text-text-2">{r.version}</span> kept — {r.code}: {r.message}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function StepMark({ state }: { state: StepState }) {
  if (state === 'done') return <CheckCircleIcon className="size-3.5 shrink-0 text-ok" aria-hidden />
  if (state === 'failed') return <XCircleIcon className="size-3.5 shrink-0 text-danger" aria-hidden />
  if (state === 'partial') return <WarningIcon className="size-3.5 shrink-0 text-warn" aria-hidden />
  if (state === 'pending') return <span className="size-3.5 shrink-0" aria-hidden />
  return <CircleNotchIcon className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
}

function stepWords(s: Step): string {
  switch (s.state) {
    case 'pending':
      return `waiting — ${s.planned} to remove`
    case 'removing':
      return `removing ${s.planned}…`
    case 'done':
      return `removed ${s.removed}${s.kept.length > 0 ? `, kept ${s.kept.join(', ')}` : ''}`
    case 'partial':
      return `removed ${s.removed} of ${s.planned} — ${s.refused.length} refused`
    case 'failed':
      return s.detail ?? `removed none — ${s.refused.length} refused`
  }
}
