'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Play } from 'lucide-react'
import {
  JobsPageResponseSchema,
  ScriptDeleteResponseSchema,
  ScriptResponseSchema,
  ScriptToggleResponseSchema,
  ScriptVersionsResponseSchema,
  SettingsResponseSchema,
  type DeviceInfo,
  type JobInfo,
  type JobSettings,
} from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  TableCell,
  TableHead,
  api,
  cn,
  duration,
  relativeTime,
  useAction,
} from '@enkaku/ui'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { JobStatusBadge } from '@/components/StatusBadge'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { JobsList } from '@/components/JobsList'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { fetchDevices } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { computeRuntimeReadout } from '../runtime-readout'

interface VersionOption {
  id: string
  version: string
  enabled: boolean
  createdAt: number | null
}

/**
 * A published script is an object with real depth — its parameter contract, the
 * runs it produced, and its lifecycle. The list view could only ever show a
 * row; everything else had nowhere to live.
 */
function ScriptDetail() {
  const params = useSearchParams()
  const scriptId = params.get('id')
  const tab = params.get('tab') ?? 'overview'
  const router = useRouter()

  const [script, setScript] = useState<ScriptRow | null>(null)
  const [versions, setVersions] = useState<VersionOption[]>([])
  const [runsCount, setRunsCount] = useState<number | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [runOpen, setRunOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const runsRef = useRef<PaginatedTableHandle<JobInfo>>(null)
  // The runs table's durations tick while a run is still going (Plan 17 §4.6).
  const now = useNow()
  // Plan 98 §3.9 item 3, §5 step 98.8 — the Runtime card's own farm layer.
  // Fetched once (this page has nothing that changes the farm's job
  // settings itself), not re-fetched on every version switch — a farm
  // setting change reaching this card without a reload is a "nice to have",
  // not a correctness requirement the way it is for the runner itself
  // (F25's own guarantee lives server-side; this is a read-only display).
  const [farmJobSettings, setFarmJobSettings] = useState<JobSettings | null>(null)

  const load = () => {
    if (!scriptId) return
    setError(null)
    void api(`/api/scripts/${scriptId}`, ScriptResponseSchema)
      .then((b) => setScript(b.script))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }

  useEffect(load, [scriptId])

  useEffect(() => {
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => setFarmJobSettings(b.settings.job))
      .catch(() => undefined)
  }, [])

  // The version selector's options (plan 62 §4.6) — re-fetched whenever the
  // script's NAME changes (switching versions keeps the same name, so this
  // does not re-fire on every version switch, only when arriving at a
  // different script family entirely).
  useEffect(() => {
    if (!script) return
    void api(`/api/scripts/${encodeURIComponent(script.name)}/versions`, ScriptVersionsResponseSchema)
      .then((b) => setVersions(b.items))
      .catch(() => setVersions([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script?.name])

  /**
   * `/api/jobs` has no per-script filter (plan 30 non-goals — pagination
   * only, no new filtering), so this walks the job feed page by page and
   * keeps the ones matching this script, capped generously. Because the
   * scan always drains fully before returning, there is no partial-page
   * truncation to skip a row on — it just has no further "load more" once
   * done, unlike every other converted table here.
   */
  const fetchRuns = async (): Promise<Page<JobInfo>> => {
    if (!scriptId) return { items: [], nextCursor: null, total: 0 }
    const matches: JobInfo[] = []
    let cursor: string | null = null
    for (let scan = 0; scan < 25; scan++) {
      const jobsPage: Page<JobInfo> = await api(`/api/jobs?limit=200${cursor ? `&cursor=${cursor}` : ''}`, JobsPageResponseSchema)
      matches.push(...jobsPage.items.filter((j) => j.scriptId === scriptId))
      cursor = jobsPage.nextCursor
      if (!cursor) break
    }
    setRunsCount(matches.length)
    return { items: matches, nextCursor: null, total: matches.length }
  }

  if (!scriptId) {
    return (
      <div className="px-5 py-4">
        <ErrorState message="The address is missing an id parameter." />
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-5 py-4">
        <ErrorState message={error} onRetry={load} />
      </div>
    )
  }
  if (!script) {
    return (
      <div className="px-5 py-4">
        <LoadingRows rows={3} />
      </div>
    )
  }

  const paramFields = Object.entries(
    (script.paramsSchema as { properties?: Record<string, { type?: string; description?: string; default?: unknown }> } | null)
      ?.properties ?? {},
  )

  return (
    <>
      <PageHeader
        title={script.name}
        description={`published ${relativeTime(script.createdAt)}`}
        meta={
          // Only when there is a choice — a script with one version has
          // nothing to select between (plan 62 §4.6, acceptance #10:
          // "the detail page's selector defaults to latest").
          versions.length > 1 ? (
            <Select
              value={script.id}
              onValueChange={(id) => router.push(`/scripts/detail?id=${encodeURIComponent(id)}${tab === 'overview' ? '' : `&tab=${tab}`}`)}
            >
              <SelectTrigger className="readout h-8 w-32 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v, i) => (
                  <SelectItem key={v.id} value={v.id} className="readout">
                    {v.version}
                    {i === 0 ? ' · latest' : ''}
                    {!v.enabled ? ' · disabled' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="readout text-[12.5px] text-fg-muted">v{script.version}</span>
          )
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              {/* The list this page belongs to moved into `/plugins` — one screen for
                  everything the farm can run. Pointing straight at it rather than at
                  `/scripts` (still a working redirect) keeps the back button one hop. */}
              <Link href="/plugins">
                <ArrowLeft className="size-4" aria-hidden />
                All scripts
              </Link>
            </Button>
            <Button size="sm" disabled={!script.enabled} onClick={() => setRunOpen(true)}>
              <Play className="size-4" aria-hidden />
              Run
            </Button>
          </>
        }
      />

      <EntityTabs
        active={tab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'source', label: 'Source' },
          { key: 'runs', label: 'Runs', count: runsCount },
          { key: 'settings', label: 'Settings' },
        ]}
        hrefFor={(k) => `/scripts/detail?id=${encodeURIComponent(script.id)}${k === 'overview' ? '' : `&tab=${k}`}`}
      />

      {tab === 'overview' && (
        <div className="max-w-3xl space-y-4 px-5 py-4">
          <div className="rounded-lg border bg-surface p-4">
            <h2 className="text-[14px] font-semibold tracking-tight">Parameters</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
              Declared by the script's Zod schema. Studio builds the run form from exactly this.
            </p>
            {paramFields.length === 0 ? (
              <p className="mt-3 text-[12.5px] text-fg-subtle">This script takes no parameters.</p>
            ) : (
              <dl className="mt-3 divide-y overflow-hidden rounded border">
                {paramFields.map(([key, def]) => (
                  <div key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                    <dt className="readout text-[12.5px]">{key}</dt>
                    <span className="rack-label">{def.type ?? 'any'}</span>
                    {def.default !== undefined && (
                      <span className="readout text-[11px] text-fg-subtle">default {JSON.stringify(def.default)}</span>
                    )}
                    {def.description && (
                      <dd className="w-full text-[11.5px] leading-relaxed text-fg-muted">{def.description}</dd>
                    )}
                  </div>
                ))}
              </dl>
            )}
          </div>

          {/* Plan 98 §3.9 item 3, §5 step 98.8 — the Runtime card: effective
              values plus WHERE each one came from. Rendered only once the
              farm's own job settings have loaded — a card that guessed at
              the farm layer before it arrived would be worse than a brief
              loading state (the same "measured, not implied" standard the
              video settings step already shipped). */}
          {farmJobSettings && <RuntimeCard farm={farmJobSettings} scriptRuntime={script.runtime ?? null} />}

          <div className="rounded-lg border bg-surface p-4">
            <h2 className="rack-label mb-2.5">identity</h2>
            <dl className="space-y-1.5">
              {[
                ['script id', script.id],
                ['version', script.version],
                ['published by', script.createdBy ?? '—'],
                ['status', script.enabled ? 'enabled' : 'disabled'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[12px] text-fg-muted">{k}</dt>
                  <dd className="readout min-w-0 truncate text-[12px]">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">
              Publishing again with the same version is rejected — bump the version instead. Jobs record the specific
              script id, so older runs stay reproducible.
            </p>
          </div>
        </div>
      )}

      {tab === 'source' && (
        <div className="px-5 py-4">
          {script.source ? (
            <>
              <p className="mb-2 text-[12px] text-fg-muted">
                The entry file as published. Imports are bundled at publish time, so what the farm runs is this plus its
                dependencies inlined.
              </p>
              <pre className="readout max-h-[36rem] overflow-auto whitespace-pre rounded-lg border bg-surface p-3 text-[11.5px] leading-relaxed">
                {script.source}
              </pre>
            </>
          ) : (
            <EmptyState
              title="No source stored"
              description="This version was published before the source was kept. Publish again to store it."
            />
          )}
        </div>
      )}

      {tab === 'runs' && (
        <div className="px-5 py-4">
          {/* Shared jobs table (audit finding 1). No script column — this page IS
              the script; the device is what varies between its runs. */}
          <JobsList
            filter={{ scriptId: script.id }}
            columns={{ device: true, time: 'started' }}
            empty={{ title: 'No runs yet', description: 'This version has not been run on any device.' }}
          />
        </div>
      )}

      {tab === 'settings' && (
        <div className="max-w-2xl space-y-4 px-5 py-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border bg-surface p-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Enabled</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                A disabled script stays published and keeps its history, but cannot be run.
              </p>
            </div>
            <Switch
              checked={script.enabled}
              disabled={isPending('toggle')}
              aria-label="Enable this script"
              onCheckedChange={() =>
                void run('toggle', () => api(`/api/scripts/${script.id}`, ScriptToggleResponseSchema, { method: 'PATCH', json: { enabled: !script.enabled } }), {
                  success: script.enabled ? `${script.name} disabled` : `${script.name} enabled`,
                  failure: 'Could not change the script status',
                  onSuccess: load,
                })
              }
            />
          </div>

          <div className="rounded-lg border border-led-danger/30 bg-led-danger/5 p-4">
            <p className="text-[13px] font-medium text-led-danger">Delete this script</p>
            <p className="mt-0.5 mb-3 text-[12px] leading-relaxed text-fg-muted">
              It disappears from the farm and can no longer be run. Jobs that already ran keep their history. A script
              still used by a queued or running job cannot be deleted.
            </p>
            <ConfirmDialog
              trigger={<Button variant="outline" size="sm">Delete script</Button>}
              title={`Delete ${script.name}@${script.version}?`}
              description="This cannot be undone. Publish it again to bring it back."
              onConfirm={() =>
                run('delete', () => api(`/api/scripts/${script.id}`, ScriptDeleteResponseSchema, { method: 'DELETE' }), {
                  success: `${script.name}@${script.version} deleted`,
                  failure: 'Could not delete the script',
                  onSuccess: () => router.push('/plugins'),
                })
              }
            />
          </div>
        </div>
      )}

      <RunScriptDialog
        script={runOpen ? script : null}
        devices={devices}
        onClose={() => setRunOpen(false)}
        onLaunched={() => runsRef.current?.reload()}
      />
    </>
  )
}

/**
 * Plan 98 §3.9 item 3, §5 step 98.8 — read-only, and the answer to "where do
 * the numbers come from" made visible instead of documented (this step's own
 * brief). Purely presentational, the same split `VideoQualityReadout`
 * already establishes: `computeRuntimeReadout` (`../runtime-readout.ts`)
 * does every bit of resolving and labelling; this component only walks its
 * `rows` output.
 */
function RuntimeCard({ farm, scriptRuntime }: { farm: JobSettings; scriptRuntime: ScriptRow['runtime'] }) {
  const { rows } = computeRuntimeReadout(farm, scriptRuntime ?? null)
  return (
    <div className="rounded-lg border bg-surface p-4">
      <h2 className="text-[14px] font-semibold tracking-tight">Runtime</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
        What this script actually runs under, and which of the script, the farm default, or a farm ceiling decided it
        (Plan 98). A per-job override typed into the Run form's Runtime section can still change any of these for one
        run — this card shows the script's own declaration only.
      </p>
      <dl className="mt-3 divide-y overflow-hidden rounded border">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2">
            <dt className="text-[12.5px] text-fg-muted">{r.label}</dt>
            <dd className="flex items-baseline gap-1.5">
              <span className="readout text-[12.5px] font-medium text-fg">{r.value}</span>
              {r.enforcement === 'sampled' && (
                <span
                  className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] tracking-wide text-fg-subtle uppercase"
                  title="Enforced by sampling: a breach is caught on the next check, not prevented instantly."
                >
                  sampled
                </span>
              )}
              <span className={cn('text-[11px]', r.origin === 'clamped' ? 'text-led-warn' : 'text-fg-subtle')}>
                {r.originLabel}
              </span>
            </dd>
            {r.detail && <p className="w-full text-[11px] leading-relaxed text-led-warn">{r.detail}</p>}
          </div>
        ))}
      </dl>
    </div>
  )
}

export default function ScriptDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={3} />
        </div>
      }
    >
      <ScriptDetail />
    </Suspense>
  )
}
