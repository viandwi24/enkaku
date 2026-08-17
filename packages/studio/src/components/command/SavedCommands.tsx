'use client'

import { useEffect, useState } from 'react'
import {
  SavedCommandDeleteResponseSchema,
  SavedCommandListResponseSchema,
  SavedCommandResponseSchema,
  type CommandTarget,
  type SavedCommand,
} from '@enkaku/protocol'
import { api, useAction, ConfirmDialog, Button, Input, Textarea, EmptyState } from '@enkaku/ui'
import { isAdmin, useAuth } from '@/lib/auth'

/**
 * Plan 93 §3.10, step 93.7 — "saved commands are a farm asset, not a
 * personal bookmark: named, described, visible to the team, owned by
 * whoever made them." No `dangerous` flag is stored or shown here (§3.10):
 * whether a command is high-consequence is derived fresh from its text at
 * render/run time by the console page itself, never cached on this row.
 *
 * "Use" fills the console's command box and default target rather than
 * running immediately — §3.14's target preview and confirmation guards
 * apply to EVERY run, including one started from a saved command, so this
 * button hands control back to the same guarded path instead of routing
 * around it.
 *
 * `GET /api/saved-commands` is best-effort here for the same reason
 * `TerminalPane`'s history fetch is (plan 93 §5 step 93.6's own status note:
 * the route exists and is tested directly, but is not yet mounted onto a
 * real boot — a 404 must not break this panel, only leave it empty).
 */
export function SavedCommands({
  currentCmd,
  currentTarget,
  onUse,
}: {
  /** The console's current command text — seeds the "save this" form when opened. */
  currentCmd: string
  /** The console's current target — offered as the saved command's default target. */
  currentTarget: CommandTarget | null
  onUse: (cmd: string, defaultTarget: CommandTarget | null) => void
}) {
  const { user } = useAuth()
  const { run, isPending } = useAction()
  const [items, setItems] = useState<SavedCommand[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [cmd, setCmd] = useState('')

  const load = () => {
    api('/api/saved-commands', SavedCommandListResponseSchema)
      .then((page) => setItems(page.items))
      .catch(() => {
        // See the file doc comment — never an error banner.
      })
      .finally(() => setLoaded(true))
  }

  useEffect(load, [])

  const create = () =>
    run(
      'create',
      () =>
        api('/api/saved-commands', SavedCommandResponseSchema, {
          json: { name, description: description.trim() ? description : null, cmd, defaultTarget: currentTarget },
        }),
      {
        success: 'Saved',
        failure: 'Could not save',
        onSuccess: () => {
          setName('')
          setDescription('')
          setCmd('')
          setCreating(false)
          load()
        },
      },
    )

  const remove = (sc: SavedCommand) =>
    run('delete', () => api(`/api/saved-commands/${sc.id}`, SavedCommandDeleteResponseSchema, { method: 'DELETE' }), {
      success: 'Deleted',
      failure: 'Could not delete',
      onSuccess: load,
    })

  // Local-mode's implicit admin has `user === null` before `AuthGate`
  // resolves and `role: 'admin'` once it does (`lib/auth.ts`'s own doc
  // comment) — `isAdmin(user)` alone already covers that case; the extra
  // `user !== null` guard below only protects the ownership comparison,
  // which is meaningless without a real user id.
  const canEdit = (sc: SavedCommand) => isAdmin(user) || (user !== null && sc.createdBy === user.id)

  if (!loaded) return null

  return (
    <div className="space-y-2.5">
      {items.length === 0 && !creating && <EmptyState title="No saved commands yet" description="Save a command once and the whole team can reuse it." />}

      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((sc) => (
            <li key={sc.id} className="rounded-md border bg-surface p-2 text-[12px]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{sc.name}</p>
                  {sc.description && <p className="text-[11px] text-fg-muted">{sc.description}</p>}
                  <code className="readout mt-0.5 block truncate text-[11px] text-fg-muted">{sc.cmd}</code>
                </div>
                <Button size="sm" variant="outline" className="h-6 shrink-0 px-1.5 text-[11px]" onClick={() => onUse(sc.cmd, sc.defaultTarget)}>
                  Use
                </Button>
              </div>
              {canEdit(sc) && (
                <div className="mt-1">
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={isPending('delete')}>
                        Delete
                      </Button>
                    }
                    title={`Delete "${sc.name}"?`}
                    description="This saved command is removed for everyone on the farm."
                    onConfirm={() => remove(sc)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <div className="space-y-1.5 rounded-md border bg-surface p-2.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. battery level" className="h-7 text-[12px]" />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="min-h-14 text-[12px]"
          />
          <Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="dumpsys battery | grep level" className="readout h-7 text-[12px]" />
          <div className="flex gap-2">
            <Button size="sm" disabled={!name.trim() || !cmd.trim() || isPending('create')} onClick={create}>
              {isPending('create') ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setCmd(currentCmd)
            setCreating(true)
          }}
        >
          Save current command
        </Button>
      )}
    </div>
  )
}
