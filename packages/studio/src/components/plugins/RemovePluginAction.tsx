'use client'

import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PluginDataCountResponseSchema, PluginRemoveResponseSchema, type PluginDataCountResponse } from '@enkaku/protocol'
import { Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, api, useAction } from '@enkaku/ui'
import type { PluginListRow } from '@/app/plugins/plugin-list'
import { previewBulkRemoval, requestBulkRemoval, summariseBulkRemoval } from '@/lib/plugin-removal'

/**
 * Split out of `PluginActions.tsx` by plan 219 §4.4 — a file move, not a
 * logic change (`rg -n "export function RemovePluginAction"` finds exactly
 * one definition, in this file). It also gains an optional `trigger` prop
 * (§3.3.4): composing it inside a `DropdownMenuItem` (the plugin row's ⋯
 * overflow) needs the trigger to be a menu row rather than a floating
 * button — the same shape `AdbRestartDialog`/`InstallPluginDialog` already
 * expose. The default is the plain inline button every other caller keeps.
 *
 * The three shapes a removal can take (the farm owner's own ask, 2026-08-17:
 * *"remove specific versi, atau remove all version, atau remove all except
 * latest version"*).
 *
 * All three are live. `version` is `DELETE /api/plugins/:name/:version`; the
 * other two are `POST /api/plugins/:name/versions/remove` with a `scope`, whose
 * browser half is `lib/plugin-removal.ts`.
 *
 * **`all-except-latest` keeps more than the latest, and the dialog says so by
 * name.** The active version and the newest version are usually the same row
 * and sometimes are not — a rollback leaves an older version `active` while a
 * newer one sits `superseded` — so the server also keeps the live row, the
 * disabled row (the only one Enable can reach) and anything mid-verify. Which
 * rows those are for THIS plugin comes from `planPluginVersionRemoval` in
 * `@enkaku/protocol`, the same function the core plans the deletion with, so
 * the promise this dialog makes and the work the server does cannot diverge.
 */
export type RemoveScope = 'version' | 'all' | 'all-except-latest'

export interface RemoveScopeCopy {
  /** The dropdown item, when more than one scope is offered. */
  item: string
  title: string
  body: ReactNode
  /**
   * Whether this scope may offer "also delete the data this plugin stored".
   * `all-except-latest` may NOT: every version shares one KV namespace, so
   * deleting it would empty the store out from under the version the operator
   * explicitly chose to keep.
   */
  offersKv: boolean
  confirmLabel: string
}

export function describeRemoveScope(
  scope: RemoveScope,
  ctx: { name: string; version: string; versionCount: number; latest: string },
): RemoveScopeCopy {
  const others = ctx.versionCount - 1
  switch (scope) {
    case 'version':
      return {
        item: `Remove ${ctx.version}`,
        title: `Remove ${ctx.name}@${ctx.version}?`,
        body: (
          <p>
            Its scripts stop resolving, and this version is deleted from the list.
            {others > 0 ? ` The other ${others} version${others === 1 ? '' : 's'} of ${ctx.name} stay as they are.` : ''}
          </p>
        ),
        offersKv: true,
        confirmLabel: 'Remove',
      }
    case 'all':
      return {
        item: 'Remove every version',
        title: `Remove all ${ctx.versionCount} versions of ${ctx.name}?`,
        body: (
          <p>
            Every published version of <span className="readout">{ctx.name}</span> is deleted, including the one that is live. Its scripts
            stop resolving straight away and the plugin leaves this farm entirely. Jobs that already ran keep their history.
          </p>
        ),
        offersKv: true,
        confirmLabel: 'Remove all versions',
      }
    case 'all-except-latest':
      return {
        item: `Remove every version except ${ctx.latest}`,
        title: `Prune the version history of ${ctx.name}?`,
        body: (
          // Deliberately no count and no version names in this sentence: the
          // exact lists are rendered below it from the SERVER'S OWN plan
          // (`previewBulkRemoval`), and a hand-written "the 9 older ones" here
          // would be a second, drifting claim about the same request — wrong
          // the first time a rollback leaves the live version behind the newest.
          <p>
            Nothing that is running stops running. What you lose is the ability to roll back to the versions that go.
          </p>
        ),
        offersKv: false,
        confirmLabel: 'Remove these versions',
      }
  }
}

export function RemovePluginAction({
  versions,
  selected,
  onChanged,
  dense = true,
  scopes = ['version'],
  trigger,
}: {
  versions: PluginListRow[]
  selected: PluginListRow
  onChanged: () => void
  dense?: boolean
  /**
   * Which removals this farm can actually perform. One scope renders one plain
   * button (today's shape, byte for byte); more than one renders a menu. A
   * follow-up that ships the bulk routes passes all three here.
   */
  scopes?: RemoveScope[]
  /** plan 219 §3.3.4 — a menu-row trigger for the plugin table's ⋯ overflow. Default: the plain inline button every other caller keeps. */
  trigger?: ReactNode
}) {
  const p = selected
  const { run, isPending } = useAction()
  const btn = dense ? 'h-7 text-[12px]' : undefined
  const latest = versions[0]?.version ?? p.version
  const many = scopes.length > 1

  /**
   * P4 (plan 108 §0.2) — this dialog used to hardcode `deleteKv=false` and
   * tell the operator to delete the plugin's KV values "from the Key/Value
   * store settings", advice nobody could follow: `KvPanel` deletes one key at a
   * time and needs the namespace typed from memory. It is a checkbox now, and
   * the dialog states the real entry count before asking.
   *
   * The count comes from `GET /api/plugins/:name/data/count`. It is OPTIONAL by
   * construction: an older core answers 404, and the checkbox still renders —
   * saying plainly that the number could not be read, rather than hiding the
   * only way to delete the data.
   */
  const [openScope, setOpenScope] = useState<RemoveScope | null>(null)
  const [deleteKv, setDeleteKv] = useState(false)
  const [dataCount, setDataCount] = useState<PluginDataCountResponse | null>(null)
  const [countState, setCountState] = useState<'loading' | 'known' | 'unavailable'>('loading')

  const openRemove = (scope: RemoveScope) => {
    setOpenScope(scope)
    setDeleteKv(false)
    setDataCount(null)
    setCountState('loading')
    api(`/api/plugins/${encodeURIComponent(p.name)}/data/count`, PluginDataCountResponseSchema)
      .then((c) => {
        setDataCount(c)
        setCountState('known')
      })
      .catch(() => setCountState('unavailable'))
  }

  /**
   * One version goes to `DELETE /:name/:version`; the two bulk scopes go to
   * `POST /:name/versions/remove` (`lib/plugin-removal.ts`). Two routes, and
   * deliberately not two removal implementations — the bulk route drives the
   * SAME `PluginRuntime.remove` per version that the single one does, so the
   * guards (a queued or running job holding a version is refused,
   * `script_in_use`), the asset cleanup and the audit row per version are
   * identical whichever button was pressed.
   */
  const remove = (scope: RemoveScope, kv: boolean) => {
    if (scope === 'version') {
      return run(
        'remove-' + p.id,
        () =>
          api(`/api/plugins/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}?deleteKv=${kv ? '1' : '0'}`, PluginRemoveResponseSchema, {
            method: 'DELETE',
          }),
        {
          failure: 'Could not remove this version',
          onSuccess: (r) => {
            toast.success(
              `${p.name}@${p.version} removed`,
              r.kvDeleted > 0 ? { description: `${r.kvDeleted} stored entr${r.kvDeleted === 1 ? 'y' : 'ies'} deleted` } : undefined,
            )
            onChanged()
          },
        },
      )
    }
    return run('remove-' + p.id, () => requestBulkRemoval(p.name, scope, kv), {
      failure: 'Could not remove these versions',
      onSuccess: (report) => {
        /**
         * **Partial success is a success**, and the toast says which way round.
         * Nine removed with two refused is a completed request — raising it as
         * a failure would tell the operator nothing happened when nine rows are
         * gone — but the two refusals are named, with the core's own code, so
         * the one part they can act on is the part they are shown. A request
         * that removed NOTHING is the only genuine failure here.
         */
        const summary = summariseBulkRemoval(p.name, report)
        const body = summary.description ? { description: summary.description } : undefined
        if (summary.removed.length === 0 && summary.failed.length > 0) toast.error(summary.title, body)
        else if (summary.failed.length > 0 || summary.removed.length === 0) toast.warning(summary.title, body)
        else toast.success(summary.title, body)
        onChanged()
      },
    })
  }

  const ctx = { name: p.name, version: p.version, versionCount: versions.length, latest }
  const copy = describeRemoveScope(openScope ?? (scopes[0] as RemoveScope), ctx)

  /**
   * The two lists a multi-version destructive confirm owes the operator: what
   * goes and what stays, by NAME and count, before they press anything.
   *
   * Computed by `planPluginVersionRemoval` — the function the core plans the
   * same request with — rather than restated here. That is what makes this a
   * preview rather than a guess: if the server would keep the active row
   * because a rollback left it behind the newest one, this dialog says so,
   * with that version's number in it, because it asked the same rule.
   */
  const preview = openScope && openScope !== 'version' ? previewBulkRemoval(versions, openScope) : null

  const defaultTrigger = (
    <Button
      size="sm"
      variant="ghost"
      className={btn}
      disabled={isPending('remove-' + p.id)}
      onClick={() => openRemove(scopes[0] as RemoveScope)}
    >
      Remove
    </Button>
  )

  return (
    <>
      {many && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {trigger ?? (
              <Button size="sm" variant="ghost" className={btn} disabled={isPending('remove-' + p.id)}>
                Remove
              </Button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {scopes.map((s) => (
              <DropdownMenuItem key={s} className="text-led-danger focus:text-led-danger" onSelect={() => openRemove(s)}>
                {describeRemoveScope(s, ctx).item}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <ConfirmDialog
        open={openScope !== null}
        onOpenChange={(next) => {
          if (!next) {
            setOpenScope(null)
            setDeleteKv(false)
          }
        }}
        // With one scope the trigger IS the dialog's own trigger, exactly as
        // it was before this component existed (`trigger` when given, else
        // the plain inline button) — wrapped so a caller-supplied trigger
        // (a menu row, which carries no `onClick` of its own) still calls
        // `openRemove`, the actual opening mechanism for this fully
        // controlled dialog. With several scopes, the menu above opens it
        // instead and this node is never rendered visibly — `ConfirmDialog`
        // requires a trigger element, so it gets an empty, inert one.
        trigger={
          many ? (
            <span className="hidden" aria-hidden />
          ) : trigger ? (
            <span onClick={() => openRemove(scopes[0] as RemoveScope)}>{trigger}</span>
          ) : (
            defaultTrigger
          )
        }
        title={copy.title}
        description={
          <>
            {copy.body}
            {preview && (
              <div className="mt-2.5 space-y-2 rounded border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
                <div>
                  <span className="font-medium text-fg">
                    {preview.going.length} {preview.going.length === 1 ? 'version goes' : 'versions go'}
                  </span>
                  {preview.going.length > 0 ? (
                    <span className="readout ml-1.5 break-words text-fg-muted">{preview.going.join(', ')}</span>
                  ) : (
                    // A real outcome, not an empty state: pruning a plugin whose
                    // every row is live or newest removes nothing, and saying so
                    // here is better than a confirm that promises an act it
                    // cannot perform.
                    <span className="ml-1.5 text-fg-muted">— there is nothing older to remove.</span>
                  )}
                </div>
                {preview.staying.length > 0 && (
                  <div>
                    <span className="font-medium text-fg">
                      {preview.staying.length} {preview.staying.length === 1 ? 'version stays' : 'versions stay'}
                    </span>
                    <ul className="mt-0.5 space-y-0.5 text-fg-muted">
                      {preview.staying.map((s) => (
                        <li key={s.version}>
                          <span className="readout">{s.version}</span> — {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {copy.offersKv && (
              <label className="mt-2.5 flex items-start gap-2 rounded border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-fg">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={deleteKv}
                  onChange={(e) => setDeleteKv(e.target.checked)}
                  aria-label={`Also delete data stored by ${p.name}`}
                />
                <span className="min-w-0">
                  {countState === 'loading'
                    ? `Also delete the data ${p.name} has stored — counting it now…`
                    : countState === 'known' && dataCount
                      ? `Also delete the data ${p.name} has stored (${dataCount.global} global, ${dataCount.device} device ${
                          dataCount.global + dataCount.device === 1 ? 'entry' : 'entries'
                        }).`
                      : versions.some((v) => v.status === 'active')
                        ? `Also delete the data ${p.name} has stored (this farm could not report how many entries there are).`
                        : // `GET /:name/data/count` refuses a plugin that is neither active nor in a dev
                          // slot (`requireLivePlugin`) — exactly the case when the last version of a
                          // plugin is being removed. Say that, rather than implying a fault.
                          `Also delete the data ${p.name} has stored (counting it needs an active version of ${p.name}, so this farm cannot say how many entries there are).`}{' '}
                  Every version shares one key/value namespace, so this deletes what the other versions wrote too. Left in place unless you
                  tick this.
                </span>
              </label>
            )}
          </>
        }
        confirmLabel={copy.offersKv && deleteKv ? 'Remove and delete data' : copy.confirmLabel}
        onConfirm={() => remove(openScope ?? 'version', deleteKv)}
      />
    </>
  )
}
