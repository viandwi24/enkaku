'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActionSpec, ViewSpec } from '@enkaku/protocol'
import { ActionRunner, type ActionInvocation } from '@/components/plugin-view/ActionRunner'
import { fetchPluginRows } from '@/components/plugin-view/data'
import { planColumn } from '@/components/plugin-view/planColumn'
import { readRowField, type PluginViewRow } from '@/components/plugin-view/rows'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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

export interface ViewRendererProps {
  plugin: string
  view: ViewSpec
  /** Only the actions this view references — `GET /:name/view/:viewId` already narrowed them. */
  actions: Record<string, ActionSpec>
}

export function ViewRenderer({ plugin, view, actions }: ViewRendererProps) {
  const [rows, setRows] = useState<PluginViewRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
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
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [plugin, source])

  useEffect(load, [load])

  const selectedRows = useMemo(() => (rows ?? []).filter((row) => selected.has(row.id)), [rows, selected])
  const selectedDeviceIds = useMemo(
    () => [...new Set(selectedRows.map((row) => row.device?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))],
    [selectedRows],
  )

  // A frame view has no table to draw. Since step 108.10 the PAGE routes one
  // to `FrameView` before this component is ever reached, so this branch is
  // defence in depth for a caller that renders `ViewRenderer` directly —
  // saying so is better than an empty table that reads as a load failure.
  if (view.frame) {
    return (
      <div className="px-5 py-4">
        <EmptyState
          title="This screen is not a table"
          description="It declares its own embedded interface, which is drawn by the plugin view page rather than by the table renderer."
        />
      </div>
    )
  }

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
        <ErrorState message={error} onRetry={load} />
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
