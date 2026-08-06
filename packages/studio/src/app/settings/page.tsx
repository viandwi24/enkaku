'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, UserPlus } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { z } from 'zod'
import {
  AdbStatsResponseSchema,
  AuditResponseSchema,
  ConnectorResponseSchema,
  ConnectorTestResultSchema,
  DevicesBlockedResponseSchema,
  ListConnectorsResponseSchema,
  SettingsResponseSchema,
  UpdateSettingsResponseSchema,
  UserSchema,
  UsersResponseSchema,
  WebhookEndpointSchema,
  WebhooksResponseSchema,
  type WebhookEndpoint,
} from '@enkaku/protocol'
import { api, useAction } from '@/lib/actions'
import type { Connector, ConnectorKind } from '@/lib/agents'
import { fetchScheduledSpendLast24h } from '@/lib/agent-usage'
import { formatTokens, relativeTime } from '@/lib/format'

interface User {
  id: string
  email: string
  role: 'admin' | 'operator'
}

interface AuditEntry {
  id: string
  userId: string | null
  action: string
  target: string | null
  at: number | null
}

// Small envelopes with no shared home in `@enkaku/protocol` — each is read
// (or, for the `Ok*` ones, deliberately ignored) by exactly one call site
// below, so they are declared locally rather than added there for one page.
const OkResponseSchema = z.object({ ok: z.boolean() })
const WebhookEndpointResponseSchema = z.object({ endpoint: WebhookEndpointSchema })
const UserCreateResponseSchema = z.object({ user: UserSchema })

/**
 * The farm Settings page's section list. Grouped (plan 73 §3.4, §4.5) —
 * `Connectors`, `Webhooks`, and `Spend` used to sit as three flat AI
 * concerns among `adb`, `Storage`, and `Blocked devices`; `SectionNav`'s new
 * optional `group` (plan 73 §3.4) puts them under one **AI Agents** heading
 * instead, alongside a **Defaults** sub-section that finally renders
 * `agentDefaults` — built by plan 65, editable nowhere until now (criterion
 * 13). Content is otherwise unchanged; only the container and this list's
 * shape moved.
 */
const FARM_SECTION_DEFS: readonly { id: string; title: string; group: string }[] = [
  { id: 'defaults', title: 'Defaults', group: 'Devices' },
  { id: 'battery', title: 'Battery', group: 'Devices' },
  { id: 'adb', title: 'adb', group: 'Devices' },
  { id: 'sessions', title: 'Sessions & Wall', group: 'Devices' },
  { id: 'job', title: 'Jobs', group: 'Jobs' },
  { id: 'storage', title: 'Storage', group: 'Jobs' },
  // AI Agents (plan 73 §3.4) — `agentDefaults` rendered through the same
  // schema-driven `FarmForm` every other section already uses, so a field
  // added to `AgentDefaultsSchema` appears here automatically (criterion 13).
  { id: 'ai-defaults', title: 'Defaults', group: 'AI Agents' },
  // Farm-level provider connectors (plan 65 §3.8) — appear inside the agent
  // editor only as a picker plus a link, because a credential edited from
  // inside one agent's page but affecting every other agent is a trap.
  { id: 'connectors', title: 'Connectors', group: 'AI Agents' },
  // Plan 68 §3.4, §4.5 — farm-level, admin-managed webhook endpoints an
  // agent's `notify.send` chooses among by NAME (never a raw URL).
  { id: 'webhooks', title: 'Webhooks', group: 'AI Agents' },
  // Plan 68 §3.3, §4.5 — the spend cap and scheduled-concurrency ceiling.
  // Both apply ONLY to scheduled agent runs; an interactive chat run is
  // never blocked by either, stated here in `scheduledAgents`'s own
  // `.meta()` description (rendered by the generic `FarmForm` below — no
  // bespoke UI needed, same as `job`/`sessions`/`battery`).
  { id: 'spend', title: 'Spend', group: 'AI Agents' },
  { id: 'blocked', title: 'Blocked devices', group: 'Farm' },
  { id: 'users', title: 'Users', group: 'Farm' },
  { id: 'audit', title: 'Audit log', group: 'Farm' },
]

/**
 * Farm settings, split by subject rather than stacked into one long scroll.
 *
 * Two of these sections had no interface at all: the user and audit APIs
 * existed and were enforced server-side, but could only be reached with curl.
 */
function SettingsView() {
  const router = useRouter()
  const tab = useSearchParams().get('tab') ?? 'defaults'

  const sections: SettingsSection[] = FARM_SECTION_DEFS.map(({ id, title, group }) => ({
    id,
    title,
    group,
    render: () =>
      id === 'blocked' ? (
        <BlockedDevicesSection />
      ) : id === 'connectors' ? (
        <ConnectorsSection />
      ) : id === 'webhooks' ? (
        <WebhooksSection />
      ) : id === 'users' ? (
        <UsersSection />
      ) : id === 'audit' ? (
        <AuditSection />
      ) : id === 'adb' ? (
        <>
          <FarmForm section={id} />
          <AdbDiagnosticsPanel />
        </>
      ) : id === 'spend' ? (
        <>
          <FarmForm section={id} />
          <ObservedSpendPanel />
        </>
      ) : (
        <FarmForm section={id} />
      ),
  }))

  return (
    <>
      <PageHeader title="Farm settings" description="Applies to every device and job in this farm" />
      <div className="px-5 py-4">
        <SectionNav
          sections={sections}
          active={tab}
          onChange={(id) => router.push(id === 'defaults' ? '/settings' : `/settings?tab=${id}`)}
        />
      </div>
    </>
  )
}

/** Which top-level FarmSettings keys a tab renders — most tabs are one section; `adb` groups two (plan 23 §4.1). */
function keysForSection(section: string): string[] {
  if (section === 'battery') return ['battery']
  if (section === 'storage') return ['retention']
  if (section === 'adb') return ['adb', 'health']
  // Session hygiene between jobs (plan 35 §4.1) — its own tab, no UI code
  // beyond this mapping: the fields render from `.describe()`/`.meta()`.
  if (section === 'job') return ['job']
  // Idle session TTL and the fleet Wall's tile cap (plan 42 §4.4, §4.6) —
  // same pattern: no bespoke UI, the fields render from `.describe()`/`.meta()`.
  if (section === 'sessions') return ['session', 'wall']
  // Plan 73 §3.4, §4.5 — the farm defaults plan 65 built and never exposed a screen for. Rendered
  // through the SAME schema-driven `FarmForm` every other section already uses, so a field added
  // to `AgentDefaultsSchema` appears here with no UI change at all (criterion 13).
  if (section === 'ai-defaults') return ['agentDefaults']
  // Plan 68 §3.3 — the scheduled-agent spend cap and concurrency ceiling.
  if (section === 'spend') return ['scheduledAgents']
  return ['defaults']
}

/** One schema, rendered a section at a time by trimming its properties. */
function FarmForm({ section }: { section: string }) {
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  const [saved, setSaved] = useState<Record<string, unknown> | undefined>(undefined)
  const [draft, setDraft] = useState<Record<string, unknown> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const keys = keysForSection(section)

  const load = () => {
    setError(null)
    api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setSchema(b.schema)
        setSaved(b.settings)
        setDraft(b.settings)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  if (error) return <div className="py-4"><ErrorState message={error} onRetry={load} /></div>
  if (!schema || !draft) return <div className="py-4"><LoadingRows rows={4} /></div>

  // Narrow the schema to this section's keys, so the form renders one
  // subject at a time while the value stays the whole settings object the
  // API expects.
  const sectionSchema: JsonSchemaNode = {
    ...schema,
    properties: Object.fromEntries(keys.map((k) => [k, schema.properties?.[k] as JsonSchemaNode])),
  }

  return (
    <div className="max-w-3xl py-4">
      <SchemaForm
        schema={sectionSchema}
        value={draft}
        onChange={(v) => setDraft(v as Record<string, unknown>)}
        onSubmit={() =>
          run('save', () => api('/api/settings', UpdateSettingsResponseSchema, { method: 'PATCH', json: draft }), {
            success: 'Settings saved',
            failure: 'Could not save the settings',
            onSuccess: (b) => {
              setSaved(b.settings)
              setDraft(b.settings)
            },
          })
        }
        onReset={() => setDraft(saved)}
        busy={isPending('save')}
        dirty={dirty}
      />
    </div>
  )
}

interface AdbStats {
  global: { maxConcurrent: number; auto: boolean; inFlight: number; waiting: number }
  devices: Array<{
    deviceId: string
    label: string
    queueDepth: number
    execMsP50: number | null
    execMsP95: number | null
    counts: { ok: number; timeout: number; busy: number; error: number }
    consecutiveFailures: number
  }>
}

/**
 * The observed number beside Plan 68's cap (plan 69 §3.4) — "so a cap can be
 * set against an observed number rather than a guess." Composed client-side
 * (see `lib/agent-usage.ts`'s `fetchScheduledSpendLast24h` for the backend
 * gap this works around: no endpoint reports an actual spend figure, only
 * the cap itself). Counts the SAME thing the cap counts — output tokens from
 * `origin: 'schedule'` threads in the last 24 hours — so the two numbers are
 * directly comparable.
 */
function ObservedSpendPanel() {
  const [outputTokens, setOutputTokens] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchScheduledSpendLast24h()
      .then((r) => {
        setOutputTokens(r.outputTokens)
        setTruncated(r.truncated)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="max-w-3xl pb-6">
      <h3 className="rack-label mb-2">observed — scheduled runs, last 24h</h3>
      {error ? (
        <p className="text-[12px] text-fg-subtle">Could not compute the observed figure ({error}).</p>
      ) : outputTokens === null ? (
        <LoadingRows rows={1} />
      ) : (
        <div className="rounded-lg border bg-surface p-3">
          <p className="readout text-[16px] font-semibold">{formatTokens(outputTokens)} output tokens</p>
          <p className="mt-0.5 text-[11.5px] text-fg-muted">The same metric the cap above limits — counted only over scheduled-origin runs, never an interactive chat.</p>
          {truncated && <p className="mt-1 text-[10.5px] text-fg-subtle">Computed from each agent's most recently active scheduled threads — not its full history.</p>}
        </div>
      )}
    </div>
  )
}

/**
 * Read-only adb diagnostics (plan 23 §4.6, §5.7) — collapsed by default since
 * this is a debug aid, not something most visits to Settings need. Polled
 * only while expanded, so it costs nothing when nobody is looking at it.
 */
function AdbDiagnosticsPanel() {
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<AdbStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = () => {
      api('/api/adb/stats', AdbStatsResponseSchema)
        .then((b) => {
          if (!cancelled) {
            setStats(b)
            setError(null)
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }
    load()
    const id = setInterval(load, 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [open])

  return (
    <div className="max-w-3xl pb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12.5px] font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline"
      >
        {open ? 'Hide' : 'Show'} adb diagnostics
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          {error ? (
            <ErrorState message={error} onRetry={() => setError(null)} />
          ) : !stats ? (
            <LoadingRows rows={3} />
          ) : (
            <>
              <div className="flex flex-wrap gap-4 rounded-lg border p-3 text-[12.5px]">
                <span>
                  Max concurrent: <span className="readout font-medium">{stats.global.maxConcurrent}</span>{' '}
                  {stats.global.auto ? '(auto)' : '(pinned)'}
                </span>
                <span>
                  In flight: <span className="readout font-medium">{stats.global.inFlight}</span>
                </span>
                <span>
                  Waiting: <span className="readout font-medium">{stats.global.waiting}</span>
                </span>
              </div>
              {stats.devices.length === 0 ? (
                <EmptyState title="No devices yet" description="Per-device figures appear once a device is enrolled." />
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Device</TableHead>
                        <TableHead className="text-right">Queue depth</TableHead>
                        <TableHead className="text-right">p50 (ms)</TableHead>
                        <TableHead className="text-right">p95 (ms)</TableHead>
                        <TableHead className="text-right">ok / timeout / busy / error</TableHead>
                        <TableHead className="text-right">Consecutive failures</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats.devices.map((d) => (
                        <TableRow key={d.deviceId}>
                          <TableCell className="font-medium">{d.label}</TableCell>
                          <TableCell className="readout text-right">{d.queueDepth}</TableCell>
                          <TableCell className="readout text-right">{d.execMsP50 ?? '—'}</TableCell>
                          <TableCell className="readout text-right">{d.execMsP95 ?? '—'}</TableCell>
                          <TableCell className="readout text-right text-fg-muted">
                            {d.counts.ok} / {d.counts.timeout} / {d.counts.busy} / {d.counts.error}
                          </TableCell>
                          <TableCell className="readout text-right">{d.consecutiveFailures}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Provider connectors — farm-level, shared across agents (plan 65 §3.6,
 * §4.5). Credentials are write-only through this whole screen: nothing here
 * ever reads a `credential` field, only `configured`/`hint`, and the same
 * sentence the network layer already uses is repeated verbatim (§3.6 — "a
 * second, differently-worded security claim about the same mechanism would
 * be a claim someone eventually believes").
 */
function ConnectorsSection() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ConnectorKind>('anthropic')
  const [credential, setCredential] = useState('')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/connectors', ListConnectorsResponseSchema)
      .then((b) => setConnectors(b.connectors))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/connectors', ConnectorResponseSchema, { method: 'POST', json: { name, kind, credential: credential || undefined } }), {
      success: `${name} added`,
      failure: 'Could not add the connector',
      onSuccess: () => {
        setOpen(false)
        setName('')
        setCredential('')
        load()
      },
    })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
          A configured provider endpoint plus credential — an agent names one to run against. A credential here is not readable by
          grepping the database; it is encrypted with a key kept in a file beside enkaku.db. Anyone with read access to the whole
          data directory can still decrypt it — this is not a key management service, and does not claim to be one.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setName('')
            setKind('anthropic')
            setCredential('')
            setOpen(true)
          }}
        >
          <Plus className="size-3.5" aria-hidden />
          Add connector
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : connectors === null ? (
        <LoadingRows rows={3} />
      ) : connectors.length === 0 ? (
        <EmptyState title="No connectors yet" description="Add one to give agents a model and provider to use." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Credential</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectors.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-[12.5px] text-fg-muted">{c.kind}</TableCell>
                  <TableCell className="readout text-[12px] text-fg-muted">{c.configured ? c.hint : 'not configured'}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'ok' ? 'secondary' : c.status === 'unknown' ? 'outline' : 'destructive'}>{c.status}</Badge>
                    {c.statusMessage && <p className="mt-0.5 max-w-xs truncate text-[11px] text-fg-subtle">{c.statusMessage}</p>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[12px]"
                        disabled={isPending('test-' + c.id)}
                        onClick={() =>
                          run('test-' + c.id, () => api(`/api/connectors/${c.id}/test`, ConnectorTestResultSchema, { method: 'POST' }), {
                            success: 'Tested',
                            failure: 'Test failed',
                            onSuccess: load,
                          })
                        }
                      >
                        {isPending('test-' + c.id) ? 'Testing…' : 'Test connection'}
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm" className="h-7 text-[12px]">
                            Remove
                          </Button>
                        }
                        title={`Remove ${c.name}?`}
                        description="Agents naming this connector fall back to the farm default until another is chosen."
                        onConfirm={() =>
                          run('del-' + c.id, () => api(`/api/connectors/${c.id}`, z.void(), { method: 'DELETE' }), {
                            success: `${c.name} removed`,
                            failure: 'Could not remove the connector',
                            onSuccess: load,
                          })
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add connector</DialogTitle>
            <DialogDescription>The credential is write-only — it is never shown again after this.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-name" className="text-[13px] font-normal">
                Name
              </Label>
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="anthropic-main" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-kind" className="text-[13px] font-normal">
                Kind
              </Label>
              <Select value={kind} onValueChange={(v) => setKind(v as ConnectorKind)}>
                <SelectTrigger id="conn-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-credential" className="text-[13px] font-normal">
                API key
              </Label>
              <Input id="conn-credential" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={kind === 'openrouter' ? 'sk-or-…' : 'sk-ant-…'} />
              <p className="text-[11.5px] text-fg-subtle">
                Leave blank to configure {kind === 'openrouter' ? 'ENKAKU_OPENROUTER_API_KEY' : 'ENKAKU_ANTHROPIC_API_KEY'} as an env var fallback instead.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!name || isPending('create')} onClick={() => void create()}>
                {isPending('create') ? 'Adding…' : 'Add connector'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Farm-level webhook endpoints (plan 68 §3.4, §4.1, §4.5) — `notify.send`
 * chooses among these by NAME, never a raw URL, which is what keeps a
 * webhook from leaking farm information to an arbitrary address (§8's risk
 * table). The secret is write-only, same rule `ConnectorsSection` already
 * follows for a credential. `lastStatus`/`failureCount` make a dead endpoint
 * visible here rather than only in a log (criterion 11).
 */
function WebhooksSection() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/webhooks', WebhooksResponseSchema)
      .then((b) => setEndpoints(b.endpoints))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/webhooks', WebhookEndpointResponseSchema, { method: 'POST', json: { name, url, secret: secret || undefined } }), {
      success: `${name} added`,
      failure: 'Could not add the webhook endpoint',
      onSuccess: () => {
        setOpen(false)
        setName('')
        setUrl('')
        setSecret('')
        load()
      },
    })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
          A POST to this URL, signed with HMAC-SHA256 over the body plus a timestamp (the{' '}
          <span className="readout">X-Enkaku-Signature</span> header), so a receiver can verify who sent it. An agent's{' '}
          <span className="readout">notify.send</span> names one of these by name — it never sees or chooses a raw URL.
          Delivered three times with backoff before it is recorded as failed; the in-app notification is written first,
          regardless.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setName('')
            setUrl('')
            setSecret('')
            setOpen(true)
          }}
        >
          <Plus className="size-3.5" aria-hidden />
          Add webhook
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : endpoints === null ? (
        <LoadingRows rows={3} />
      ) : endpoints.length === 0 ? (
        <EmptyState title="No webhooks yet" description="Add one so a scheduled agent's notify.send can reach Slack, Discord, PagerDuty, or anything else." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium">
                    {w.name}
                    {!w.enabled && <Badge variant="outline" className="ml-1.5">disabled</Badge>}
                  </TableCell>
                  <TableCell className="readout max-w-xs truncate text-[12px] text-fg-muted">{w.url}</TableCell>
                  <TableCell>
                    {w.lastStatus === null ? (
                      <span className="text-[12px] text-fg-subtle">never delivered</span>
                    ) : w.failureCount > 0 ? (
                      <Badge variant="destructive">unhealthy · {w.failureCount} failure{w.failureCount === 1 ? '' : 's'}</Badge>
                    ) : (
                      <Badge variant="secondary">ok</Badge>
                    )}
                    {w.lastAttemptAt && (
                      <p className="readout mt-0.5 text-[11px] text-fg-subtle">last attempt {relativeTime(w.lastAttemptAt)}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[12px]"
                        disabled={isPending('toggle-' + w.id)}
                        onClick={() =>
                          run('toggle-' + w.id, () => api(`/api/webhooks/${w.id}`, WebhookEndpointResponseSchema, { method: 'PATCH', json: { enabled: !w.enabled } }), {
                            success: w.enabled ? `${w.name} disabled` : `${w.name} enabled`,
                            failure: 'Could not update the webhook endpoint',
                            onSuccess: load,
                          })
                        }
                      >
                        {w.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm" className="h-7 text-[12px]">
                            Remove
                          </Button>
                        }
                        title={`Remove ${w.name}?`}
                        description="An agent naming this endpoint will fail to deliver to it — the in-app notification is unaffected."
                        onConfirm={() =>
                          run('del-' + w.id, () => api(`/api/webhooks/${w.id}`, z.void(), { method: 'DELETE' }), {
                            success: `${w.name} removed`,
                            failure: 'Could not remove the webhook endpoint',
                            onSuccess: load,
                          })
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add webhook</DialogTitle>
            <DialogDescription>The secret is write-only — it is never shown again after this.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="wh-name" className="text-[13px] font-normal">
                Name
              </Label>
              <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="on-call-slack" />
              <p className="text-[11.5px] text-fg-subtle">What an agent's notify.send names in its channels list.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-url" className="text-[13px] font-normal">
                URL
              </Label>
              <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-secret" className="text-[13px] font-normal">
                Signing secret
              </Label>
              <Input id="wh-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="optional, but recommended" />
              <p className="text-[11.5px] text-fg-subtle">Used to sign every delivery — leave blank to send unsigned.</p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!name || !url || isPending('create')} onClick={() => void create()}>
                {isPending('create') ? 'Adding…' : 'Add webhook'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface BlockedDevice {
  stableId: string
  label: string | null
  reason: string | null
  blockedAt: number
  blockedBy: string | null
}

/**
 * Blocked devices (plan 47 §3.3, §4.5): listed here with when, by whom, and
 * why — a block you cannot find again is indistinguishable from a bug. Keyed
 * on `stableId`, never a device row (there may be none — a blocked device is
 * removed from the fleet, exactly like a Forget), which is also why this
 * list is the only place an Unblock can happen.
 */
function BlockedDevicesSection() {
  const [blocked, setBlocked] = useState<BlockedDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/devices/blocked', DevicesBlockedResponseSchema)
      .then((b) => setBlocked(b.blocked))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  return (
    <div>
      <p className="mb-3 max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
        A blocked device is skipped the instant it is seen again — a different USB port or a switch to wireless does
        not bring it back (plan 47 §3.3). Unblocking lets it return on its next connection, as a fresh device.
      </p>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : blocked === null ? (
        <LoadingRows rows={3} />
      ) : blocked.length === 0 ? (
        <EmptyState
          title="Nothing blocked"
          description="Block a connected device from its own page when Forget refuses it — that action lands here."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Device</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Blocked</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {blocked.map((b) => (
                <TableRow key={b.stableId}>
                  <TableCell className="font-medium">
                    {b.label ?? b.stableId}
                    <p className="readout mt-0.5 text-[11px] text-fg-subtle">{b.stableId}</p>
                  </TableCell>
                  <TableCell className="text-[12.5px] text-fg-muted">{b.reason ?? '—'}</TableCell>
                  <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(b.blockedAt)}</TableCell>
                  <TableCell className="readout text-[11.5px] text-fg-muted">
                    {b.blockedBy ? b.blockedBy.slice(0, 8) : 'system'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[12px]"
                      disabled={isPending('unblock-' + b.stableId)}
                      onClick={() =>
                        run('unblock-' + b.stableId, () => api(`/api/devices/blocked/${encodeURIComponent(b.stableId)}`, OkResponseSchema, { method: 'DELETE' }), {
                          success: `${b.label ?? b.stableId} unblocked`,
                          failure: 'Could not unblock the device',
                          onSuccess: load,
                        })
                      }
                    >
                      Unblock
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function UsersSection() {
  const [users, setUsers] = useState<User[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'operator'>('operator')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/auth/users', UsersResponseSchema)
      .then((b) => setUsers(b.users))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/auth/users', UserCreateResponseSchema, { method: 'POST', json: { email, password, role } }), {
      success: `${email} added`,
      failure: 'Could not add the user',
      onSuccess: () => {
        setOpen(false)
        setEmail('')
        setPassword('')
        setRole('operator')
        load()
      },
    })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
          Admins manage users, devices, and tools. Operators run scripts and control devices. Roles are enforced by the
          core, not by hiding buttons.
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>
          <UserPlus className="size-4" aria-hidden />
          Add user
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : users === null ? (
        <LoadingRows rows={3} />
      ) : users.length === 0 ? (
        <EmptyState
          title="No users yet"
          description="In local mode there is one implicit admin and no login. Users matter once the core binds to a network address."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[55%]">Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell className="text-[12.5px] text-fg-muted">{u.role}</TableCell>
                  <TableCell className="text-right">
                    <ConfirmDialog
                      trigger={<Button variant="ghost" size="sm" className="h-7 text-[12px]">Remove</Button>}
                      title={`Remove ${u.email}?`}
                      description="Their sessions end immediately. The last admin cannot be removed."
                      onConfirm={() =>
                        run('del-' + u.id, () => api(`/api/auth/users/${u.id}`, OkResponseSchema, { method: 'DELETE' }), {
                          success: `${u.email} removed`,
                          failure: 'Could not remove the user',
                          onSuccess: load,
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>They can sign in as soon as this is saved.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[13px] font-normal">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw" className="text-[13px] font-normal">Password</Label>
              <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="text-[11.5px] text-fg-subtle">At least 8 characters.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role" className="text-[13px] font-normal">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'operator')}>
                <SelectTrigger id="role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                disabled={!email || password.length < 8 || isPending('create')}
                onClick={() => void create()}
              >
                {isPending('create') ? 'Adding…' : 'Add user'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AuditSection() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setError(null)
    api('/api/auth/audit?limit=200', AuditResponseSchema)
      .then((b) => setEntries(b.entries))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  return (
    <div>
      <p className="mb-3 max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
        Who did what: jobs started, devices enrolled, tools activated, users changed. Written by the core, and not
        editable from here.
      </p>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : entries === null ? (
        <LoadingRows rows={5} />
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet" description="Actions that change the farm show up here as they happen." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[28%]">Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>By</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="readout text-[12px]">{e.action}</TableCell>
                  <TableCell className="min-w-0 truncate text-[12.5px] text-fg-muted">{e.target ?? '—'}</TableCell>
                  <TableCell className="readout text-[11.5px] text-fg-muted">
                    {e.userId ? e.userId.slice(0, 8) : 'system'}
                  </TableCell>
                  <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(e.at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <SettingsView />
    </Suspense>
  )
}
