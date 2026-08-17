import { useCallback } from 'react'
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  relativeTime,
} from '@enkaku/ui'
import { RUNS_NOTE } from '../../shared'
import { FARM_API, JobsPageSchema, type JobRow } from './api'
import { StatusDot, useLoader } from './bits'

/**
 * Runs — every job the farm has run from a member of THIS pack.
 *
 * The third tab exists because a catalogue and a list of runs are genuinely
 * different shapes over genuinely different sources, which is the whole
 * argument for tabs rather than one long screen. It is also the tab that most
 * needs its honesty line: `check` reports `reachable: false` because nothing
 * was dialled, and a run history that showed a column of green ticks with no
 * explanation would read as a fleet of working proxies.
 *
 * **Filtered in the browser, and that is a real limit, stated rather than
 * hidden.** `GET /api/jobs` takes `deviceId`, `status` and `rootJobId` — there
 * is no `script` or `plugin` filter — so this reads one page of the farm's
 * jobs and keeps the ones whose `scriptName` starts with `proxy-manager/`. On
 * a busy farm this pack's runs can fall off the end of that page, so the
 * caption says what was actually searched instead of implying it is complete.
 */

const PAGE = 100

export function RunsTab() {
  const load = useCallback(async (): Promise<{ mine: JobRow[]; scanned: number }> => {
    const page = await api(`${FARM_API}/jobs?limit=${PAGE}`, JobsPageSchema)
    return { mine: page.items.filter((job) => (job.scriptName ?? '').startsWith('proxy-manager/')), scanned: page.items.length }
  }, [])
  const { data, error, loading, reload } = useLoader(load, [])

  if (loading) return <LoadingRows rows={3} />
  if (error) return <ErrorState message={error} onRetry={reload} />

  const mine = data?.mine ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <p className="max-w-prose grow text-[12px] leading-relaxed text-fg-muted">{RUNS_NOTE}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          Refresh
        </Button>
      </div>

      {mine.length === 0 ? (
        <EmptyState
          title="This pack has not been run here"
          description={`Nothing in the farm’s ${data?.scanned ?? 0} most recent jobs came from proxy-manager. Run “Check a proxy” from the Scripts page to see a row appear — it will report “not reachable”, because it dials nothing.`}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-44">Started</TableHead>
                  <TableHead className="w-44">Finished</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mine.map((job) => (
                  <TableRow key={job.jobId}>
                    <TableCell>
                      <div className="font-medium">{job.scriptName}</div>
                      <div className="readout text-[11px] text-fg-muted">{job.scriptVersion ?? '—'}</div>
                    </TableCell>
                    <TableCell className="text-[12px] text-fg-muted">
                      <StatusDot status={job.status} />
                    </TableCell>
                    <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(job.createdAt)}</TableCell>
                    <TableCell className="readout text-[11.5px] text-fg-muted">{relativeTime(job.finishedAt)}</TableCell>
                    <TableCell className="text-[12px] text-fg-muted">
                      {job.error ?? (job.status === 'success' ? 'Ran, dialled nothing, reported “not reachable”.' : '—')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="readout text-[11px] text-fg-muted">
            {mine.length} run{mine.length === 1 ? '' : 's'} found in the farm’s {data?.scanned ?? 0} most recent jobs. The jobs list cannot be filtered by plugin, so an
            older run is not shown here.
          </p>
        </>
      )}
    </div>
  )
}
