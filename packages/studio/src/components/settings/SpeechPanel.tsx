'use client'

import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import {
  MediaTranscribeCheckOutputSchema,
  MediaTranscribeStatusOutputSchema,
  ToolsResponseSchema,
  UpdateSettingsResponseSchema,
  type FarmSettings,
  type MediaTranscribeCheckOutput,
  type MediaTranscribeStatusOutput,
  type WhisperModelEntry,
  type WhisperModelName,
} from '@enkaku/protocol'
import { BadResponseError, Badge, Button, ConfirmDialog, Input, Progress, Spinner, api, cn, fileSize, useAction } from '@enkaku/ui'
import { isAdmin, useAuth } from '@/lib/auth'
import { ws } from '@/lib/ws'

/**
 * Settings → AI → Speech (plan 318): everything about local transcription in
 * one place — which whisper-cli is used and whether it runs, which model, and
 * a doctor that proves the two work together. Beside the AI form rather than
 * inside it because a model is a download, not a value.
 *
 * Two doors, both existing ones: the settings row (`PATCH /api/settings`,
 * `ai.whisperCliPath` / `ai.whisperModel`) and the toolchain
 * (`/api/tools/:id/...`, admin-only, like the Toolchain section). The status
 * and the doctor are capabilities (`media.transcribe.status`, `.check`).
 */

const ADMIN_ONLY = 'Only an admin can do this'

const ToolOkSchema = z.object({ ok: z.boolean() })

const SOURCE_LABEL: Record<MediaTranscribeStatusOutput['cli']['source'], string> = {
  setting: 'from the path below',
  env: 'from ENKAKU_WHISPER_CPP_PATH',
  managed: 'installed by Enkaku',
  missing: 'not found',
}

const STEP_TONE: Record<MediaTranscribeCheckOutput['steps'][number]['status'], string> = {
  ok: 'text-ok border-ok/35 bg-ok/10',
  fail: 'text-danger border-danger/40 bg-danger-soft',
  skip: 'text-faint border-line bg-transparent',
}

async function invokeCap<S extends z.ZodType>(id: string, schema: S): Promise<z.infer<S>> {
  const path = `/api/v1/cap/${id}`
  const raw = await api(path, z.object({ ok: z.literal(true), output: z.unknown() }), { json: {} })
  const parsed = schema.safeParse(raw.output)
  if (!parsed.success) throw new BadResponseError(path, z.prettifyError(parsed.error))
  return parsed.data
}

type ToolEntry = z.infer<typeof ToolsResponseSchema>['tools'][number]

interface InstallProgress {
  phase: string
  percent: number | null
}

export function SpeechPanel({ settings, onSaved }: { settings: FarmSettings; onSaved: (settings: FarmSettings) => void }) {
  const [status, setStatus] = useState<MediaTranscribeStatusOutput | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [tools, setTools] = useState<ToolEntry[]>([])
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({})
  const [cliPath, setCliPath] = useState(settings.ai.whisperCliPath)
  const [check, setCheck] = useState<MediaTranscribeCheckOutput | null>(null)
  const { run, isPending } = useAction()
  const { user } = useAuth()
  const canManage = isAdmin(user)

  const load = useCallback(() => {
    void invokeCap('media.transcribe.status', MediaTranscribeStatusOutputSchema)
      .then((s) => {
        setStatus(s)
        setStatusError(null)
      })
      .catch((e: unknown) => setStatusError(e instanceof Error ? e.message : String(e)))
    void api('/api/tools', ToolsResponseSchema)
      .then((b) => setTools(b.tools.filter((t) => t.id.startsWith('whisper-'))))
      .catch(() => setTools([]))
  }, [])

  useEffect(() => {
    load()
    const off = ws.on((m) => {
      if (m.type === 'tool.install.progress') {
        if (!m.payload.toolId.startsWith('whisper-')) return
        if (m.payload.phase === 'done' || m.payload.phase === 'error') {
          setProgress((p) => {
            const { [m.payload.toolId]: _, ...rest } = p
            return rest
          })
          load()
        } else {
          setProgress((p) => ({ ...p, [m.payload.toolId]: { phase: m.payload.phase, percent: m.payload.percent ?? null } }))
        }
      } else if (m.type === 'tool.changed') load()
    })
    return off
  }, [load])

  // A background download started by a status call reports nothing over the socket until it finishes; poll while it runs.
  useEffect(() => {
    if (!status?.provisioning) return
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [status?.provisioning, load])

  useEffect(() => setCliPath(settings.ai.whisperCliPath), [settings.ai.whisperCliPath])

  const saveAi = (key: string, patch: Partial<FarmSettings['ai']>, success: string) =>
    run(key, () => api('/api/settings', UpdateSettingsResponseSchema, { method: 'PATCH', json: { ai: patch } }), {
      success,
      failure: 'Could not save',
      onSuccess: (b) => {
        onSaved(b.settings)
        load()
      },
    })

  const toolFor = (id: string) => tools.find((t) => t.id === id)

  /** Install when missing, then activate: a model has one version and is only usable once active. */
  const installModel = (model: WhisperModelEntry) =>
    run(
      `install-${model.id}`,
      async () => {
        const tool = toolFor(model.id)
        const version = tool?.available[0]?.version ?? tool?.installed[0]?.version
        if (!version) throw new Error(`${model.id} is not in the toolchain manifest`)
        if (!tool?.installed.some((i) => i.version === version)) {
          await api(`/api/tools/${model.id}/install`, ToolOkSchema, { method: 'POST', json: { version } })
        }
        return api(`/api/tools/${model.id}/activate`, ToolOkSchema, { method: 'POST', json: { version } })
      },
      { success: `${model.name} model installed`, failure: 'Install failed', onSuccess: load },
    )

  const uninstallModel = (model: WhisperModelEntry) =>
    run(
      `uninstall-${model.id}`,
      async () => {
        const tool = toolFor(model.id)
        if (tool?.activeVersion) await api(`/api/tools/${model.id}/deactivate`, ToolOkSchema, { method: 'POST' })
        for (const v of tool?.installed ?? []) await api(`/api/tools/${model.id}/${encodeURIComponent(v.version)}`, ToolOkSchema, { method: 'DELETE' })
        return { ok: true }
      },
      { success: `${model.name} model removed`, failure: 'Uninstall failed', onSuccess: load },
    )

  const runCheck = () => run('check', () => invokeCap('media.transcribe.check', MediaTranscribeCheckOutputSchema), { failure: 'Check failed', onSuccess: setCheck })

  if (statusError) return <p className="mt-4 rounded-inner border border-warn/30 bg-warn-soft px-3 py-2 text-body text-warn">Speech status unavailable: {statusError}</p>
  if (!status) return <div className="mt-4 px-[14px] py-3 text-body text-dim">Reading speech transcription status…</div>

  const whisperCpp = toolFor('whisper-cpp')
  const noPinnedBuild = whisperCpp !== undefined && !whisperCpp.available.some((v) => v.installable) && whisperCpp.installed.length === 0
  const cliDirty = cliPath.trim() !== settings.ai.whisperCliPath

  return (
    <div className="mt-6 space-y-3">
      <div>
        <h2 className="border-b border-line pb-3 text-section font-semibold text-text">Speech</h2>
        <p className="pt-3.5 text-meta text-dim">Local transcription with whisper.cpp. Audio never leaves this machine.</p>
      </div>

      <div className="space-y-1.5 rounded-inner border border-line bg-panel-2 px-3 py-2.5">
        <Row label="status" value={status.available ? 'ready' : 'unavailable'} bad={!status.available} note={status.provisioning ? 'downloading' : undefined} />
        <Row label="whisper-cli" value={status.cli.path ?? 'not found'} note={SOURCE_LABEL[status.cli.source]} bad={status.cli.detail !== null} />
        {whisperCpp?.health && <Row label="health" value={whisperCpp.health.detail} bad={!whisperCpp.health.ok} />}
        <Row label="model" value={status.model ?? `${settings.ai.whisperModel} (not installed)`} bad={status.model === null} />
      </div>

      {status.reason && <p className="rounded-inner border border-warn/30 bg-warn-soft px-3 py-2 text-body text-warn">{status.reason}</p>}

      {noPinnedBuild && (
        <p className="rounded-inner border border-line bg-panel-2 px-3 py-2 text-body text-dim">
          Enkaku has no pinned whisper.cpp build for this host yet. Install it yourself — on macOS <span className="font-mono">brew install whisper-cpp</span> — and set the path below
          (Homebrew puts it at <span className="font-mono">/opt/homebrew/bin/whisper-cli</span>).
        </p>
      )}

      <div className="space-y-2.5 rounded-inner border border-line bg-panel-2 px-3 py-2.5">
        <p className="text-label text-faint">WHISPER-CLI PATH</p>
        <p className="text-body text-dim">Empty uses ENKAKU_WHISPER_CPP_PATH, then the build Enkaku installed.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={cliPath} onChange={(e) => setCliPath(e.target.value)} placeholder="/opt/homebrew/bin/whisper-cli" className="h-8 min-w-0 flex-1 font-mono text-[12px]" />
          <Button size="sm" disabled={!cliDirty || isPending('cli')} onClick={() => void saveAi('cli', { whisperCliPath: cliPath.trim() }, 'whisper-cli path saved')}>
            Save
          </Button>
          {settings.ai.whisperCliPath && (
            <Button size="sm" variant="ghost" disabled={isPending('cli')} onClick={() => void saveAi('cli', { whisperCliPath: '' }, 'whisper-cli path cleared')}>
              Clear
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2.5 rounded-inner border border-line bg-panel-2 px-3 py-2.5">
        <p className="text-label text-faint">MODEL</p>
        <p className="text-body text-dim">Multilingual. Larger is more accurate and slower. Only the model in use downloads on its own.</p>
        <div className="divide-y divide-line overflow-hidden rounded-inner border border-line">
          {status.models.map((model) => {
            const p = progress[model.id]
            const busy = isPending(`install-${model.id}`) || isPending(`uninstall-${model.id}`)
            const managed = (toolFor(model.id)?.installed.length ?? 0) > 0
            return (
              <div key={model.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-[64px] text-body font-medium text-text capitalize">{model.name}</span>
                  <span className="font-mono text-meta text-faint">{fileSize(model.sizeBytes)}</span>
                  {model.active && <Badge variant="outline">in use</Badge>}
                  {model.installed ? <span className="text-tip text-ok">installed</span> : <span className="text-tip text-faint">not installed</span>}
                  <div className="ml-auto flex gap-1">
                    {!model.active && (
                      <Button size="sm" variant="secondary" className="h-7" disabled={isPending('model')} onClick={() => void saveAi('model', { whisperModel: model.name as WhisperModelName }, `Using the ${model.name} model`)}>
                        Use
                      </Button>
                    )}
                    {!model.installed && (
                      <Button size="sm" variant="secondary" className="h-7" disabled={!canManage || busy || p !== undefined} title={canManage ? undefined : ADMIN_ONLY} onClick={() => void installModel(model)}>
                        {busy ? <Spinner className="size-3.5" /> : null}
                        Install
                      </Button>
                    )}
                    {managed && (
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" variant="ghost" className="h-7" disabled={!canManage || busy} title={canManage ? undefined : ADMIN_ONLY}>
                            Uninstall
                          </Button>
                        }
                        title={`Uninstall the ${model.name} model?`}
                        description={model.active ? 'This is the model in use: transcription stops until it is installed again or another model is chosen.' : 'The file is removed from disk. It can be installed again at any time.'}
                        onConfirm={() => uninstallModel(model)}
                      />
                    )}
                  </div>
                </div>
                {p && (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between text-meta text-faint">
                      <span className="capitalize">{p.phase}</span>
                      <span className="font-mono">{p.percent !== null ? `${p.percent}%` : ''}</span>
                    </div>
                    <Progress value={p.percent ?? 0} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-2.5 rounded-inner border border-line bg-panel-2 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-label text-faint">CHECK</p>
          <Button size="sm" variant="outline" disabled={isPending('check')} onClick={() => void runCheck()}>
            {isPending('check') ? <Spinner className="size-3.5" /> : null}
            {isPending('check') ? 'Checking…' : 'Run check'}
          </Button>
        </div>
        <p className="text-body text-dim">Runs whisper-cli, verifies the model, and transcribes one second of silence. Downloads nothing.</p>
        {check && (
          <dl className="divide-y divide-line overflow-hidden rounded-inner border border-line">
            {check.steps.map((s) => (
              <div key={s.id} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-meta font-medium leading-none whitespace-nowrap', STEP_TONE[s.status])}>
                    <span className="size-1.5 rounded-pill bg-current" aria-hidden />
                    {s.status}
                  </span>
                  <dt className="text-body font-medium text-text">{s.title}</dt>
                </div>
                <dd className="font-mono text-meta break-all text-faint">{s.detail}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, note, bad }: { label: string; value: string; note?: string; bad?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-body">
      <span className="w-[110px] flex-none text-faint">{label}</span>
      <span className={cn('min-w-0 flex-1 font-mono text-[11.5px] break-all', bad ? 'text-warn' : 'text-text')}>{value}</span>
      {note && <Badge variant="outline">{note}</Badge>}
    </div>
  )
}
