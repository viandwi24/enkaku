'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Play } from 'lucide-react'
import type { DeviceInfo, JobInfo } from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { RunScriptDialog, type ScriptRow } from '@/components/RunScriptDialog'
import { JobStatusBadge } from '@/components/StatusBadge'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaginatedTable, type Page, type PaginatedTableHandle } from '@/components/PaginatedTable'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TableCell, TableHead } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { duration, relativeTime } from '@/lib/format'
import { useNow } from '@/lib/useNow'

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
  const [runsCount, setRunsCount] = useState<number | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [runOpen, setRunOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const runsRef = useRef<PaginatedTableHandle<JobInfo>>(null)
  // The runs table's durations tick while a run is still going (Plan 17 §4.6).
  const now = useNow()

  const load = () => {
    if (!scriptId) return
    setError(null)
    void api<{ script: ScriptRow }>(`/api/scripts/${scriptId}`)
      .then((b) => setScript(b.script))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }

  useEffect(load, [scriptId])

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
      const jobsPage: Page<JobInfo> = await api(`/api/jobs?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
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
        description={`Version ${script.version} · published ${relativeTime(script.createdAt)}`}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/scripts">
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
          <PaginatedTable<JobInfo>
            ref={runsRef}
            resetKey={scriptId}
            fetchPage={fetchRuns}
            rowKey={(j) => j.jobId}
            header={
              <>
                <TableHead className="w-[35%]">Job</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Started</TableHead>
              </>
            }
            renderRow={(j) => (
              <>
                <TableCell>
                  <Link href={`/jobs/detail?id=${j.jobId}`} className="readout text-[12px] hover:text-accent">
                    {j.jobId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="text-[12.5px]">
                  {devices.find((d) => d.id === j.deviceId)?.label ?? j.deviceId.slice(0, 8)}
                </TableCell>
                <TableCell>
                  <JobStatusBadge status={j.status} />
                </TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">
                  {duration(j.startedAt, j.finishedAt, now)}
                </TableCell>
                <TableCell className="readout text-[11.5px] text-fg-muted">
                  {relativeTime(j.startedAt ?? j.createdAt, now)}
                </TableCell>
              </>
            )}
            empty={{
              title: 'No runs yet',
              description: 'Jobs started from this script appear here.',
              action: (
                <Button disabled={!script.enabled} onClick={() => setRunOpen(true)}>
                  Run it now
                </Button>
              ),
            }}
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
                void run('toggle', () => api(`/api/scripts/${script.id}`, { method: 'PATCH', json: { enabled: !script.enabled } }), {
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
                run('delete', () => api(`/api/scripts/${script.id}`, { method: 'DELETE' }), {
                  success: `${script.name}@${script.version} deleted`,
                  failure: 'Could not delete the script',
                  onSuccess: () => router.push('/scripts'),
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
