'use client'

import { toast } from 'sonner'
import {
  PluginActivateResponseSchema,
  PluginOkResponseSchema,
  PluginRowResponseSchema,
  PluginVerifyResponseSchema,
} from '@enkaku/protocol'
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DotsThreeIcon,
  api,
  useAction,
} from '@enkaku/ui'
import type { PluginListRow } from '@/app/plugins/plugin-list'
import { ResetPluginAction } from './ResetPluginAction'
import { RemovePluginAction } from './RemovePluginAction'

/**
 * Every lifecycle control a published plugin version has, in one component,
 * because there are now TWO surfaces that must offer exactly the same set —
 * the row on `/plugins` and the header of `/plugins/detail?name=…`. A second
 * copy is how one of them would quietly keep offering Disable after the other
 * learned about Enable, which is the drift that produced plan 108 §0.2's P2
 * in the first place.
 *
 * plan 219 §3.3.3 — "one bordered primary, one overflow", for every status,
 * not only the two the handoff names: `staged` → primary Activate, overflow
 * {Remove}; `active` → primary Disable, overflow {Reset data, Remove};
 * `superseded` → primary Rollback to this, overflow {Remove}; `failed` →
 * primary Reload, overflow {Remove}; `disabled` → primary Enable, overflow
 * {Remove}; `verifying` → no primary (disabled placeholder), overflow empty.
 * Reset data is offered only for `active` — the server refuses it for any
 * other status (`PluginActions.tsx`'s own comment below).
 *
 * `where` changes two words of copy ("on this same row" / "on this page") and
 * nothing about which action is offered or what it posts. `dense` is the
 * table row's tighter button metrics.
 */
export function PluginActions({
  versions,
  selected,
  onChanged,
  where = 'row',
  dense = true,
}: {
  /** Every published version of ONE plugin, newest first. */
  versions: PluginListRow[]
  /** The version every control below acts on. */
  selected: PluginListRow
  onChanged: () => void
  where?: 'row' | 'page'
  dense?: boolean
}) {
  const p = selected
  const { run, isPending } = useAction()
  const registered = p.scriptCount ?? 0
  // Plan 126 §3.2 — the id/title projection of `manifest.scripts` the list route
  // now carries in place of the manifest. This reads only `.id`, which is what
  // made the full member schemas droppable in the first place.
  const declared = p.declaredScripts
  const btn = dense ? 'h-7 text-[12px]' : undefined
  const enableSentence = where === 'row' ? 'Enable, on this same row,' : 'Enable, on this page,'
  // plan 219 §3.3.5 — known before the request, from the manifest.
  const scriptsMoved = declared.length

  const activate = () =>
    run('activate-' + p.id, () => api(`/api/plugins/${p.id}/activate`, PluginActivateResponseSchema, { method: 'POST' }), {
      failure: 'Could not activate this version',
      onSuccess: (b) => {
        // plan 219 §3.3.5 — the ACTUAL counts, known only now.
        toast.success(
          `${p.name}@${p.version} activated`,
          b.queuedKeepingPrevious > 0
            ? { description: `${b.scriptsMoved} script${b.scriptsMoved === 1 ? '' : 's'} moved; ${b.queuedKeepingPrevious} queued job${b.queuedKeepingPrevious === 1 ? '' : 's'} kept the previous version.` }
            : { description: `${b.scriptsMoved} script${b.scriptsMoved === 1 ? '' : 's'} moved.` },
        )
        onChanged()
      },
    })
  const rollback = () =>
    run(
      'rollback-' + p.id,
      () => api(`/api/plugins/${p.name}/rollback`, PluginRowResponseSchema, { method: 'POST', json: { toVersion: p.version } }),
      {
        success: `Rolled back to ${p.name}@${p.version}`,
        failure: 'Could not roll back to this version',
        onSuccess: onChanged,
      },
    )
  const reload = () =>
    run('reload-' + p.id, () => api(`/api/plugins/${p.name}/reload`, PluginVerifyResponseSchema, { method: 'POST' }), {
      failure: 'Could not reload this plugin',
      onSuccess: onChanged,
    })
  /**
   * P2 (plan 108 §0.2) — `POST /api/plugins/:name/disable` had no caller.
   *
   * It used to have no counterpart either: `activate` CASes on a `staged` row
   * and `rollback` needs a `superseded` one, so a `disabled` version was
   * reachable by no transition at all, and the confirm below said so in as
   * many words ("There is no Enable button"). `POST /:name/enable` closes that
   * hole, so that sentence is gone: it was true when written and is not any
   * more, which is the worse of the two failures a piece of UI copy can have.
   */
  const disable = () =>
    run('disable-' + p.id, () => api(`/api/plugins/${encodeURIComponent(p.name)}/disable`, PluginOkResponseSchema, { method: 'POST' }), {
      success: `${p.name} disabled`,
      failure: 'Could not disable this plugin',
      onSuccess: onChanged,
    })
  /**
   * The way back. Keyed by NAME, not id, and answering `{ plugin }` because it
   * ends the same way `activate`/`rollback` do: a row that is now `active`. A
   * 409 (`plugin_enable_conflict`: a DIFFERENT version of this plugin is
   * already active) is a normal outcome, not a bug, and `useAction` surfaces
   * the server's own wording for it rather than inventing a second explanation
   * here.
   */
  const enable = () =>
    run('enable-' + p.id, () => api(`/api/plugins/${encodeURIComponent(p.name)}/enable`, PluginRowResponseSchema, { method: 'POST' }), {
      success: `${p.name} enabled`,
      failure: 'Could not enable this plugin',
      onSuccess: onChanged,
    })

  return (
    <div className="flex items-center justify-end gap-1">
      {p.status === 'staged' && (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" className={btn} disabled={isPending('activate-' + p.id)}>
              Activate
            </Button>
          }
          title={`Activate ${p.name}@${p.version}?`}
          description={
            <>
              <p>
                This version registers {scriptsMoved} script{scriptsMoved === 1 ? '' : 's'}
                {declared.length > 0 ? ` — ${declared.map((s) => `${p.name}/${s.id}`).join(', ')}` : ''} — which become what{' '}
                <span className="font-mono">{p.name}/@latest</span> resolves to.
              </p>
              <p className="mt-2">
                Any job already queued or running against the current active version keeps running against it — it is not moved.
              </p>
            </>
          }
          confirmLabel="Activate"
          onConfirm={activate}
        />
      )}
      {p.status === 'superseded' && (
        <Button size="sm" variant="outline" className={btn} disabled={isPending('rollback-' + p.id)} onClick={rollback}>
          Rollback to this
        </Button>
      )}
      {p.status === 'failed' && (
        <Button size="sm" variant="outline" className={btn} disabled={isPending('reload-' + p.id)} onClick={reload}>
          Reload
        </Button>
      )}
      {p.status === 'disabled' && (
        <Button size="sm" variant="outline" className={btn} disabled={isPending('enable-' + p.id)} onClick={enable}>
          Enable
        </Button>
      )}
      {p.status === 'active' && (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline" className={btn} disabled={isPending('disable-' + p.id)}>
              Disable
            </Button>
          }
          title={`Disable ${p.name}@${p.version}?`}
          description={
            <>
              <p>
                Its {registered} script{registered === 1 ? '' : 's'} stop resolving straight away
                {declared.length > 0 ? ` (${declared.map((s) => `${p.name}/${s.id}`).join(', ')})` : ''}. A job already running is left
                alone; the next one that names one of them fails to start.
              </p>
              <p className="mt-2">
                {enableSentence} puts this exact version back — no republishing, and nothing stored under its{' '}
                <span className="font-mono">{p.name}</span> namespace is deleted meanwhile. The one thing that can stand in the way is
                activating a different version of {p.name} in between: only one version of a name is ever live, so Enable is refused while
                another one holds the slot.
              </p>
            </>
          }
          confirmLabel="Disable"
          onConfirm={disable}
        />
      )}
      {p.status === 'verifying' && (
        <Button size="sm" variant="outline" className={btn} disabled>
          Verifying…
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 w-7 px-0" aria-label={`More actions for ${p.name}@${p.version}`}>
            <DotsThreeIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/*
            Reset data — offered on the ACTIVE version only, and that is the
            server's rule rather than a UI preference. `POST /:name/reset`
            refuses a plugin with no active version outright: a disabled
            version's manifest is where its own cleanup handler is declared,
            and the farm can only read the active row's, so resetting one
            would delete its data while reporting that it had nothing to
            undo. Rendering the item on a superseded row would offer an act
            the server will not perform.
          */}
          {p.status === 'active' && (
            <DropdownMenuItem asChild>
              <ResetPluginAction selected={p} onChanged={onChanged} dense trigger={<span className="w-full">Reset data</span>} />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild className="text-led-danger focus:text-led-danger">
            <RemovePluginAction
              versions={versions}
              selected={p}
              onChanged={onChanged}
              dense
              // plan 219 §4.4 — one scope in the overflow: `RemovePluginAction`
              // renders its own nested `DropdownMenu` when `scopes.length > 1`,
              // which cannot sit inside this `DropdownMenuItem asChild` (a
              // single child is required). The bulk scopes (all versions / all
              // except latest) stay reachable wherever this component is
              // rendered with `scopes` left at its multi-scope default outside
              // an overflow menu — see plan 219 §11 for the discrepancy this
              // records against the pre-219 row, which offered them here too.
              scopes={['version']}
              trigger={<span className="w-full">Remove</span>}
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
