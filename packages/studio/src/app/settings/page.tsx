'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { UserPlus } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, useAction } from '@/lib/actions'
import { relativeTime } from '@/lib/format'

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

/** The farm Settings page's section list — content unchanged, only the container swaps from a horizontal `EntityTabs` strip to the shared vertical `SectionNav` (plan 46 §4.3). */
const FARM_SECTION_DEFS: readonly { id: string; title: string }[] = [
  { id: 'defaults', title: 'Device defaults' },
  { id: 'battery', title: 'Battery' },
  { id: 'adb', title: 'adb' },
  { id: 'job', title: 'Jobs' },
  { id: 'sessions', title: 'Sessions & Wall' },
  { id: 'storage', title: 'Storage' },
  { id: 'blocked', title: 'Blocked devices' },
  { id: 'users', title: 'Users' },
  { id: 'audit', title: 'Audit log' },
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

  const sections: SettingsSection[] = FARM_SECTION_DEFS.map(({ id, title }) => ({
    id,
    title,
    render: () =>
      id === 'blocked' ? (
        <BlockedDevicesSection />
      ) : id === 'users' ? (
        <UsersSection />
      ) : id === 'audit' ? (
        <AuditSection />
      ) : id === 'adb' ? (
        <>
          <FarmForm section={id} />
          <AdbDiagnosticsPanel />
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
    api<{ settings: Record<string, unknown>; schema: JsonSchemaNode }>('/api/settings')
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
          run('save', () => api<{ settings: Record<string, unknown> }>('/api/settings', { method: 'PATCH', json: draft }), {
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
      api<AdbStats>('/api/adb/stats')
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
    api<{ blocked: BlockedDevice[] }>('/api/devices/blocked')
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
                        run('unblock-' + b.stableId, () => api(`/api/devices/blocked/${encodeURIComponent(b.stableId)}`, { method: 'DELETE' }), {
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
    api<{ users: User[] }>('/api/auth/users')
      .then((b) => setUsers(b.users))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/auth/users', { method: 'POST', json: { email, password, role } }), {
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
                        run('del-' + u.id, () => api(`/api/auth/users/${u.id}`, { method: 'DELETE' }), {
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
    api<{ entries: AuditEntry[] }>('/api/auth/audit?limit=200')
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
