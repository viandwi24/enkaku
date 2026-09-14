import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { BadResponseError, Badge, Button, Card, CardContent, ConfirmDialog, Input, Spinner, api, cn, describeApiError, fileSize, useAction } from '@enkaku/ui'
import { z } from 'zod'
import { CORE } from '../shared'

/**
 * The Speech tab: local transcription (Whisper) managed from the plugin that needs it for auto captions.
 *
 * It is the plugin-side twin of Studio's Settings → AI → Speech panel (core plan 318,
 * `packages/studio/src/components/settings/SpeechPanel.tsx`) and adds no backend of its own — every control is one of
 * the farm's existing doors, called with the operator's session:
 *
 * - status and doctor: the capabilities `media.transcribe.status` and `media.transcribe.check` (`POST /api/v1/cap/…`);
 * - the whisper-cli override and the chosen model: the settings row (`PATCH /api/settings`, `ai.whisperCliPath`,
 *   `ai.whisperModel`), which needs `settings.manage`;
 * - installing and removing the whisper.cpp build and the models: the toolchain (`/api/tools/:id/…`), which needs
 *   `tool.manage`.
 *
 * Both permissions are admin-only, so the buttons say so instead of failing on press. Two differences from the Studio
 * panel, both forced by what a plugin view can reach: the schemas are declared here rather than imported from
 * `@enkaku/protocol` (that package is not external to a plugin build, and its barrel would drag the farm's whole schema
 * catalogue into `ui/index.js`), and there is no WS client, so the page reloads after every action and polls while the
 * farm is downloading.
 */

const ADMIN_ONLY = 'Only an admin can do this'

/** How often the page asks again while the farm downloads the CLI or a model in the background. */
const PROVISIONING_POLL_MS = 3000

const WHISPER_CPP = 'whisper-cpp'

const StatusSchema = z.object({
  available: z.boolean(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
  cli: z.object({ path: z.string().nullable(), source: z.enum(['setting', 'env', 'managed', 'missing']), detail: z.string().nullable() }),
  modelId: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string(), sizeBytes: z.number(), installed: z.boolean(), active: z.boolean() })),
  provisioning: z.boolean(),
})
type Status = z.infer<typeof StatusSchema>
type ModelEntry = Status['models'][number]

const CheckSchema = z.object({
  ok: z.boolean(),
  steps: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['ok', 'fail', 'skip']), detail: z.string() })),
})
type Check = z.infer<typeof CheckSchema>

const ToolSchema = z.object({
  id: z.string(),
  activeVersion: z.string().nullable(),
  installed: z.array(z.object({ version: z.string(), active: z.boolean() })),
  available: z.array(z.object({ version: z.string(), installable: z.boolean() })),
  health: z.object({ ok: z.boolean(), detail: z.string() }).nullable(),
})
type Tool = z.infer<typeof ToolSchema>
const ToolsSchema = z.object({ tools: z.array(ToolSchema) })
const ToolOkSchema = z.object({ ok: z.boolean() })

/** Only the two keys this page owns; the rest of the settings row is not this page's business. */
const AiSettingsSchema = z.object({ settings: z.object({ ai: z.object({ whisperCliPath: z.string(), whisperModel: z.string() }) }) })
type AiSettings = z.infer<typeof AiSettingsSchema>['settings']['ai']

/** Local mode answers with the implicit admin; an unreadable answer leaves the buttons on and lets the farm refuse. */
const MeSchema = z.object({ user: z.object({ role: z.string() }).nullable().optional() })

const EnvelopeSchema = z.object({ ok: z.literal(true), output: z.unknown() })

async function cap<S extends z.ZodType>(id: string, output: S): Promise<z.infer<S>> {
  const path = `${CORE}/api/v1/cap/${id}`
  const res = await api(path, EnvelopeSchema, { method: 'POST', json: {} })
  const parsed = output.safeParse(res.output)
  if (!parsed.success) throw new BadResponseError(path, z.prettifyError(parsed.error))
  return parsed.data
}

const SOURCE_WORDS: Record<Status['cli']['source'], string> = {
  setting: 'from the path below',
  env: 'from ENKAKU_WHISPER_CPP_PATH',
  managed: 'installed by Enkaku',
  missing: 'not found',
}

const STEP_TONE: Record<Check['steps'][number]['status'], string> = {
  ok: 'border-ok/35 text-ok',
  fail: 'border-danger/40 text-danger',
  skip: 'border-border text-faint',
}

// ---------------------------------------------------------------------------
// Getting here from elsewhere on the page
// ---------------------------------------------------------------------------

/** Set by the page: switches to the Speech tab in place, so the view (and whatever it holds) is not reloaded. */
export const OpenSpeechContext = createContext<(() => void) | null>(null)

/** The same place as a real URL, for a new browser tab or when no page provides the switch. */
export const SPEECH_HREF = '/plugins/view?name=smm&view=posts&tab=speech'

export function SpeechLink({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  const open = useContext(OpenSpeechContext)
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (open === null || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    open()
  }
  return (
    <a href={SPEECH_HREF} onClick={onClick} className={className}>
      {children}
    </a>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function SpeechPanel({ refreshKey, onRefreshingChange }: { refreshKey: number; onRefreshingChange: (refreshing: boolean) => void }): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [tools, setTools] = useState<Tool[]>([])
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [cliPath, setCliPath] = useState('')
  const [check, setCheck] = useState<Check | null>(null)
  const [canManage, setCanManage] = useState(true)
  const { run, isPending } = useAction()

  const load = useCallback(async (): Promise<void> => {
    onRefreshingChange(true)
    try {
      const [s, t, st] = await Promise.allSettled([
        cap('media.transcribe.status', StatusSchema),
        api(`${CORE}/api/tools`, ToolsSchema),
        api(`${CORE}/api/settings`, AiSettingsSchema),
      ])
      if (s.status === 'fulfilled') {
        setStatus(s.value)
        setStatusError(null)
      } else {
        setStatusError(describeApiError(s.reason))
      }
      setTools(t.status === 'fulfilled' ? t.value.tools.filter((tool) => tool.id.startsWith('whisper-')) : [])
      if (st.status === 'fulfilled') setAi(st.value.settings.ai)
    } finally {
      onRefreshingChange(false)
    }
  }, [onRefreshingChange])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    let cancelled = false
    api(`${CORE}/api/auth/me`, MeSchema)
      .then((me) => {
        if (!cancelled && me.user) setCanManage(me.user.role === 'admin')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // A download started by a status call says nothing until it finishes; ask again while it runs.
  useEffect(() => {
    if (!status?.provisioning) return
    const timer = setInterval(() => void load(), PROVISIONING_POLL_MS)
    return () => clearInterval(timer)
  }, [status?.provisioning, load])

  const savedPath = ai?.whisperCliPath ?? ''
  useEffect(() => setCliPath(savedPath), [savedPath])

  const saveAi = (key: string, patch: Partial<AiSettings>, success: string) =>
    run(key, () => api(`${CORE}/api/settings`, AiSettingsSchema, { method: 'PATCH', json: { ai: patch } }), {
      success,
      failure: 'Could not save',
      onSuccess: (res) => {
        setAi(res.settings.ai)
        void load()
      },
    })

  const toolFor = (id: string): Tool | undefined => tools.find((t) => t.id === id)

  /** Install when missing, then activate: a toolchain entry is only used once it is active. */
  const install = (id: string, name: string) =>
    run(
      `install-${id}`,
      async () => {
        const tool = toolFor(id)
        const version = tool?.available.find((v) => v.installable)?.version ?? tool?.installed[0]?.version
        if (!version) throw new Error(`${id} has no installable version for this host`)
        if (!tool?.installed.some((i) => i.version === version)) {
          await api(`${CORE}/api/tools/${encodeURIComponent(id)}/install`, ToolOkSchema, { method: 'POST', json: { version } })
        }
        return api(`${CORE}/api/tools/${encodeURIComponent(id)}/activate`, ToolOkSchema, { method: 'POST', json: { version } })
      },
      { success: `${name} installed`, failure: 'Install failed', onSuccess: () => void load() },
    )

  const uninstall = (id: string, name: string) =>
    run(
      `uninstall-${id}`,
      async () => {
        const tool = toolFor(id)
        if (tool?.activeVersion) await api(`${CORE}/api/tools/${encodeURIComponent(id)}/deactivate`, ToolOkSchema, { method: 'POST' })
        for (const v of tool?.installed ?? []) {
          await api(`${CORE}/api/tools/${encodeURIComponent(id)}/${encodeURIComponent(v.version)}`, ToolOkSchema, { method: 'DELETE' })
        }
        return { ok: true }
      },
      { success: `${name} removed`, failure: 'Uninstall failed', onSuccess: () => void load() },
    )

  const runCheck = () => run('check', () => cap('media.transcribe.check', CheckSchema), { failure: 'Check failed', onSuccess: setCheck })

  if (status === null) {
    if (statusError !== null) {
      return <p className="rounded-inner border border-warn/35 px-3 py-2 text-[11.5px] text-warn">The farm could not say whether it can transcribe: {statusError}</p>
    }
    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-dim">
        <Spinner className="size-3" /> Reading the speech transcription status…
      </p>
    )
  }

  const whisperCpp = toolFor(WHISPER_CPP)
  const buildInstallable = whisperCpp?.available.some((v) => v.installable) ?? false
  const buildInstalled = (whisperCpp?.installed.length ?? 0) > 0
  const noPinnedBuild = whisperCpp !== undefined && !buildInstallable && !buildInstalled
  const cliDirty = ai !== null && cliPath.trim() !== ai.whisperCliPath
  const manageTitle = canManage ? undefined : ADMIN_ONLY

  return (
    <Card className="@container gap-0 py-0">
      <CardContent className="space-y-5 p-4">
        <Section title="Status" hint="Local transcription with whisper.cpp, for auto captions. Audio never leaves this farm.">
          <p className={cn('flex flex-wrap items-center gap-1.5 text-row font-medium', status.available ? 'text-ok' : 'text-warn')}>
            <span className="size-1.5 rounded-pill bg-current" aria-hidden />
            {status.available ? 'Ready — auto captions can transcribe' : 'Unavailable — auto captions cannot transcribe'}
            {status.provisioning ? (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-normal text-dim">
                <Spinner className="size-3" /> downloading, checking again every few seconds
              </span>
            ) : null}
          </p>
          {status.reason ? <p className="rounded-inner border border-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-warn">{status.reason}</p> : null}
          {statusError !== null ? <p className="text-[11.5px] text-warn">The last refresh failed, so this may be out of date: {statusError}</p> : null}
          <dl className="space-y-1 rounded-inner border border-border px-3 py-2">
            <Row label="whisper-cli" value={status.cli.path ?? 'not found'} note={SOURCE_WORDS[status.cli.source]} bad={status.cli.path === null || status.cli.detail !== null} />
            {status.cli.detail ? <Row label="problem" value={status.cli.detail} bad /> : null}
            <Row
              label="managed build"
              value={whisperCpp?.activeVersion ?? (buildInstalled ? `${whisperCpp?.installed[0]?.version} (not active)` : 'not installed')}
              note={status.cli.source === 'managed' ? 'in use' : undefined}
            />
            {whisperCpp?.health ? <Row label="health" value={whisperCpp.health.detail} bad={!whisperCpp.health.ok} /> : null}
            <Row label="model" value={status.model ?? `${ai?.whisperModel ?? status.modelId.replace(/^whisper-model-/, '')} (not installed)`} bad={status.model === null} />
          </dl>
        </Section>

        <Section title="whisper-cli" hint="Which whisper-cli the farm runs. Empty uses ENKAKU_WHISPER_CPP_PATH, then the build Enkaku installed.">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={cliPath}
              onChange={(e) => setCliPath(e.target.value)}
              placeholder="/opt/homebrew/bin/whisper-cli"
              aria-label="whisper-cli path"
              className="min-w-0 flex-1 font-mono text-[12px]"
              disabled={ai === null}
            />
            <Button size="sm" disabled={!cliDirty || !canManage || isPending('cli')} title={manageTitle} onClick={() => void saveAi('cli', { whisperCliPath: cliPath.trim() }, 'whisper-cli path saved')}>
              {isPending('cli') ? <Spinner className="size-3" /> : null}
              Save
            </Button>
            {savedPath !== '' ? (
              <Button size="sm" variant="ghost" disabled={!canManage || isPending('cli')} title={manageTitle} onClick={() => void saveAi('cli', { whisperCliPath: '' }, 'whisper-cli path cleared')}>
                Clear
              </Button>
            ) : null}
          </div>

          {noPinnedBuild ? (
            <p className="rounded-inner border border-border px-3 py-2 text-[11.5px] leading-relaxed text-dim">
              Enkaku has no pinned whisper.cpp build for this host, so it cannot install one. Install it yourself — on macOS{' '}
              <span className="font-mono">brew install whisper-cpp</span> — and set the path above (Homebrew puts it at{' '}
              <span className="font-mono">/opt/homebrew/bin/whisper-cli</span>).
            </p>
          ) : whisperCpp !== undefined ? (
            <div className="flex flex-wrap items-center gap-2 rounded-inner border border-border px-3 py-2">
              <span className="text-row font-medium">Managed build</span>
              <span className="font-mono text-[11px] text-faint">{whisperCpp.activeVersion ?? whisperCpp.installed[0]?.version ?? whisperCpp.available.find((v) => v.installable)?.version ?? ''}</span>
              {buildInstalled ? <span className="text-[11px] text-ok">installed</span> : <span className="text-[11px] text-faint">not installed</span>}
              <div className="ml-auto flex gap-1">
                {!buildInstalled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage || isPending(`install-${WHISPER_CPP}`)}
                    title={manageTitle}
                    onClick={() => void install(WHISPER_CPP, 'whisper.cpp')}
                  >
                    {isPending(`install-${WHISPER_CPP}`) ? <Spinner className="size-3" /> : null}
                    {isPending(`install-${WHISPER_CPP}`) ? 'Installing…' : 'Install'}
                  </Button>
                ) : (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" disabled={!canManage || isPending(`uninstall-${WHISPER_CPP}`)} title={manageTitle}>
                        Uninstall
                      </Button>
                    }
                    title="Uninstall the whisper.cpp build?"
                    description={
                      status.cli.source === 'managed'
                        ? 'This is the whisper-cli in use: transcription stops until it is installed again or a path is set.'
                        : 'The build is removed from disk. The whisper-cli in use now is not affected.'
                    }
                    confirmLabel="Uninstall"
                    destructive
                    onConfirm={() => uninstall(WHISPER_CPP, 'whisper.cpp')}
                  />
                )}
              </div>
            </div>
          ) : null}
        </Section>

        <Section title="Model" hint="Multilingual. Larger is more accurate and slower. Only the model in use downloads on its own.">
          <ul className="divide-y divide-border rounded-inner border border-border">
            {status.models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                managed={(toolFor(model.id)?.installed.length ?? 0) > 0}
                canManage={canManage}
                choosing={isPending('model')}
                installing={isPending(`install-${model.id}`)}
                removing={isPending(`uninstall-${model.id}`)}
                onUse={() => void saveAi('model', { whisperModel: model.name }, `Using the ${model.name} model`)}
                onInstall={() => void install(model.id, `The ${model.name} model`)}
                onUninstall={() => uninstall(model.id, `The ${model.name} model`)}
              />
            ))}
          </ul>
        </Section>

        <Section title="Check" hint="Runs whisper-cli, verifies the model and transcribes one second of silence. Downloads nothing.">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={isPending('check')} onClick={() => void runCheck()}>
              {isPending('check') ? <Spinner className="size-3" /> : null}
              {isPending('check') ? 'Checking…' : 'Run check'}
            </Button>
            {check !== null ? (
              <span className={cn('text-[11.5px]', check.ok ? 'text-ok' : 'text-danger')}>{check.ok ? 'Every step passed' : 'A step failed — see below'}</span>
            ) : null}
          </div>
          {check !== null ? (
            <ul className="divide-y divide-border rounded-inner border border-border">
              {check.steps.map((step) => (
                <li key={step.id} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-[11px] font-medium leading-none', STEP_TONE[step.status])}>
                      <span className="size-1.5 rounded-pill bg-current" aria-hidden />
                      {step.status}
                    </span>
                    <span className="text-row font-medium">{step.title}</span>
                  </div>
                  <span className="font-mono text-[11px] break-all text-faint">{step.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      </CardContent>
    </Card>
  )
}

function ModelRow({
  model,
  managed,
  canManage,
  choosing,
  installing,
  removing,
  onUse,
  onInstall,
  onUninstall,
}: {
  model: ModelEntry
  /** Installed through the toolchain — the only kind this page can remove. */
  managed: boolean
  canManage: boolean
  choosing: boolean
  installing: boolean
  removing: boolean
  onUse: () => void
  onInstall: () => void
  onUninstall: () => Promise<unknown>
}): ReactElement {
  const title = canManage ? undefined : ADMIN_ONLY
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="w-16 text-row font-medium capitalize">{model.name}</span>
      <span className="font-mono text-[11px] text-faint">{fileSize(model.sizeBytes)}</span>
      {model.active ? <Badge variant="outline">in use</Badge> : null}
      {model.installed ? <span className="text-[11px] text-ok">installed</span> : <span className="text-[11px] text-faint">not installed</span>}
      <div className="ml-auto flex gap-1">
        {!model.active ? (
          <Button size="sm" variant="outline" disabled={!canManage || choosing} title={title} onClick={onUse}>
            Use
          </Button>
        ) : null}
        {!model.installed ? (
          <Button size="sm" variant="outline" disabled={!canManage || installing || removing} title={title} onClick={onInstall}>
            {installing ? <Spinner className="size-3" /> : null}
            {installing ? 'Installing…' : 'Install'}
          </Button>
        ) : null}
        {managed ? (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" disabled={!canManage || installing || removing} title={title}>
                Uninstall
              </Button>
            }
            title={`Uninstall the ${model.name} model?`}
            description={
              model.active
                ? 'This is the model in use: transcription stops until it is installed again or another model is chosen.'
                : 'The file is removed from disk. It can be installed again at any time.'
            }
            confirmLabel="Uninstall"
            destructive
            onConfirm={onUninstall}
          />
        ) : null}
      </div>
    </li>
  )
}

/** The compose page's step heading, without the number: these sections are not an order. */
function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <div className="space-y-0.5">
        <h3 className="text-row font-medium">{title}</h3>
        <p className="text-[11.5px] text-dim">{hint}</p>
      </div>
      {children}
    </section>
  )
}

function Row({ label, value, note, bad }: { label: string; value: string; note?: string; bad?: boolean }): ReactElement {
  return (
    <div className="flex items-baseline gap-3 text-[11.5px]">
      <dt className="w-28 flex-none text-faint">{label}</dt>
      <dd className={cn('min-w-0 flex-1 font-mono break-all', bad ? 'text-warn' : 'text-text')}>{value}</dd>
      {note ? <Badge variant="outline">{note}</Badge> : null}
    </div>
  )
}
