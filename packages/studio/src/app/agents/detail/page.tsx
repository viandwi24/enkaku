'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { z } from 'zod'
import type { AgentRun, AgentThread, AgentTreeNode } from '@enkaku/protocol'
import type { DeviceInfo } from '@enkaku/protocol'
import {
  AgentResponseSchema,
  ConnectorModelsResponseSchema,
  ListCapabilitiesResponseSchema,
  ListConnectorsResponseSchema,
  ListThreadsResponseSchema,
  RunResponseSchema,
  SettingsResponseSchema,
  ThreadResponseSchema,
} from '@enkaku/protocol'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ThreadList } from '@/components/agent/ThreadList'
import { Chat } from '@/components/agent/Chat'
import { ContextPanel } from '@/components/agent/ContextPanel'
import { api, useAction } from '@/lib/actions'
import { fetchDevices } from '@/lib/api'
import { subtreeOf } from '@/lib/agent-tree'
import { ALL_PERMISSIONS, capabilityGroup, looksVolatile, resolveForDisplay, type Agent, type AgentDefaults, type CapabilityInfo, type Connector, type ModelInfo } from '@/lib/agents'

/**
 * The agent workbench (plan 69 §3.1, §4.1, step 69.5) — extends, rather than
 * replaces, two existing screens: the settings editor this file used to BE
 * (plan 65) now lives behind a "Settings" tab, unchanged; the conversation
 * that used to be its own route (`/agents/thread`, plan 66/67) is now the
 * default "Workbench" tab, using the SAME `ThreadList` the workbench's step
 * 69.1–69.4 built, with `Chat` (plan 78 §4.2 — the ported `ai-elements`
 * transcript, replacing `Transcript`) filling the conversation column.
 * `/agents/thread` now redirects here.
 *
 * The Workbench/Settings switch is a `next/link` tab (criterion 12), and
 * BOTH panels stay mounted (CSS `hidden`, never a conditional unmount) once
 * first visited — Plan 42's lesson, applied to `Chat`'s `useChat` stream
 * specifically: switching to Settings and back must not tear it down and
 * drop tokens mid-run (plan 78 criterion 12).
 */

/**
 * Keeps a subtree mounted and toggles visibility with CSS (Plan 42 §3.1,
 * §4.1) — see `device/page.tsx` for the same pattern and its reasoning.
 * `h-full` (plan 73 §3.1, §4.1) so the ACTIVE panel can fill the space below
 * the header/tabs without arithmetic; `hidden` means the size of an inactive
 * panel never matters (`display: none` takes it out of layout entirely).
 */
function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div hidden={!active} aria-hidden={!active} className="h-full min-h-0">
      {children}
    </div>
  )
}

function OverrideRow({ label, overridden, farmValueLabel, onEnable, onClear, children }: { label: string; overridden: boolean; farmValueLabel: string; onEnable(): void; onClear(): void; children: ReactNode }) {
  return (
    <div className="space-y-1.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[13px] font-normal">{label}</Label>
        {overridden ? (
          <button type="button" onClick={onClear} className="flex items-center gap-1 text-[11.5px] text-fg-muted hover:text-fg">
            <RotateCcw className="size-3" aria-hidden />
            Reset to farm default
          </button>
        ) : (
          <button type="button" onClick={onEnable} className="text-[11.5px] text-accent hover:underline">
            Override
          </button>
        )}
      </div>
      {overridden ? (
        children
      ) : (
        <p className="readout rounded-md border border-dashed bg-surface-2/40 px-3 py-1.5 text-[12.5px] text-fg-muted">
          {farmValueLabel} <span className="text-fg-subtle">(farm default)</span>
        </p>
      )}
    </div>
  )
}

function SectionCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="max-w-2xl space-y-4 pb-8">
      <div>
        <h2 className="text-[13.5px] font-medium">{title}</h2>
        {description && <p className="mt-0.5 text-[12px] text-fg-muted">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function AgentDetail() {
  const params = useSearchParams()
  const id = params.get('id')
  const router = useRouter()
  const { run: doAction, isPending } = useAction()

  const [saved, setSaved] = useState<Agent | null>(null)
  const [draft, setDraft] = useState<Agent | null>(null)
  const [farmDefaults, setFarmDefaults] = useState<AgentDefaults | null>(null)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([])
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [models, setModels] = useState<{ models: ModelInfo[]; fallback: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState('identity')
  // Plan 73 §3.3, §8 — a duplicated agent's own detail link carries `focus=name`; read once so a
  // later re-render (e.g. a save) does not keep re-selecting the name field out from under someone
  // who has already moved on.
  const [focusName] = useState(() => params.get('focus') === 'name')

  // The workbench's own state — threads for the sidebar, and the active run/tree bubbled up from
  // `Chat` so the header's Cancel button and confirmation can name the subtree (plan 67 §4.5).
  const tab = params.get('tab') === 'settings' ? 'settings' : 'workbench'
  const threadId = params.get('thread')
  const [threads, setThreads] = useState<AgentThread[] | null>(null)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [treeNodes, setTreeNodes] = useState<AgentTreeNode[]>([])

  const load = () => {
    if (!id) return
    setError(null)
    api(`/api/agents/${id}`, AgentResponseSchema)
      .then((b) => {
        setSaved(b.agent)
        setDraft(b.agent)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [id])

  const loadThreads = () => {
    if (!id) return
    void api(`/api/v1/threads?agentId=${id}`, ListThreadsResponseSchema).then((b) => setThreads(b.threads))
  }
  useEffect(loadThreads, [id])

  useEffect(() => {
    api('/api/settings', SettingsResponseSchema)
      .then((b) => setFarmDefaults(b.settings.agentDefaults))
      .catch(() => undefined)
    api('/api/connectors', ListConnectorsResponseSchema)
      .then((b) => setConnectors(b.connectors))
      .catch(() => undefined)
    api('/api/v1/cap', ListCapabilitiesResponseSchema)
      .then((b) => setCapabilities(b.capabilities))
      // Unlike the other farm-wide fetches on this page, a bad `/api/v1/cap`
      // shape must NOT fail silently — this is the exact route whose bare-array
      // response used to leave `capabilities` `undefined` and crash the Tools
      // tab (plan 72 §3.1). `ToolsSection` below shows this message instead of
      // an empty/loading list forever.
      .catch((e) => setCapabilitiesError(e instanceof Error ? e.message : String(e)))
    void fetchDevices()
      .then(setDevices)
      .catch(() => undefined)
  }, [])

  const connectorId = draft?.connectorId ?? farmDefaults?.connectorId ?? null
  useEffect(() => {
    if (!connectorId) {
      setModels(null)
      return
    }
    api(`/api/connectors/${connectorId}/models`, ConnectorModelsResponseSchema)
      .then(setModels)
      .catch(() => setModels(null))
  }, [connectorId])

  // Reset the run/tree the moment the open thread changes — `Chat` itself resets on mount (a fresh
  // `key={threadId}`) for a new `threadId`, but the PARENT's own mirror (used only for the header's
  // Cancel button) must not go on showing a previous thread's run while a new one loads.
  useEffect(() => {
    setRun(null)
    setTreeNodes([])
  }, [threadId])

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const save = () => {
    if (!draft) return
    doAction(
      'save',
      () =>
        api(`/api/agents/${draft.id}`, AgentResponseSchema, {
          method: 'PATCH',
          json: {
            name: draft.name,
            description: draft.description,
            colour: draft.colour,
            enabled: draft.enabled,
            connectorId: draft.connectorId,
            model: draft.model,
            systemPrompt: draft.systemPrompt,
            settings: draft.settings,
            tools: draft.tools,
            deviceGrants: draft.deviceGrants,
            workspaceScope: draft.workspaceScope,
            permissions: draft.permissions,
          },
        }),
      {
        success: 'Agent saved',
        failure: 'Could not save the agent',
        onSuccess: (b) => {
          setSaved(b.agent)
          setDraft(b.agent)
        },
      },
    )
  }

  const startThread = () =>
    doAction('create-thread', () => api('/api/v1/threads', ThreadResponseSchema, { method: 'POST', json: { agentId: id } }), {
      failure: 'Could not start a conversation',
      onSuccess: (b) => {
        router.push(`/agents/detail?id=${id}&tab=workbench&thread=${b.thread.id}`)
        loadThreads()
      },
    })

  const cancelRun = () => {
    if (!run) return
    void doAction('cancel', () => api(`/api/v1/runs/${run.id}/cancel`, RunResponseSchema, { method: 'POST' }), {
      failure: 'Could not cancel the run',
      onSuccess: (b) => setRun(b.run),
    })
  }

  const subtree = useMemo(() => (run ? subtreeOf(treeNodes, run.id) : []), [treeNodes, run])
  const isRunning = run?.status === 'running' || run?.status === 'queued'
  const isPaused = run?.status === 'paused'

  const resolved = useMemo(() => (draft && farmDefaults ? resolveForDisplay(farmDefaults, draft) : null), [draft, farmDefaults])

  if (!id) return <ErrorState message="No agent id given." />
  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (!draft || !saved || !farmDefaults) return <div className="px-5 py-4"><LoadingRows rows={5} /></div>

  const sections: SettingsSection[] = [
    { id: 'identity', title: 'Identity', render: () => <IdentitySection draft={draft} setDraft={setDraft} autoFocusName={focusName} /> },
    {
      id: 'model',
      title: 'Model',
      render: () => (
        <ModelSection draft={draft} setDraft={setDraft} farmDefaults={farmDefaults} connectors={connectors} models={models} />
      ),
    },
    { id: 'instructions', title: 'Instructions', render: () => <InstructionsSection draft={draft} setDraft={setDraft} farmDefaults={farmDefaults} /> },
    { id: 'tools', title: 'Tools', render: () => <ToolsSection draft={draft} setDraft={setDraft} capabilities={capabilities} error={capabilitiesError} /> },
    { id: 'access', title: 'Access', render: () => <AccessSection draft={draft} setDraft={setDraft} devices={devices} /> },
    { id: 'limits', title: 'Limits', render: () => <LimitsSection draft={draft} setDraft={setDraft} farmDefaults={farmDefaults} /> },
    { id: 'connectors', title: 'Connectors', render: () => <ConnectorsSection connectors={connectors} /> },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={draft.name}
        description={resolved ? `${resolved.model} · ${draft.deviceGrants.length === 0 ? 'all devices' : `${draft.deviceGrants.length} device(s)`}` : undefined}
        meta={
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm">
              <Link href="/agents">
                <ArrowLeft className="size-3.5" aria-hidden />
                Agents
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/agents/runs?agent=${id}`}>Runs</Link>
            </Button>
          </div>
        }
        actions={
          tab === 'settings' ? (
            <>
              <ConfirmDialog
                trigger={
                  <Button variant="outline" size="sm">
                    Delete agent
                  </Button>
                }
                title={`Delete ${draft.name}?`}
                description="This cannot be undone."
                onConfirm={() =>
                  doAction('delete', () => api(`/api/agents/${draft.id}`, z.void(), { method: 'DELETE' }), {
                    success: `${draft.name} deleted`,
                    failure: 'Could not delete the agent',
                    onSuccess: () => router.push('/agents'),
                  })
                }
              />
              <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(saved)}>
                Discard
              </Button>
              <Button size="sm" disabled={!dirty || isPending('save')} onClick={save}>
                {isPending('save') ? 'Saving…' : 'Save changes'}
              </Button>
            </>
          ) : (
            threadId &&
            (isRunning || isPaused) &&
            (subtree.length > 0 ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isPending('cancel')}>
                    {isPending('cancel') ? 'Cancelling…' : 'Cancel'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel this run and its sub-agents?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This cancels {subtree.length + 1} run{subtree.length + 1 === 1 ? '' : 's'} — this one and {subtree.length} sub-agent
                      {subtree.length === 1 ? '' : 's'} — depth-first, releasing every device they hold.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep running</AlertDialogCancel>
                    <AlertDialogAction onClick={cancelRun}>Cancel {subtree.length + 1} runs</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button variant="outline" size="sm" disabled={isPending('cancel')} onClick={cancelRun}>
                {isPending('cancel') ? 'Cancelling…' : 'Cancel'}
              </Button>
            ))
          )
        }
      />

      <EntityTabs
        tabs={[
          { key: 'workbench', label: 'Workbench' },
          { key: 'settings', label: 'Settings' },
        ]}
        active={tab}
        hrefFor={(k) => `/agents/detail?id=${id}${threadId ? `&thread=${threadId}` : ''}${k === 'workbench' ? '' : `&tab=${k}`}`}
      />

      {/* One region below the header owns height for both tabs (plan 73 §3.1) — `min-h-0` is what
          lets it actually shrink to that space instead of growing with its content and pushing
          `main` into its own scrollbar. */}
      <div className="min-h-0 flex-1">
        <TabPanel active={tab === 'workbench'}>
          <div className="flex h-full">
            <ThreadList agentId={id} threads={threads} activeThreadId={threadId} onNewThread={() => void startThread()} newThreadPending={isPending('create-thread')} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {!threadId ? (
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState title="No thread selected" description="Start a new chat, or pick one from the list." />
                </div>
              ) : (
                <Chat
                  key={threadId}
                  threadId={threadId}
                  agent={draft}
                  onRunChange={setRun}
                  onTreeChange={(nodes) => setTreeNodes(nodes)}
                  onAgentChange={(updated) => {
                    // A merge, not an overwrite (plan 73 §4.2) — the composer only ever PATCHes
                    // `model`/`settings`, so this must not clobber an unsaved edit sitting in the
                    // Settings tab's OWN draft (e.g. a half-typed system prompt) if both happen to
                    // be open in the same session.
                    setSaved((p) => (p ? { ...p, model: updated.model, settings: updated.settings } : p))
                    setDraft((p) => (p ? { ...p, model: updated.model, settings: updated.settings } : p))
                  }}
                />
              )}
            </div>
            <ContextPanel agent={draft} devices={devices} capabilities={capabilities} />
          </div>
        </TabPanel>

        <TabPanel active={tab === 'settings'}>
          <div className="h-full overflow-y-auto px-5 py-4">
            <SectionNav sections={sections} active={section} onChange={setSection} />
          </div>
        </TabPanel>
      </div>
    </div>
  )
}

function IdentitySection({ draft, setDraft, autoFocusName }: { draft: Agent; setDraft(a: Agent): void; autoFocusName?: boolean }) {
  const nameRef = useRef<HTMLInputElement>(null)

  // A duplicated agent lands here with its name selected (plan 73 §3.3, risk table §8) — "the copy
  // opens its detail page immediately with the name focused, so it is named before it is used."
  useEffect(() => {
    if (autoFocusName) nameRef.current?.select()
  }, [autoFocusName])

  return (
    <SectionCard title="Identity" description="Name, slug, description, and colour.">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-[13px] font-normal">Name</Label>
          <Input ref={nameRef} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[13px] font-normal">Slug</Label>
          <Input value={draft.slug} disabled />
          <p className="text-[11.5px] text-fg-subtle">The slug cannot change — it names this agent's workspace home, /agents/{draft.slug}/.</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[13px] font-normal">Description</Label>
          <Textarea value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value || null })} rows={3} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[13px] font-normal">Colour</Label>
          <Input value={draft.colour ?? ''} onChange={(e) => setDraft({ ...draft, colour: e.target.value || null })} placeholder="#7c6df2" />
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div>
            <p className="text-[13px] font-medium">Enabled</p>
            <p className="text-[11.5px] text-fg-muted">A disabled agent cannot be run.</p>
          </div>
          <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
        </div>
      </div>
    </SectionCard>
  )
}

function ModelSection({
  draft,
  setDraft,
  farmDefaults,
  connectors,
  models,
}: {
  draft: Agent
  setDraft(a: Agent): void
  farmDefaults: AgentDefaults
  connectors: Connector[]
  models: { models: ModelInfo[]; fallback: boolean } | null
}) {
  const connectorName = (id: string | null) => (id ? (connectors.find((c) => c.id === id)?.name ?? id) : null)
  return (
    <SectionCard title="Model" description="Connector, model, effort, thinking, and max output tokens.">
      <OverrideRow
        label="Connector"
        overridden={draft.connectorId !== null}
        farmValueLabel={connectorName(farmDefaults.connectorId) ?? 'none configured'}
        onEnable={() => setDraft({ ...draft, connectorId: farmDefaults.connectorId ?? connectors[0]?.id ?? '' })}
        onClear={() => setDraft({ ...draft, connectorId: null })}
      >
        <Select value={draft.connectorId ?? ''} onValueChange={(v) => setDraft({ ...draft, connectorId: v })}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose a connector" />
          </SelectTrigger>
          <SelectContent>
            {connectors.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} ({c.status})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {connectors.length === 0 && <p className="text-[11.5px] text-fg-subtle">No connectors configured yet — add one under Settings → Connectors.</p>}
      </OverrideRow>

      <OverrideRow
        label="Model"
        overridden={draft.model !== null}
        farmValueLabel={farmDefaults.model}
        onEnable={() => setDraft({ ...draft, model: farmDefaults.model })}
        onClear={() => setDraft({ ...draft, model: null })}
      >
        <div className="space-y-1.5">
          <Input value={draft.model ?? ''} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="claude-opus-5" list="agent-model-options" />
          <datalist id="agent-model-options">
            {(models?.models ?? []).map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
          <p className="text-[11.5px] text-fg-subtle">
            {models?.fallback ? 'Showing a pinned fallback list — the provider could not be reached.' : 'Fetched from the provider.'} A hand-typed id is accepted.
          </p>
        </div>
      </OverrideRow>

      <OverrideRow
        label="Effort"
        overridden={draft.settings.effort !== undefined}
        farmValueLabel={farmDefaults.effort}
        onEnable={() => setDraft({ ...draft, settings: { ...draft.settings, effort: farmDefaults.effort } })}
        onClear={() => {
          const { effort: _effort, ...rest } = draft.settings
          setDraft({ ...draft, settings: rest })
        }}
      >
        <Select value={draft.settings.effort ?? farmDefaults.effort} onValueChange={(v) => setDraft({ ...draft, settings: { ...draft.settings, effort: v as 'low' | 'medium' | 'high' } })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
      </OverrideRow>

      <OverrideRow
        label="Extended thinking"
        overridden={draft.settings.thinking !== undefined}
        farmValueLabel={farmDefaults.thinking ? 'on' : 'off'}
        onEnable={() => setDraft({ ...draft, settings: { ...draft.settings, thinking: farmDefaults.thinking } })}
        onClear={() => {
          const { thinking: _thinking, ...rest } = draft.settings
          setDraft({ ...draft, settings: rest })
        }}
      >
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <p className="text-[12.5px] text-fg-muted">Adaptive thinking</p>
          <Switch checked={draft.settings.thinking ?? farmDefaults.thinking} onCheckedChange={(v) => setDraft({ ...draft, settings: { ...draft.settings, thinking: v } })} />
        </div>
      </OverrideRow>

      <OverrideRow
        label="Max output tokens"
        overridden={draft.settings.maxOutputTokens !== undefined}
        farmValueLabel={farmDefaults.maxOutputTokens.toLocaleString()}
        onEnable={() => setDraft({ ...draft, settings: { ...draft.settings, maxOutputTokens: farmDefaults.maxOutputTokens } })}
        onClear={() => {
          const { maxOutputTokens: _m, ...rest } = draft.settings
          setDraft({ ...draft, settings: rest })
        }}
      >
        <Input
          type="number"
          min={1}
          value={draft.settings.maxOutputTokens ?? farmDefaults.maxOutputTokens}
          onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, maxOutputTokens: Number(e.target.value) } })}
        />
      </OverrideRow>
    </SectionCard>
  )
}

function InstructionsSection({ draft, setDraft, farmDefaults }: { draft: Agent; setDraft(a: Agent): void; farmDefaults: AgentDefaults }) {
  const text = draft.systemPrompt ?? ''
  const overridden = draft.systemPrompt !== null
  const effectiveText = overridden ? text : farmDefaults.systemPrompt
  const warning = looksVolatile(effectiveText)
  // A rough token estimate (~4 chars/token) — enough to catch "this is enormous", not a billing figure.
  const approxTokens = Math.ceil(effectiveText.length / 4)
  return (
    <SectionCard title="Instructions" description="The system prompt — part of the stable, cacheable prefix (plan 65 §3.4). Nothing time-varying belongs here.">
      <OverrideRow
        label="System prompt"
        overridden={overridden}
        farmValueLabel={farmDefaults.systemPrompt ? `"${farmDefaults.systemPrompt.slice(0, 60)}${farmDefaults.systemPrompt.length > 60 ? '…' : ''}"` : '(empty)'}
        onEnable={() => setDraft({ ...draft, systemPrompt: farmDefaults.systemPrompt })}
        onClear={() => setDraft({ ...draft, systemPrompt: null })}
      >
        <Textarea value={text} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} rows={12} className="font-mono text-[12.5px]" />
      </OverrideRow>
      <div className="flex items-center justify-between text-[11.5px] text-fg-muted">
        <span>~{approxTokens.toLocaleString()} tokens (rough estimate)</span>
      </div>
      {warning && (
        <p className="rounded-md border border-led-warning/40 bg-led-warning/5 px-3 py-2 text-[12px] text-led-warning">
          This prompt {warning} — the system prompt is part of the stable prefix Anthropic caches; volatile content belongs in the first user message instead (plan 65 §3.4).
        </p>
      )}
    </SectionCard>
  )
}

function ToolsSection({
  draft,
  setDraft,
  capabilities,
  error,
}: {
  draft: Agent
  setDraft(a: Agent): void
  capabilities: CapabilityInfo[]
  error: string | null
}) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, CapabilityInfo[]>()
    for (const cap of capabilities) {
      const g = capabilityGroup(cap.id)
      const list = byGroup.get(g) ?? []
      list.push(cap)
      byGroup.set(g, list)
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [capabilities])

  const toggle = (id: string) => {
    const has = draft.tools.includes(id)
    setDraft({ ...draft, tools: has ? draft.tools.filter((t) => t !== id) : [...draft.tools, id] })
  }

  return (
    <SectionCard title="Tools" description="The registry, grouped by prefix — checked capabilities are this agent's allowlist.">
      {error ? (
        <ErrorState message={`The capability list could not be understood — ${error}`} />
      ) : capabilities.length === 0 ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="space-y-4">
          {groups.map(([group, caps]) => (
            <div key={group} className="rounded-md border p-3">
              <p className="mb-2 text-[12.5px] font-medium capitalize">{group}</p>
              <div className="space-y-1.5">
                {caps.map((cap) => (
                  <label key={cap.id} className="flex items-start gap-2 text-[12.5px]">
                    <input type="checkbox" className="mt-0.5" checked={draft.tools.includes(cap.id)} onChange={() => toggle(cap.id)} />
                    <span className="flex-1">
                      <span className="readout font-medium">{cap.id}</span>{' '}
                      <Badge variant={cap.effect === 'destructive' ? 'destructive' : cap.effect === 'write' ? 'secondary' : 'outline'} className="align-middle text-[10px]">
                        {cap.effect}
                      </Badge>
                      <span className="block text-fg-muted">{cap.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function AccessSection({ draft, setDraft, devices }: { draft: Agent; setDraft(a: Agent): void; devices: DeviceInfo[] }) {
  const toggleDevice = (id: string) => {
    const has = draft.deviceGrants.includes(id)
    setDraft({ ...draft, deviceGrants: has ? draft.deviceGrants.filter((d) => d !== id) : [...draft.deviceGrants, id] })
  }
  const togglePermission = (p: string) => {
    const has = draft.permissions.includes(p)
    setDraft({ ...draft, permissions: has ? draft.permissions.filter((x) => x !== p) : [...draft.permissions, p] })
  }
  const editScope = (kind: 'read' | 'write', raw: string) => {
    const list = raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft({ ...draft, workspaceScope: { ...draft.workspaceScope, [kind]: list } })
  }

  return (
    <SectionCard title="Access" description="Which devices, tools' permissions, and workspace paths this agent may touch.">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label className="text-[13px] font-normal">Device grants</Label>
          {draft.deviceGrants.length === 0 && <Badge variant="outline">All devices (no restriction)</Badge>}
        </div>
        <p className="mb-2 text-[11.5px] text-fg-muted">
          An agent with no grants may reach every device — this is deliberate (plan 65 §3.5). Check specific devices to narrow it.
        </p>
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
          {devices.length === 0 ? (
            <p className="px-1 py-2 text-[12px] text-fg-subtle">No devices enrolled yet.</p>
          ) : (
            devices.map((d) => (
              <label key={d.id} className="flex items-center gap-2 rounded px-1 py-1 text-[12.5px] hover:bg-surface-2/50">
                <input type="checkbox" checked={draft.deviceGrants.includes(d.id)} onChange={() => toggleDevice(d.id)} />
                <span>{d.label}</span>
                <span className="readout text-fg-subtle">{d.stableId}</span>
              </label>
            ))
          )}
        </div>
      </div>

      <div>
        <Label className="mb-2 block text-[13px] font-normal">Workspace scope</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-[11.5px] text-fg-muted">Read prefixes</p>
            <Textarea rows={3} value={draft.workspaceScope.read.join('\n')} onChange={(e) => editScope('read', e.target.value)} className="font-mono text-[12px]" />
          </div>
          <div className="space-y-1">
            <p className="text-[11.5px] text-fg-muted">Write prefixes</p>
            <Textarea rows={3} value={draft.workspaceScope.write.join('\n')} onChange={(e) => editScope('write', e.target.value)} className="font-mono text-[12px]" />
          </div>
        </div>
        <p className="mt-1 text-[11.5px] text-fg-subtle">Defaults to write /agents/{draft.slug}/, read everywhere. One prefix per line, e.g. /shared/.</p>
      </div>

      <div>
        <Label className="mb-2 block text-[13px] font-normal">Permissions</Label>
        <p className="mb-2 text-[11.5px] text-fg-muted">A ceiling, not a default — never more than this agent's owner already holds, checked again every time it runs.</p>
        <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-3">
          {ALL_PERMISSIONS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 px-1 py-0.5 text-[12px]">
              <input type="checkbox" checked={draft.permissions.includes(p)} onChange={() => togglePermission(p)} />
              <span className="readout truncate">{p}</span>
            </label>
          ))}
        </div>
      </div>
    </SectionCard>
  )
}

function LimitsSection({ draft, setDraft, farmDefaults }: { draft: Agent; setDraft(a: Agent): void; farmDefaults: AgentDefaults }) {
  const numberRow = (key: 'maxSteps' | 'maxRunSeconds' | 'maxConcurrentRuns' | 'maxImagesPerRequest' | 'maxImageBytes', label: string, min = 0) => (
    <OverrideRow
      key={key}
      label={label}
      overridden={draft.settings[key] !== undefined}
      farmValueLabel={String(farmDefaults[key])}
      onEnable={() => setDraft({ ...draft, settings: { ...draft.settings, [key]: farmDefaults[key] } })}
      onClear={() => {
        const rest = { ...draft.settings }
        delete rest[key]
        setDraft({ ...draft, settings: rest })
      }}
    >
      <Input
        type="number"
        min={min}
        value={draft.settings[key] ?? farmDefaults[key]}
        onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, [key]: Number(e.target.value) } })}
      />
    </OverrideRow>
  )

  return (
    <SectionCard title="Limits" description="Every budget fails closed — reaching it stops the run with a named reason, never with more budget.">
      {numberRow('maxSteps', 'Max steps (model turns per run)', 0)}
      {numberRow('maxRunSeconds', 'Max run seconds (wall clock)', 1)}
      <OverrideRow
        label="Compact at ratio"
        overridden={draft.settings.compactAtRatio !== undefined}
        farmValueLabel={String(farmDefaults.compactAtRatio)}
        onEnable={() => setDraft({ ...draft, settings: { ...draft.settings, compactAtRatio: farmDefaults.compactAtRatio } })}
        onClear={() => {
          const { compactAtRatio: _c, ...rest } = draft.settings
          setDraft({ ...draft, settings: rest })
        }}
      >
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={draft.settings.compactAtRatio ?? farmDefaults.compactAtRatio}
          onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, compactAtRatio: Number(e.target.value) } })}
        />
        <p className="mt-1 text-[11.5px] text-fg-subtle">Fraction of the model's own context window, not a fixed token count.</p>
      </OverrideRow>
      {numberRow('maxConcurrentRuns', 'Max concurrent runs', 1)}
      {numberRow('maxImagesPerRequest', 'Max images per request (plan 70 §3.6 — oldest dropped first)', 0)}
      {numberRow('maxImageBytes', 'Max image bytes (per image, refused by name over this)', 1)}
    </SectionCard>
  )
}

function ConnectorsSection({ connectors }: { connectors: Connector[] }) {
  return (
    <SectionCard title="Connectors" description="Farm-level — shared across every agent. Edit credentials from Settings, not from here.">
      <p className="text-[12px] text-fg-muted">
        A credential is write-only: not readable by grepping the database, encrypted at rest with a key kept beside enkaku.db — the same honest claim the network
        layer already makes, nothing stronger.
      </p>
      <div className="space-y-2">
        {connectors.length === 0 ? (
          <p className="text-[12.5px] text-fg-subtle">No connectors configured yet.</p>
        ) : (
          connectors.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-[12.5px] font-medium">{c.name}</p>
                <p className="readout text-[11px] text-fg-muted">{c.kind} · {c.configured ? c.hint : 'no credential'}</p>
              </div>
              <Badge variant={c.status === 'ok' ? 'secondary' : c.status === 'unknown' ? 'outline' : 'destructive'}>{c.status}</Badge>
            </div>
          ))
        )}
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/settings?tab=connectors">Manage connectors in Settings</Link>
      </Button>
    </SectionCard>
  )
}

export default function AgentDetailPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <AgentDetail />
    </Suspense>
  )
}
