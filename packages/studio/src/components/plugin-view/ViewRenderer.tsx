'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PluginServiceRestartResponseSchema, type ActionSpec, type ViewSpec } from '@enkaku/protocol'
import { ActionRunner, type ActionInvocation } from '@/components/plugin-view/ActionRunner'
import { fetchPluginRows } from '@/components/plugin-view/data'
import { planColumn } from '@/components/plugin-view/planColumn'
import { readRowField, type PluginViewRow } from '@/components/plugin-view/rows'
import { EmptyState, ErrorState, LoadingRows, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, api } from '@enkaku/ui'
import { useNow } from '@/lib/useNow'

/**
 * Plan 108 §3.2 tier A, §4.3, §4.7, §5 step 108.7 — the ONE renderer every
 * declarative plugin screen goes through.
 *
 * It draws with Studio's own components (`Table`, `Button`, `EmptyState`,
 * `ErrorState`, `LoadingRows`) rather than components merely styled to look
 * like them — that is §3.2's whole reason for preferring tier A over the
 * iframe, and it only stays true because this file imports the real ones.
 *
 * It contains **no field vocabulary**: every cell's appearance comes from
 * `planColumn`, an adapter onto `planField`/`formatFieldValue` and nothing
 * else (§3.3, the one-resolver rule). What this file owns is the two things a
 * table has that a form does not — where a row comes from (`./rows.ts`) and
 * what an operator can do to one.
 *
 * | `data.kind` | route | one row is |
 * |---|---|---|
 * | `kv.scan`, `rows: 'entry'` | `GET /:name/data/scan?key=…` | one device |
 * | `kv.scan`, `rows: 'items'` | the same | one element of `itemsAt` inside that device's entry, carrying its `$device` and `$entry` |
 * | `kv.list` | `GET /:name/data?scope=global` | one entry in the plugin's global namespace |
 *
 * All three of loading, empty and error are handled (`docs/design.md`'s own
 * floor for any screen that fetches), and the empty state prefers the view's
 * OWN `empty` copy — an author who wrote "Run Sync accounts to read the
 * switch-account sheet on each device" knows something generic text cannot.
 */

/** Written out in full — Tailwind v4 never generates a class built from a
 *  template literal (`docs/design.md`, and `TargetPicker`'s own note). */
const WIDTH_CLASS: Record<'auto' | 'narrow' | 'wide', string> = { auto: '', narrow: 'w-24', wide: 'min-w-64' }

/**
 * Plan 109 §4.6, step 109.6, criterion 21 — **a view whose `{ kind: 'handler' }`
 * data source has no service behind it.**
 *
 * This is the part of the plugin runtime an operator actually meets, and there
 * are exactly two wrong answers, both of which a naive `catch` produces: an
 * EMPTY TABLE, which says "you have no data" — a claim about the operator's own
 * work, and a false one — and a spinner that never resolves, which says
 * nothing at all. What it must say instead is which plugin, which state, and
 * what to do.
 *
 * The four states are kept apart because they need different verbs, and the
 * one that matters most is `starting`. `starting` is not `running` and it is
 * not broken either (plan 109 §4.2 enforces the distinction in the host, with
 * `E_PLUGIN_RUNTIME_STARTING` as its own code); the honest affordance for "not
 * yet" is Try again, and offering Restart would invite an operator to kick a
 * service that was about to come up.
 *
 * `null` means this is not a service outage at all — an ordinary fetch failure,
 * rendered as it always was.
 */
function describeServiceOutage(plugin: string, code: string | null, detail: string): { message: string; restart: boolean } | null {
  switch (code) {
    case 'E_PLUGIN_RUNTIME_STARTING':
      return {
        message: `The plugin “${plugin}” is still starting, so this screen has nothing behind it yet. It is not broken — give it a moment and try again.`,
        restart: false,
      }
    case 'E_PLUGIN_RUNTIME_NOT_RUNNING':
    case 'E_PLUGIN_RUNTIME_NOT_LOADED':
      return {
        message: `The plugin “${plugin}” is installed, but its service is not running — so nothing is there to build this screen's rows. ${detail}`,
        restart: true,
      }
    case 'E_PLUGIN_RUNTIME_DISABLED':
      return {
        // The budget is "loud and finite, never a silent loop" (§4.2) — so the
        // copy has to say out loud that nothing will retry on its own, or an
        // operator will wait for a recovery that is never coming.
        message:
          `The plugin “${plugin}” failed too many times in a row, so the farm stopped its service and will NOT retry on its own. ` +
          `Fix the cause, then restart it. ${detail}`,
        restart: true,
      }
    case 'E_PLUGIN_DEV_SLOT_NO_SERVICE':
      // No Restart, deliberately: there is nothing loaded to restart, and a
      // button that cannot help is worse than no button. The server's message
      // is the actionable half (publish and activate), so it is kept verbatim.
      return { message: detail, restart: false }
    default:
      return null
  }
}

function errorCode(err: unknown): string | null {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : null
}

export interface ViewRendererProps {
  plugin: string
  view: ViewSpec
  /** Only the actions this view references — `GET /:name/view/:viewId` already narrowed them. */
  actions: Record<string, ActionSpec>
}

export function ViewRenderer({ plugin, view, actions }: ViewRendererProps) {
  const [rows, setRows] = useState<PluginViewRow[] | null>(null)
  /** The `code` rides along with the message: it is what tells a service outage apart from an ordinary fetch failure. */
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [invocation, setInvocation] = useState<ActionInvocation | null>(null)
  // One interval for the whole table, so every `kind: 'timestamp'` cell ticks
  // together instead of each freezing at its own first render (plan 17 §4.6).
  const now = useNow(30_000)

  const source = view.data
  const table = view.table

  const load = useCallback(() => {
    if (!source) return
    setError(null)
    setRows(null)
    void fetchPluginRows(plugin, source)
      .then((next) => {
        setRows(next)
        // A refetch can drop a row that was selected; keeping its id would
        // silently target a device that is no longer on screen.
        setSelected((prev) => new Set([...prev].filter((id) => next.some((row) => row.id === id))))
      })
      .catch((e) => setError({ message: e instanceof Error ? e.message : String(e), code: errorCode(e) }))
  }, [plugin, source])

  useEffect(load, [load])

  /**
   * Criterion 21's Restart. `POST /:name/runtime/restart` (`plugin.runtime`),
   * then reload the rows — a restart the operator cannot see the result of is
   * a button that appears to do nothing.
   *
   * The response carries the STATUS the service landed in rather than an `ok`
   * flag, and a restart that lands on `starting` is reported as exactly that:
   * the reload below will then hit `E_PLUGIN_RUNTIME_STARTING` and the panel
   * says "still starting", which is the truth rather than a success message
   * followed by an empty table.
   */
  const restart = useCallback(() => {
    setRestarting(true)
    void api(`/api/plugins/${encodeURIComponent(plugin)}/runtime/restart`, PluginServiceRestartResponseSchema, { method: 'POST' })
      .then(() => {
        setError(null)
        load()
      })
      .catch((e) => setError({ message: e instanceof Error ? e.message : String(e), code: errorCode(e) }))
      .finally(() => setRestarting(false))
  }, [plugin, load])

  const selectedRows = useMemo(() => (rows ?? []).filter((row) => selected.has(row.id)), [rows, selected])
  const selectedDeviceIds = useMemo(
    () => [...new Set(selectedRows.map((row) => row.device?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))],
    [selectedRows],
  )

  // A view this renderer cannot draw says so, rather than showing an empty
  // table that reads as a load failure. `validatePluginSurface` already
  // refuses a renderer-less view at verify and names the offending view id, so
  // reaching here means a caller rendered `ViewRenderer` directly — defence in
  // depth, not a path an operator normally sees.
  if (!source || !table) {
    return (
      <div className="px-5 py-4">
        <ErrorState message={`The plugin “${plugin}” declares this screen without both a data source and a table, so there is nothing to draw.`} />
      </div>
    )
  }

  const named = (ids: readonly string[]) =>
    ids.map((id) => ({ id, action: actions[id] })).filter((entry): entry is { id: string; action: ActionSpec } => entry.action !== undefined)
  const toolbarActions = named(view.toolbar)
  const rowActions = named(view.rowActions)

  const allSelected = rows !== null && rows.length > 0 && rows.every((row) => selected.has(row.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set((rows ?? []).map((row) => row.id)))
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-3 px-5 py-4">
      {toolbarActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {toolbarActions.map(({ id, action }) => {
            // A selection-targeted batch with nothing selected is genuinely
            // disabled, with the reason in a tooltip — `docs/design.md`'s
            // quality floor, not a button that looks live and then refuses.
            const needsSelection = action.kind === 'batch' && action.target === 'selection' && selectedDeviceIds.length === 0
            return (
              <Button
                key={id}
                size="sm"
                variant="outline"
                onClick={() => setInvocation({ actionId: id, action, row: null, selectedDeviceIds })}
                disabled={needsSelection}
                title={needsSelection ? 'Select at least one row first — this action runs on the devices you have selected.' : undefined}
              >
                {action.label}
              </Button>
            )
          })}
          {table.selectable && selectedRows.length > 0 && (
            <span className="readout text-[11.5px] text-fg-muted">
              {selectedRows.length} row{selectedRows.length === 1 ? '' : 's'} selected · {selectedDeviceIds.length} device
              {selectedDeviceIds.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {error ? (
        (() => {
          // A service outage is a different thing from a failed fetch, and the
          // difference is the whole of criterion 21: never an empty table
          // (which reads as "no data" — a lie), never a spinner that does not
          // resolve. Named plugin, named state, and the one verb that helps.
          const outage = describeServiceOutage(plugin, error.code, error.message)
          if (!outage) return <ErrorState message={error.message} onRetry={load} />
          return (
            <div className="space-y-2">
              <ErrorState message={outage.message} onRetry={load} />
              {outage.restart && (
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={restart} disabled={restarting}>
                    {restarting ? 'Restarting…' : `Restart ${plugin}`}
                  </Button>
                </div>
              )}
            </div>
          )
        })()
      ) : rows === null ? (
        <LoadingRows rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={view.empty?.title ?? 'Nothing stored yet'}
          description={view.empty?.hint ?? `The plugin “${plugin}” has not written anything for this screen yet.`}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {table.selectable && (
                  <TableHead className="w-10">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select every row" />
                  </TableHead>
                )}
                {table.columns.map((column) => (
                  <TableHead key={column.field} className={WIDTH_CLASS[column.width]}>
                    {column.header}
                  </TableHead>
                ))}
                {rowActions.length > 0 && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-state={selected.has(row.id) ? 'selected' : undefined}>
                  {table.selectable && (
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleRow(row.id)}
                        aria-label={`Select ${String(readRowField(row, table.rowKey) ?? row.id)}`}
                      />
                    </TableCell>
                  )}
                  {table.columns.map((column) => {
                    const cell = planColumn(column.schema, readRowField(row, column.field), now)
                    return (
                      <TableCell key={column.field} className={cell.raw ? 'readout text-[11.5px] text-fg-muted' : 'text-[12.5px]'}>
                        {cell.text}
                      </TableCell>
                    )
                  })}
                  {rowActions.length > 0 && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {rowActions.map(({ id, action }) => (
                          <Button
                            key={id}
                            size="sm"
                            variant="ghost"
                            className="h-7 text-[12px]"
                            onClick={() => setInvocation({ actionId: id, action, row, selectedDeviceIds })}
                          >
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {invocation && (
        <ActionRunner
          plugin={plugin}
          rowKey={table.rowKey}
          invocation={invocation}
          onClose={() => setInvocation(null)}
          onDone={() => {
            setInvocation(null)
            load()
          }}
        />
      )}
    </div>
  )
}
