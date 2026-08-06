'use client'

import { useEffect, useState } from 'react'
import { Lock, RefreshCw, Stethoscope } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DoctorResponseSchema, ToolsResponseSchema } from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { api, useAction } from '@/lib/actions'
import { fileSize } from '@/lib/format'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

/** Mirrors `@enkaku/core`'s `doctor/types.ts` — the exact same shape `enkaku doctor --json` prints (plan 41 §4.5, §6.8). */
type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
interface DoctorCheckResult {
  id: string
  title: string
  status: DoctorCheckStatus
  observed: string
  remedy?: string
}
interface DoctorRun {
  results: DoctorCheckResult[]
  exitCode: 0 | 1
}

// The `/api/tools/:id/...` action routes (`packages/core/src/tools/routes.ts`)
// have no shared envelope in `@enkaku/protocol` — each is a small, distinct
// shape only ever used to decide whether the action succeeded (`act`'s
// `onSuccess` always just re-fetches `/api/tools`, never reads the body), so
// these are declared locally rather than added to protocol for one page.
const ToolOkSchema = z.object({ ok: z.boolean() })
const ToolManifestRefreshSchema = z.object({ ok: z.boolean(), updatedAt: z.number(), tools: z.number() })
const ToolCheckSchema = z.object({ health: z.object({ ok: z.boolean(), checkedAt: z.number(), detail: z.string() }).nullable() })
const ToolRepairSchema = z.object({
  ok: z.boolean(),
  repaired: z.array(z.string()),
  failed: z.array(z.object({ toolId: z.string(), code: z.string(), message: z.string() })),
})

const DOCTOR_TONE: Record<DoctorCheckStatus, string> = {
  ok: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  warn: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  fail: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  skip: 'text-fg-subtle border-line bg-transparent',
}

interface ToolEntry {
  id: string
  displayName: string
  swappable: boolean
  managedByCore: boolean
  activeVersion: string | null
  installed: Array<{ version: string; active: boolean; sha256: string | null; installedAt: number | null }>
  available: Array<{ version: string; knownGood: boolean; installable: boolean }>
  health: { ok: boolean; checkedAt: number; detail: string } | null
}

interface InstallProgress {
  phase: string
  percent: number | null
  bytes?: number
  total?: number | null
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null)
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({})
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<DoctorRun | null>(null)
  const { run, isPending } = useAction()

  const runDiagnostics = () =>
    run('diagnostics', () => api('/api/doctor', DoctorResponseSchema), { failure: 'Diagnostics failed', onSuccess: setDiagnostics })

  const load = () => {
    setError(null)
    api('/api/tools', ToolsResponseSchema)
      .then((b) => setTools(b.tools))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    load()
    const off = ws.on((m) => {
      if (m.type === 'tool.install.progress') {
        setProgress((p) => ({
          ...p,
          [m.payload.toolId]: {
            phase: m.payload.phase,
            percent: m.payload.percent ?? null,
            ...(m.payload.bytesReceived !== undefined ? { bytes: m.payload.bytesReceived } : {}),
            ...(m.payload.totalBytes !== undefined ? { total: m.payload.totalBytes } : {}),
          },
        }))
        if (m.payload.phase === 'done' || m.payload.phase === 'error') {
          setProgress((p) => {
            const { [m.payload.toolId]: _, ...rest } = p
            return rest
          })
          load()
        }
      } else if (m.type === 'tool.changed') load()
    })
    return off
  }, [])

  const act = <S extends z.ZodType>(key: string, path: string, schema: S, init: RequestInit & { json?: unknown }, success: string) =>
    run(key, () => api(path, schema, init), { success, failure: 'Tool action failed', onSuccess: load })

  /**
   * Re-runs provisioning for the core-managed tools. Partial success is
   * reported as such: saying "reinstalled" when one of them failed again would
   * send the operator back to a page that still reads "not installed".
   */
  const repairPinned = () =>
    run('repair', () => api('/api/tools/repair', ToolRepairSchema, { method: 'POST' }), {
      failure: 'Reinstall failed',
      onSuccess: (result) => {
        load()
        if (result.ok) toast.success('Tools reinstalled')
        else toast.error(`${result.failed.length} tool(s) still missing`, { description: result.failed[0]?.message })
      },
    })

  const swappable = tools?.filter((t) => t.swappable) ?? []
  const pinned = tools?.filter((t) => !t.swappable) ?? []

  return (
    <>
      <PageHeader
        title="Tools"
        description="Binaries the core uses to talk to devices"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={isPending('diagnostics')} onClick={() => void runDiagnostics()}>
              <Stethoscope className={cn('size-4', isPending('diagnostics') && 'animate-pulse')} aria-hidden />
              Run diagnostics
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending('refresh')}
              onClick={() => void act('refresh', '/api/tools/manifest/refresh', ToolManifestRefreshSchema, { method: 'POST' }, 'Manifest refreshed')}
            >
              <RefreshCw className={cn('size-4', isPending('refresh') && 'animate-spin')} aria-hidden />
              Refresh manifest
            </Button>
          </>
        }
      />

      <div className="space-y-3 px-5 py-4">
        {diagnostics && (
          <div className="rounded-lg border bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[14px] font-semibold tracking-tight">Diagnostics</h2>
              <span className="readout text-[11.5px] text-fg-muted">
                exit code {diagnostics.exitCode} · {diagnostics.results.filter((r) => r.status === 'fail').length} failed,{' '}
                {diagnostics.results.filter((r) => r.status === 'warn').length} warnings
              </span>
            </div>
            <dl className="mt-3 divide-y overflow-hidden rounded border">
              {diagnostics.results.map((r) => (
                <div key={r.id} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
                        DOCTOR_TONE[r.status],
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" aria-hidden />
                      {r.status}
                    </span>
                    <dt className="text-[12.5px] font-medium">{r.title}</dt>
                  </div>
                  <dd className="readout text-[11.5px] text-fg-muted">{r.observed}</dd>
                  {r.remedy && <dd className="text-[11.5px] text-led-warn">→ {r.remedy}</dd>}
                </div>
              ))}
            </dl>
          </div>
        )}
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : tools === null ? (
          <LoadingRows rows={3} />
        ) : (
          swappable.map((tool) => {
            const p = progress[tool.id]
            return (
              <div key={tool.id} className="rounded-lg border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
                      {tool.displayName}
                      {tool.managedByCore && (
                        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-normal text-fg-muted">
                          <Lock className="size-3" aria-hidden />
                          pinned to the core version
                        </span>
                      )}
                    </h2>
                    <p className="readout mt-0.5 text-[11.5px] text-fg-muted">
                      active: {tool.activeVersion ?? 'not installed'}
                      {tool.health && (
                        <span className={tool.health.ok ? 'text-led-ok' : 'text-led-danger'}>
                          {' · '}
                          {tool.health.ok ? 'healthy' : 'unhealthy'}
                        </span>
                      )}
                    </p>
                  </div>
                  {tool.swappable && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[12px]"
                      disabled={isPending('check-' + tool.id)}
                      onClick={() =>
                        void act('check-' + tool.id, `/api/tools/${tool.id}/check`, ToolCheckSchema, { method: 'POST' }, 'Health check finished')
                      }
                    >
                      Check
                    </Button>
                  )}
                </div>

                {p && (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex justify-between text-[11.5px] text-fg-muted">
                      <span>{phaseLabel(p.phase)}</span>
                      <span className="readout">
                        {p.percent !== null ? `${p.percent}%` : ''}
                        {p.bytes !== undefined && p.total ? ` · ${fileSize(p.bytes)} / ${fileSize(p.total)}` : ''}
                      </span>
                    </div>
                    <Progress value={p.percent ?? 0} />
                  </div>
                )}

                {(
                  <div className="mt-3 divide-y overflow-hidden rounded border">
                    {tool.available.map((v) => {
                      const installed = tool.installed.find((i) => i.version === v.version)
                      const active = tool.activeVersion === v.version
                      return (
                        <div key={v.version} className="flex items-center gap-3 px-3 py-2">
                          <span className="readout text-[12.5px]">{v.version}</span>
                          {v.knownGood && <span className="rack-label">tested</span>}
                          {active && (
                            <span className="rounded-full border border-led-ok/35 bg-led-ok/10 px-2 py-0.5 text-[10.5px] text-led-ok">
                              active
                            </span>
                          )}
                          <div className="ml-auto flex gap-1">
                            {!installed && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 text-[12px]"
                                disabled={!v.installable || isPending('inst-' + v.version)}
                                onClick={() =>
                                  void act(
                                    'inst-' + v.version,
                                    `/api/tools/${tool.id}/install`,
                                    ToolOkSchema,
                                    { method: 'POST', json: { version: v.version } },
                                    `${tool.id} ${v.version} installed`,
                                  )
                                }
                              >
                                Install
                              </Button>
                            )}
                            {installed && !active && (
                              <>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-7 text-[12px]"
                                  disabled={isPending('act-' + v.version)}
                                  onClick={() =>
                                    void act(
                                      'act-' + v.version,
                                      `/api/tools/${tool.id}/activate`,
                                      ToolOkSchema,
                                      { method: 'POST', json: { version: v.version } },
                                      `${tool.id} ${v.version} activated`,
                                    )
                                  }
                                >
                                  Activate
                                </Button>
                                <ConfirmDialog
                                  trigger={
                                    <Button size="sm" variant="ghost" className="h-7 text-[12px]">
                                      Delete
                                    </Button>
                                  }
                                  title={`Delete ${tool.id} ${v.version}?`}
                                  description="The files are removed from disk. This version can be installed again at any time."
                                  onConfirm={() =>
                                    act(
                                      'del-' + v.version,
                                      `/api/tools/${tool.id}/${v.version}`,
                                      ToolOkSchema,
                                      { method: 'DELETE' },
                                      'Version deleted',
                                    )
                                  }
                                />
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}

        {/* Version-pinned tools are grouped together: the explanation is the
            same for all of them, and repeating it per card only adds reading. */}
        {pinned.length > 0 && (
          <div className="rounded-lg border bg-surface p-4">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
              <Lock className="size-3.5 text-fg-subtle" aria-hidden />
              Pinned to the core version
            </h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-fg-muted">
              The protocol between these tools and the core changes between versions with no compatibility guarantee.
              Their version follows the core release — raising one means raising the other.
            </p>
            {/* These tools cannot be installed by version (they are not
                swappable), so a boot-time install failure would otherwise only
                be recoverable by restarting the core. */}
            {pinned.some((t) => !t.activeVersion) && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-led-warn/35 bg-led-warn/10 px-3 py-2">
                <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-fg-muted">
                  Some of these did not install. Devices still work, but mirroring or the inspector will not.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending('repair')}
                  onClick={() => void repairPinned()}
                >
                  <RefreshCw className={cn('size-4', isPending('repair') && 'animate-spin')} aria-hidden />
                  Reinstall missing
                </Button>
              </div>
            )}
            <dl className="mt-3 divide-y overflow-hidden rounded border">
              {pinned.map((tool) => (
                <div key={tool.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <dt className="min-w-0 flex-1 truncate text-[12.5px]">{tool.displayName}</dt>
                  <dd className="readout text-[12px] text-fg-muted">{tool.activeVersion ?? 'not installed'}</dd>
                  {tool.health && (
                    <dd className={cn('text-[11.5px]', tool.health.ok ? 'text-led-ok' : 'text-led-danger')}>
                      {tool.health.ok ? 'healthy' : 'unhealthy'}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </>
  )
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    download: 'Downloading',
    verify: 'Verifying checksum',
    extract: 'Extracting',
    done: 'Done',
    error: 'Failed',
  }
  return labels[phase] ?? phase
}
