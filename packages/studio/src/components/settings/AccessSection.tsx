'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AuditResponseSchema, UserSchema, UsersResponseSchema } from '@enkaku/protocol'
import {
  Button,
  CaretDownIcon,
  CaretRightIcon,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  relativeTime,
  useAction,
} from '@enkaku/ui'

/**
 * plan 219 §4.7 — extracted verbatim from the Settings page's old `id ===
 * 'users'`/`id === 'audit'` branches (the exact tables, dialogs and
 * `useAction` calls against `/api/users`/`/api/auth/audit`, moved not
 * rewritten), re-skinned onto the handoff's tokens the same way
 * `PluginRowView` was: `rounded-lg border` → `rounded-card border
 * border-line-2`, `text-fg-muted` → `text-faint`, `bg-surface` → `bg-panel-2`.
 * Access is the one bespoke row MVP 12 §1 keeps — "Users and API tokens |
 * not a field, a table; lives here" — spliced into the derived nav by id,
 * exactly as `farmSections()` already splices in `access` itself.
 */

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
  meta: unknown
}

const OkResponseSchema = z.object({ ok: z.boolean() })
const UserCreateResponseSchema = z.object({ user: UserSchema })

export function AccessSection() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="border-b border-line pb-3 text-section font-semibold text-text">Access</h2>
        <p className="pt-3.5 text-meta text-dim">Who can sign in, and what they changed.</p>
      </div>
      <UsersSection />
      <AuditSection />
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
        <p className="max-w-xl text-body leading-relaxed text-faint">
          Admins manage users, devices, and tools. Operators run scripts and control devices. Roles are enforced by the
          core, not by hiding buttons.
        </p>
        {/* No icon: `UserPlusIcon` is not in plan 204's barrel and this is a
            bespoke, undesigned section (plan 219 §4.8's same discipline). */}
        <Button size="sm" onClick={() => setOpen(true)}>Add user</Button>
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
        <div className="overflow-hidden rounded-card border border-line-2">
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
                  <TableCell className="font-medium text-text">{u.email}</TableCell>
                  <TableCell className="text-body text-faint">{u.role}</TableCell>
                  <TableCell className="text-right">
                    <ConfirmDialog
                      trigger={<Button variant="ghost" size="sm" className="h-7">Remove</Button>}
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
              <Label htmlFor="email" className="text-body font-normal">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw" className="text-body font-normal">Password</Label>
              <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="text-meta text-faint">At least 8 characters.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role" className="text-body font-normal">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'operator')}>
                <SelectTrigger id="role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 border-t border-line pt-3">
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

/** One audit row, with the expandable `meta` disclosure the device log's own event row already established (plan 91 §3.5, F24). */
function AuditRow({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false)
  const hasMeta = e.meta !== null && e.meta !== undefined && (typeof e.meta !== 'object' || Object.keys(e.meta).length > 0)
  return (
    <>
      <TableRow>
        <TableCell className="font-mono text-meta text-text-2">{e.action}</TableCell>
        <TableCell className="min-w-0 truncate text-body text-faint">{e.target ?? '—'}</TableCell>
        <TableCell className="font-mono text-meta text-faint">
          {e.userId ? e.userId.slice(0, 8) : 'system'}
        </TableCell>
        <TableCell className="font-mono text-meta text-faint">{relativeTime(e.at)}</TableCell>
        <TableCell className="w-8">
          {hasMeta && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-faint hover:text-text"
              aria-label={open ? 'Hide details' : 'Show details'}
            >
              {open ? <CaretDownIcon className="size-3.5" aria-hidden /> : <CaretRightIcon className="size-3.5" aria-hidden />}
            </button>
          )}
        </TableCell>
      </TableRow>
      {open && hasMeta && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-panel-2 py-2">
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-meta leading-relaxed text-faint">
              {JSON.stringify(e.meta, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
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
      <p className="mb-3 max-w-xl text-body leading-relaxed text-faint">
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
        <div className="overflow-hidden rounded-card border border-line-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[28%]">Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>By</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <AuditRow key={e.id} e={e} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
