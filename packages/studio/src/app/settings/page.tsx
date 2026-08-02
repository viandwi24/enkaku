'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { UserPlus } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EntityTabs } from '@/components/layout/EntityTabs'
import { PageHeader } from '@/components/layout/PageHeader'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
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

/**
 * Farm settings, split by subject rather than stacked into one long scroll.
 *
 * Two of these sections had no interface at all: the user and audit APIs
 * existed and were enforced server-side, but could only be reached with curl.
 */
function SettingsView() {
  const tab = useSearchParams().get('tab') ?? 'defaults'
  return (
    <>
      <PageHeader title="Farm settings" description="Applies to every device and job in this farm" />
      <EntityTabs
        active={tab}
        tabs={[
          { key: 'defaults', label: 'Device defaults' },
          { key: 'battery', label: 'Battery' },
          { key: 'storage', label: 'Storage' },
          { key: 'users', label: 'Users' },
          { key: 'audit', label: 'Audit log' },
        ]}
        hrefFor={(k) => `/settings${k === 'defaults' ? '' : `?tab=${k}`}`}
      />
      {tab === 'users' ? <UsersSection /> : tab === 'audit' ? <AuditSection /> : <FarmForm section={tab} />}
    </>
  )
}

/** One schema, rendered a section at a time by trimming its properties. */
function FarmForm({ section }: { section: string }) {
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  const [saved, setSaved] = useState<Record<string, unknown> | undefined>(undefined)
  const [draft, setDraft] = useState<Record<string, unknown> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const { run, isPending } = useAction()

  const key = section === 'battery' ? 'battery' : section === 'storage' ? 'retention' : 'defaults'

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

  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (!schema || !draft) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  // Narrow the schema to this section, so the form renders one subject at a
  // time while the value stays the whole settings object the API expects.
  const sectionSchema: JsonSchemaNode = {
    ...schema,
    properties: { [key]: schema.properties?.[key] as JsonSchemaNode },
  }

  return (
    <div className="max-w-3xl px-5 py-4">
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
    <div className="px-5 py-4">
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
    <div className="px-5 py-4">
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
