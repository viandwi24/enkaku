'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { DoctorResponseSchema, ToolsResponseSchema } from '@enkaku/protocol'
import { ArrowsClockwiseIcon, Button, ConfirmDialog, ErrorState, LoadingRows, Progress, api, cn, fileSize, useAction } from '@enkaku/ui'
import { AdbRestartDialog } from '@/components/AdbRestartDialog'
import { AppRestartDialog } from '@/components/AppRestartDialog'
import { isAdmin, useAuth } from '@/lib/auth'
import { ws } from '@/lib/ws'

/**
 * plan 219 §4.8 — replaces `app/tools/page.tsx` (deleted, §10) as a Settings
 * section rather than a standalone page: tool versions, doctor diagnostics,
 * and the two restart dialogs, spliced beside Advanced under the Farm group
 * (`docs/mvp/12-settings.md` §1's own order). `AdbRestartDialog` and
 * `AppRestartDialog` are imported UNCHANGED (plan 216 §3.3) — only the
 * surrounding card is new. `AdbServerCard.tsx`/`AppRestartCard.tsx` are
 * deleted; their content folds in here.
 *
 * `Lock`/`Stethoscope` (lucide, on the old page) have no `LockIcon`/
 * `StethoscopeIcon` in plan 204's barrel (`packages/ui/src/icons.ts`) — this
 * plan does not extend it for two icons a bespoke, undesigned section needs;
 * the "pinned to the core version" badge and "Run diagnostics" render
 * text-only, the same discipline plan 213 used for its one added icon.
 * `ArrowsClockwiseIcon` (already in the barrel) covers "Refresh manifest" and
 * "Reinstall missing".
 */

/** Shown on every control this page disables for a non-admin (`tool.manage`, admin-only in `packages/core/src/auth/acl.ts` — listing and diagnostics stay on `tool.view`, which every role has). */
const ADMIN_ONLY = 'Only an admin can do this'

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
  ok: 'text-ok border-ok/35 bg-ok/10',
  warn: 'text-warn border-warn/35 bg-warn-soft',
  fail: 'text-danger border-danger/40 bg-danger-soft',
  skip: 'text-faint border-line bg-transparent',
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

export function ToolchainSection() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null)
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({})
  const [error, setError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<DoctorRun | null>(null)
  const { run, isPending } = useAction()
  const { user } = useAuth()
  // `tool.manage` (install/activate/delete/repair/refresh) is admin-only —
  // `tool.view` (the list, diagnostics) is not, so those two stay enabled
  // for an operator below (see `isAdmin`'s doc comment).
  const canManage = isAdmin(user)

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
    <div className="space-y-4">
      <div>
        <h2 className="border-b border-line pb-3 text-section font-semibold text-text">Toolchain</h2>
        <p className="pt-3.5 text-meta text-dim">Binaries the core uses to talk to devices, and the two restarts that affect the whole farm.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={isPending('diagnostics')} onClick={() => void runDiagnostics()}>
          Run diagnostics
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canManage || isPending('refresh')}
          title={canManage ? undefined : ADMIN_ONLY}
          onClick={() => void act('refresh', '/api/tools/manifest/refresh', ToolManifestRefreshSchema, { method: 'POST' }, 'Manifest refreshed')}
        >
          <ArrowsClockwiseIcon className={cn('size-3.5', isPending('refresh') && 'animate-spin')} aria-hidden />
          Refresh manifest
        </Button>
      </div>

      {/* Restart cards — folded from `AdbServerCard.tsx` and
          `AppRestartCard.tsx` (deleted, §10). `AdbRestartDialog` and
          `AppRestartDialog` are imported UNCHANGED (plan 216 §3.3); only the
          surrounding card is new. */}
      <div className="rounded-card border border-line-2 bg-panel-2 p-4">
        <h3 className="text-row font-semibold text-text">adb server</h3>
        <p className="mt-1 text-meta text-faint">Shared with every other program on this machine using adb. Restarting it disconnects them all for a few seconds.</p>
        <AdbRestartDialog
          trigger={
            <Button size="sm" variant="outline" className="mt-3" disabled={!canManage} title={canManage ? undefined : ADMIN_ONLY}>
              Restart adb server
            </Button>
          }
        />
      </div>
      <div className="rounded-card border border-danger/30 bg-panel-2 p-4">
        <h3 className="text-row font-semibold text-text">Enkaku itself</h3>
        <p className="mt-1 text-meta text-faint">Every live session and stream drops; every in-flight job is interrupted.</p>
        <AppRestartDialog
          trigger={
            <Button size="sm" variant="outline" className="mt-3 text-danger" disabled={!canManage} title={canManage ? undefined : ADMIN_ONLY}>
              Restart Enkaku
            </Button>
          }
        />
      </div>

      {diagnostics && (
        <div className="rounded-card border border-line-2 bg-panel-2 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-row font-semibold text-text">Diagnostics</h3>
            <span className="font-mono text-meta text-faint">
              exit code {diagnostics.exitCode} · {diagnostics.results.filter((r) => r.status === 'fail').length} failed,{' '}
              {diagnostics.results.filter((r) => r.status === 'warn').length} warnings
            </span>
          </div>
          <dl className="mt-3 divide-y divide-line overflow-hidden rounded-inner border border-line-2">
            {diagnostics.results.map((r) => (
              <div key={r.id} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-meta font-medium leading-none whitespace-nowrap',
                      DOCTOR_TONE[r.status],
                    )}
                  >
                    <span className="size-1.5 rounded-pill bg-current" aria-hidden />
                    {r.status}
                  </span>
                  <dt className="text-body font-medium text-text">{r.title}</dt>
                </div>
                <dd className="font-mono text-meta text-faint">{r.observed}</dd>
                {r.remedy && <dd className="text-meta text-warn">→ {r.remedy}</dd>}
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
            <div key={tool.id} className="rounded-card border border-line-2 bg-panel-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-row font-semibold text-text">
                    {tool.displayName}
                    {tool.managedByCore && (
                      <span className="inline-flex items-center gap-1 rounded-pill border border-line-2 px-2 py-0.5 text-tip font-normal text-faint">
                        pinned to the core version
                      </span>
                    )}
                  </h3>
                  <p className="mt-0.5 font-mono text-meta text-faint">
                    active: {tool.activeVersion ?? 'not installed'}
                    {tool.health && (
                      <span className={tool.health.ok ? 'text-ok' : 'text-danger'}>
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
                    className="h-7"
                    disabled={!canManage || isPending('check-' + tool.id)}
                    title={canManage ? undefined : ADMIN_ONLY}
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
                  <div className="flex justify-between text-meta text-faint">
                    <span>{phaseLabel(p.phase)}</span>
                    <span className="font-mono">
                      {p.percent !== null ? `${p.percent}%` : ''}
                      {p.bytes !== undefined && p.total ? ` · ${fileSize(p.bytes)} / ${fileSize(p.total)}` : ''}
                    </span>
                  </div>
                  <Progress value={p.percent ?? 0} />
                </div>
              )}

              <div className="mt-3 divide-y divide-line overflow-hidden rounded-inner border border-line-2">
                {tool.available.map((v) => {
                  const installed = tool.installed.find((i) => i.version === v.version)
                  const active = tool.activeVersion === v.version
                  return (
                    <div key={v.version} className="flex items-center gap-3 px-3 py-2">
                      <span className="font-mono text-body text-text">{v.version}</span>
                      {v.knownGood && <span className="text-tip text-faint">tested</span>}
                      {active && (
                        <span className="rounded-pill border border-ok/35 bg-ok/10 px-2 py-0.5 text-tip text-ok">
                          active
                        </span>
                      )}
                      <div className="ml-auto flex gap-1">
                        {!installed && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7"
                            disabled={!canManage || !v.installable || isPending('inst-' + v.version)}
                            title={!canManage ? ADMIN_ONLY : undefined}
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
                              className="h-7"
                              disabled={!canManage || isPending('act-' + v.version)}
                              title={!canManage ? ADMIN_ONLY : undefined}
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
                                <Button size="sm" variant="ghost" className="h-7" disabled={!canManage} title={!canManage ? ADMIN_ONLY : undefined}>
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
            </div>
          )
        })
      )}

      {/* Version-pinned tools are grouped together: the explanation is the
          same for all of them, and repeating it per card only adds reading. */}
      {pinned.length > 0 && (
        <div className="rounded-card border border-line-2 bg-panel-2 p-4">
          <h3 className="flex items-center gap-2 text-row font-semibold text-text">Pinned to the core version</h3>
          <p className="mt-1 max-w-2xl text-meta leading-relaxed text-faint">
            The protocol between these tools and the core changes between versions with no compatibility guarantee.
            Their version follows the core release — raising one means raising the other.
          </p>
          {/* These tools cannot be installed by version (they are not
              swappable), so a boot-time install failure would otherwise only
              be recoverable by restarting the core. */}
          {pinned.some((t) => !t.activeVersion) && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-inner border border-warn/35 bg-warn-soft px-3 py-2">
              <p className="min-w-0 flex-1 text-meta leading-relaxed text-faint">
                Some of these did not install. Devices still work, but mirroring or the inspector will not.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!canManage || isPending('repair')}
                title={canManage ? undefined : ADMIN_ONLY}
                onClick={() => void repairPinned()}
              >
                <ArrowsClockwiseIcon className={cn('size-3.5', isPending('repair') && 'animate-spin')} aria-hidden />
                Reinstall missing
              </Button>
            </div>
          )}
          <dl className="mt-3 divide-y divide-line overflow-hidden rounded-inner border border-line-2">
            {pinned.map((tool) => (
              <div key={tool.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <dt className="min-w-0 flex-1 truncate text-body text-text">{tool.displayName}</dt>
                <dd className="font-mono text-meta text-faint">{tool.activeVersion ?? 'not installed'}</dd>
                {tool.health && (
                  <dd className={cn('text-meta', tool.health.ok ? 'text-ok' : 'text-danger')}>
                    {tool.health.ok ? 'healthy' : 'unhealthy'}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}
