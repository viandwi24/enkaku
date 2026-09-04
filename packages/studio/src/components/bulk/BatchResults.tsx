'use client'

import { useEffect, useState } from 'react'
import { BatchResultsResponseSchema, type BatchMemberResult, type JsonSchemaNode } from '@enkaku/protocol'
import { api, Button, EmptyState, ErrorState, LoadingRows, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, DeviceName } from '@enkaku/ui'
import { planResult } from '@/components/result-view/plan-result'
import { renderCell } from '@/components/result-view/ResultView'
import { JobStatusBadge } from '@/components/StatusBadge'

/**
 * Every member's result, side by side.
 *
 * ## Why this exists
 *
 * A batch's members table shows `resultSummary` — one line, 120 characters,
 * truncated, and only when the script declared `summary` fields. Everything
 * else lived behind a link to the job detail route, one member at a time. On the
 * owner's own farm that is forty round trips to answer "what did this batch
 * actually return", which is the question a batch page exists to answer.
 *
 * ## How the columns are chosen
 *
 * From the script's OWN result schema, through `planResult` — the same planner
 * `ResultView` uses for a single job, and `renderCell` is the same formatter.
 * That sharing is deliberate: a value must not read one way on a job's page and
 * another way in the table comparing forty of them.
 *
 * Only scalar top-level fields become columns. A `group`/`table`/`list` field
 * would be JSON in a cell — unreadable at this width, and `renderCell` already
 * says so by falling back to raw text. Those stay in the member's own panel,
 * one click away, where there is room for them.
 *
 * ## What it refuses to do
 *
 * Show fewer members than the batch has. Every member gets a row even when its
 * value could not be carried, with the reason in the cell — on a farm where
 * "which three devices did NOT do the thing" is the question, a table that
 * quietly drops rows hides exactly what is being looked for.
 */

/** Columns are capped so a wide result stays a table rather than a horizontal scroll with no shape. The rest are in the member's own panel. */
const MAX_COLUMNS = 6

interface Column {
  key: string
  label: string
  plan: ReturnType<typeof planResult>[number]['plan']
}

/**
 * The scalar top-level fields of a result schema, in the schema's own order.
 *
 * `planResult` needs a value to plan against (it marks fields present in the
 * value but absent from the schema), so it is called with an empty object: the
 * columns are a property of the SCHEMA, identical for every member, and letting
 * one member's extra key add a column would give the table a different shape
 * depending on which member happened to be first.
 */
export function columnsOf(schema: JsonSchemaNode | null): Column[] {
  if (!schema) return []
  return planResult(schema, {})
    .filter((f) => !f.unknown && f.plan.control !== 'group' && f.plan.control !== 'table' && f.plan.control !== 'list')
    .slice(0, MAX_COLUMNS)
    .map((f) => ({ key: f.path, label: f.label, plan: f.plan }))
}

/** What a cell shows when the response carried no value for this member. Never blank — a blank cell reads as "the script returned nothing". */
export function omissionText(item: BatchMemberResult): string | null {
  switch (item.omitted) {
    case 'unfinished':
      return 'not finished yet'
    case 'budget':
      return 'not loaded — open the member'
    case 'too-large':
      return 'too large to show here'
    default:
      return item.result === undefined ? 'no result' : null
  }
}


// ---------------------------------------------------------------------------
// Making forty rows readable (2026-08-28).
// ---------------------------------------------------------------------------

/** The three questions an operator actually asks of a finished batch, in the order they ask them. */
export type ResultFilter = 'all' | 'ok' | 'failed' | 'no-value'

export function matchesFilter(item: BatchMemberResult, filter: ResultFilter): boolean {
  switch (filter) {
    case 'ok':
      return item.status === 'success'
    case 'failed':
      return item.status === 'failed' || item.status === 'expired' || item.status === 'cancelled'
    case 'no-value':
      // The rows a values table cannot answer for. Grouped as one because the
      // follow-up is the same for all of them: open the member.
      return item.result === undefined
    default:
      return true
  }
}

/**
 * Members grouped by the values they returned.
 *
 * The insight this is built on is `SkippedGroups`': on forty near-identical
 * devices, the interesting thing is never the forty rows — it is that
 * thirty-seven of them agree and three do not. Reading that off a forty-row
 * table means comparing forty rows by eye, which is precisely the work a
 * computer should have done.
 *
 * Grouped on the COLUMN values only, not the whole result: two members whose
 * `anchors` differ by a millisecond timing are the same outcome to an operator,
 * and grouping on the raw object would put every one of them in its own group
 * and say nothing at all.
 */
export function groupByValues(items: readonly BatchMemberResult[], columns: readonly Column[]): { key: string; cells: string[]; members: BatchMemberResult[] }[] {
  const groups = new Map<string, { key: string; cells: string[]; members: BatchMemberResult[] }>()
  for (const item of items) {
    if (item.result === undefined) continue
    const cells = columns.map((c) => renderCell(c.plan, (item.result as Record<string, unknown>)?.[c.key]))
    const key = cells.join('\u0000')
    const existing = groups.get(key)
    if (existing) existing.members.push(item)
    else groups.set(key, { key, cells, members: [item] })
  }
  // Largest first: the majority outcome is the context, and the small groups
  // are what an operator is hunting for.
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length)
}

/**
 * The table as CSV — the same rows, the same columns, the same formatter.
 *
 * Built from `renderCell` rather than the raw values so the file says what the
 * screen said. An export that quietly differs from the table it came from is
 * worse than no export: it gets pasted into a report and nobody re-checks it.
 */
export function toCsv(items: readonly BatchMemberResult[], columns: readonly Column[], deviceLabel: (id: string) => { number: number | null; label: string }): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const header = ['#', 'device', 'status', ...columns.map((c) => c.label)].map(cell).join(',')
  const rows = items.map((item) => {
    const named = deviceLabel(item.deviceId)
    const name = named.number === null ? named.label : `#${named.number} ${named.label}`
    const values = columns.map((c) => (item.result === undefined ? (omissionText(item) ?? '') : renderCell(c.plan, (item.result as Record<string, unknown>)?.[c.key])))
    return [String((item.batchSeq ?? 0) + 1), name, item.status, ...values].map(cell).join(',')
  })
  return [header, ...rows].join('\n')
}

export function BatchResults({
  batchId,
  deviceLabel,
  onOpenMember,
}: {
  batchId: string
  deviceLabel: (deviceId: string) => { number: number | null; label: string }
  onOpenMember: (jobId: string) => void
}) {
  const [items, setItems] = useState<BatchMemberResult[] | null>(null)
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  const [omittedCount, setOmittedCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ResultFilter>('all')
  /**
   * Grouped by default, and that default is the whole argument of §3: on forty
   * near-identical devices the interesting fact is that thirty-seven agree and
   * three do not, and a flat table makes an operator find that by eye. The
   * per-member rows are one toggle away for when the question is about a
   * specific phone rather than about the batch.
   */
  const [grouped, setGrouped] = useState(true)

  const load = () => {
    setError(null)
    void api(`/api/batches/${batchId}/results`, BatchResultsResponseSchema)
      .then((body) => {
        setItems(body.items)
        setSchema((body.resultSchema ?? null) as JsonSchemaNode | null)
        setOmittedCount(body.omittedCount)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(load, [batchId])

  if (error) return <ErrorState message={error} onRetry={load} />
  if (!items) return <LoadingRows rows={4} />

  const columns = columnsOf(schema)
  const shown = items.filter((it) => matchesFilter(it, filter))
  const groups = groupByValues(shown, columns)
  const withoutValue = shown.filter((it) => it.result === undefined)

  const counts: Record<ResultFilter, number> = {
    all: items.length,
    ok: items.filter((it) => matchesFilter(it, 'ok')).length,
    failed: items.filter((it) => matchesFilter(it, 'failed')).length,
    'no-value': items.filter((it) => matchesFilter(it, 'no-value')).length,
  }

  const downloadCsv = () => {
    const blob = new Blob([toCsv(shown, columns, deviceLabel)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `batch-${batchId}-results.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-lg border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="rack-label">results</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            Only the filters that can match something. A chip reading "failed 0"
            invites a click that changes nothing, and on a healthy batch three of
            these four are always zero.
          */}
          {(['all', 'ok', 'failed', 'no-value'] as const)
            .filter((f) => f === 'all' || counts[f] > 0)
            .map((f) => (
              <Button
                key={f}
                variant={filter === f ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-[12px]"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                {f === 'all' ? 'All' : f === 'ok' ? 'Succeeded' : f === 'failed' ? 'Failed' : 'No value'} {counts[f]}
              </Button>
            ))}
          {columns.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => setGrouped((g) => !g)} aria-pressed={grouped}>
              {grouped ? 'Show every member' : 'Group identical'}
            </Button>
          )}
          {columns.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={downloadCsv}>
              CSV
            </Button>
          )}
        </div>
      </div>

      {omittedCount > 0 && (
        // Stated, never implied. A results view that quietly showed 37 of 40
        // members' values would be the exact failure this repo has paid for
        // before (plan 134): an unmeasured thing must never read as measured.
        <p className="mt-2 text-[11.5px] leading-relaxed text-led-warn">
          {omittedCount} {omittedCount === 1 ? 'result is' : 'results are'} not shown here — they did not fit the response. Open the member to read them.
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState title="No members" description="This batch has no member jobs, so there is nothing to compare." />
      ) : columns.length === 0 ? (
        <EmptyState
          title="This script declares no result fields"
          description="Nothing to lay out in columns. Each member's own return value is still readable from its row in the members table below."
        />
      ) : (
        <div className="mt-2 overflow-x-auto">
          {grouped ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Devices</TableHead>
                  {columns.map((c) => (
                    <TableHead key={c.key}>{c.label}</TableHead>
                  ))}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.key}>
                    <TableCell className="readout text-[12px] font-medium">{g.members.length}</TableCell>
                    {g.cells.map((cell, i) => (
                      <TableCell key={columns[i]?.key ?? i} className="readout max-w-[16rem] truncate text-[12px]" title={cell}>
                        {cell}
                      </TableCell>
                    ))}
                    <TableCell className="max-w-[18rem] truncate text-right text-[11.5px] text-fg-subtle" title={g.members.map((m) => deviceLabel(m.deviceId).label).join(', ')}>
                      {/* The devices themselves, named. A count alone would tell
                          an operator that three phones disagree and not which. */}
                      {g.members
                        .slice(0, 4)
                        .map((m) => {
                          const n = deviceLabel(m.deviceId)
                          return n.number === null ? n.label : `#${n.number}`
                        })
                        .join(', ')}
                      {g.members.length > 4 && ` +${g.members.length - 4}`}
                    </TableCell>
                  </TableRow>
                ))}
                {withoutValue.length > 0 && (
                  // Never folded into a group: "no value" is not an outcome
                  // several members share, it is the absence of one.
                  <TableRow>
                    <TableCell className="readout text-[12px] font-medium">{withoutValue.length}</TableCell>
                    <TableCell colSpan={columns.length} className="text-[12px] text-fg-subtle">
                      no value to compare — open each member
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Status</TableHead>
                {columns.map((c) => (
                  <TableHead key={c.key}>{c.label}</TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((item) => {
                const missing = omissionText(item)
                const named = deviceLabel(item.deviceId)
                return (
                  <TableRow key={item.jobId}>
                    <TableCell className="readout text-[11.5px] text-fg-subtle">{(item.batchSeq ?? 0) + 1}</TableCell>
                    <TableCell className="text-[12.5px]">
                      <DeviceName number={named.number} label={named.label} />
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={item.status} />
                    </TableCell>
                    {missing ? (
                      // One cell spanning every column: the reason is about the
                      // whole row, and repeating it per column would read as
                      // several separate failures.
                      <TableCell colSpan={columns.length} className="text-[12px] text-fg-subtle">
                        {missing}
                      </TableCell>
                    ) : (
                      columns.map((c) => (
                        <TableCell key={c.key} className="readout max-w-[16rem] truncate text-[12px]" title={renderCell(c.plan, (item.result as Record<string, unknown>)?.[c.key])}>
                          {renderCell(c.plan, (item.result as Record<string, unknown>)?.[c.key])}
                        </TableCell>
                      ))
                    )}
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => onOpenMember(item.jobId)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          )}
        </div>
      )}
    </div>
  )
}
