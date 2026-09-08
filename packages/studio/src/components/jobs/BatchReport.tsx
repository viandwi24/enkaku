'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import type { BatchInfo, JobInfo, JobStatus } from '@enkaku/protocol'
import { DeviceName, WarningIcon, cn, fileSize } from '@enkaku/ui'
import { useNow } from '@/lib/useNow'
import { STATE_DOT, STATE_WORD, clockTime, jobHref } from './job-view'
import { buildBatchReport, percentLabel, secondsLabel } from './batch-report'

/**
 * The Batches tab's Report view — the screen an operator lands on after a
 * batch of forty devices, and the one a client is shown afterwards.
 *
 * The Members table answers "which device"; this answers everything asked
 * before that: did it work (a rate, not six raw counts), did it work FIRST
 * TIME (the rate that separates a flaky script from a broken one), how long
 * did a device take and how long did it wait, how many ways did it fail and
 * how many devices per way, and under what dispatch settings — because
 * "concurrency 4, paced 30s" is half of every "why was this so slow".
 *
 * Everything here is computed from the batch and its members, which the
 * detail already holds: opening the report costs no request.
 */

/** The one place a member status becomes a colour bar segment. */
const BAR_TONE: Record<JobStatus, string> = {
  success: 'bg-ok',
  failed: 'bg-danger',
  cancelled: 'bg-warn',
  expired: 'bg-warn-2',
  running: 'bg-accent',
  queued: 'bg-muted-2',
}

const BAR_ORDER: readonly JobStatus[] = ['success', 'failed', 'cancelled', 'expired', 'running', 'queued']

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-inner border border-line-2 bg-panel-2 px-3 py-[10px]">
      <div className="text-label text-faint">{label}</div>
      <div className={cn('mt-[3px] text-[17px] font-semibold tabular-nums', tone ?? 'text-text')}>{value}</div>
      {hint && <div className="mt-[2px] text-tip text-faint-2">{hint}</div>}
    </div>
  )
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-3 rounded-inner border border-line-2">
      <header className="flex items-center justify-between gap-3 border-b border-line-2 px-3 py-2">
        <span className="text-[12px] font-semibold">{title}</span>
        {aside && <span className="text-meta text-faint">{aside}</span>}
      </header>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-3 py-[7px]">
      <span className="w-[124px] flex-none text-meta text-faint">{label}</span>
      <span className="min-w-0 flex-1 text-body text-text-3">{children}</span>
    </div>
  )
}

export type DeviceNameMap = Map<string, { number: number | null; label: string }>

function deviceCell(deviceId: string, names: DeviceNameMap): ReactNode {
  const name = names.get(deviceId)
  return name ? <DeviceName number={name.number} label={name.label} /> : <span className="font-mono text-[12px]">{deviceId.slice(0, 12)}</span>
}

export function BatchReport({ batch, jobs, deviceNames }: { batch: BatchInfo; jobs: JobInfo[]; deviceNames: DeviceNameMap }) {
  const now = useNow()
  const r = buildBatchReport(batch, jobs, now)
  const inFlight = r.byStatus.running + r.byStatus.queued

  const pacing = batch.pacing
  const pacingWords = pacing
    ? [
        pacing.repeatCount > 1 ? `${pacing.repeatCount}× per device` : null,
        pacing.intervalMaxMs > 0
          ? `interval ${Math.round(pacing.intervalMinMs / 1000)}–${Math.round(pacing.intervalMaxMs / 1000)}s`
          : null,
        pacing.deviceIntervalMs > 0 ? `device stagger ${Math.round(pacing.deviceIntervalMs / 1000)}s` : null,
        pacing.deviceDelayMs[1] > 0
          ? `start delay ${Math.round(pacing.deviceDelayMs[0] / 1000)}–${Math.round(pacing.deviceDelayMs[1] / 1000)}s`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null

  return (
    <div className="p-[14px]">
      {/* The headline: one rate, one bar, one legend. A batch is judged on
          whether it worked, and six numbers in a row do not say that. */}
      <section className="rounded-inner border border-line-2 bg-panel-2 px-3 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-label text-faint">Success rate</div>
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  'text-[28px] font-semibold tabular-nums',
                  r.successRate === null ? 'text-faint' : r.successRate === 1 ? 'text-ok' : r.successRate < 0.5 ? 'text-danger' : 'text-warn',
                )}
              >
                {percentLabel(r.successRate)}
              </span>
              <span className="text-meta text-faint">
                {r.byStatus.success}/{r.settled} settled
                {inFlight > 0 ? ` · ${inFlight} still to finish` : ''}
              </span>
            </div>
          </div>
          <div className="text-right text-meta text-faint">
            <div>
              {r.total} member{r.total === 1 ? '' : 's'} · {secondsLabel(r.wallSec)} wall clock
            </div>
            <div>
              {clockTime(batch.createdAt)}
              {batch.finishedAt ? ` → ${clockTime(batch.finishedAt)}` : ' → running'}
            </div>
          </div>
        </div>

        <div className="mt-3 flex h-[10px] w-full overflow-hidden rounded-pill bg-muted">
          {BAR_ORDER.map((s) =>
            r.byStatus[s] > 0 ? (
              <div
                key={s}
                className={BAR_TONE[s]}
                style={{ width: `${(r.byStatus[s] / Math.max(1, r.total)) * 100}%` }}
                title={`${STATE_WORD[s]}: ${r.byStatus[s]}`}
              />
            ) : null,
          )}
        </div>
        <div className="mt-[10px] flex flex-wrap items-center gap-x-4 gap-y-1">
          {BAR_ORDER.filter((s) => r.byStatus[s] > 0).map((s) => (
            <span key={s} className="flex items-center gap-[6px] text-meta text-dim">
              <span className={cn('size-[7px] flex-none rounded-pill', STATE_DOT[s])} aria-hidden />
              {STATE_WORD[s]} <span className="tabular-nums text-faint">{r.byStatus[s]}</span>
            </span>
          ))}
        </div>
      </section>

      <div className="mt-3 grid gap-[10px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }}>
        {/* First-pass is the number that separates "the script is wrong" from
            "the farm was flaky": a batch can reach 100 % success and still
            have needed nineteen extra attempts to get there. */}
        <Tile
          label="First-pass"
          value={percentLabel(r.firstPassRate)}
          hint={`${r.firstPass} succeeded on attempt 1`}
          tone={r.firstPassRate !== null && r.firstPassRate < 1 ? 'text-warn' : undefined}
        />
        <Tile
          label="Attempts"
          value={r.attemptsPerMember === null ? '—' : `×${r.attemptsPerMember.toFixed(2).replace(/\.00$/, '')}`}
          hint={`${r.attempts} runs · ${r.retried} member${r.retried === 1 ? '' : 's'} re-run${r.maxAttempts > 1 ? ` · max ×${r.maxAttempts}` : ''}`}
          tone={r.retried > 0 ? 'text-warn' : undefined}
        />
        <Tile label="Median run" value={secondsLabel(r.runtime.medianSec)} hint={`p95 ${secondsLabel(r.runtime.p95Sec)}`} />
        <Tile
          label="Fastest / slowest"
          value={`${secondsLabel(r.runtime.minSec)} / ${secondsLabel(r.runtime.maxSec)}`}
          hint={`${r.runtime.count} finished run${r.runtime.count === 1 ? '' : 's'}`}
        />
        <Tile label="Queue wait" value={secondsLabel(r.wait.medianSec)} hint={`longest ${secondsLabel(r.wait.maxSec)}`} />
        <Tile
          label="Throughput"
          value={r.throughputPerMin === null ? '—' : `${r.throughputPerMin.toFixed(1)}/min`}
          hint={r.throughputPerMin === null ? 'too short to measure' : 'settled members per minute'}
        />
        <Tile label="Peak memory" value={fileSize(r.peakRssBytes)} hint="highest RSS any member reached" />
      </div>

      {r.failures.length > 0 && (
        <Card
          title="Failures"
          aside={`${r.byStatus.failed} member${r.byStatus.failed === 1 ? '' : 's'} · ${r.failures.length} distinct`}
        >
          {/* Grouped, because twenty rows of the same sentence is one bug, and
              a list that repeats it twenty times hides the second bug. */}
          {r.failures.map((g) => (
            <div key={g.key} className="border-b border-muted-2 px-3 py-[9px] last:border-b-0">
              <div className="flex items-baseline gap-2">
                <span className="flex-none rounded-small bg-danger-soft px-[7px] py-[2px] text-label font-semibold text-danger tabular-nums">
                  ×{g.count}
                </span>
                <span className="min-w-0 flex-1 font-mono text-meta text-text-3" style={{ overflowWrap: 'anywhere' }}>
                  {g.message.split('\n')[0]}
                </span>
              </div>
              <div className="mt-[5px] flex flex-wrap items-center gap-x-2 gap-y-1 text-tip text-faint">
                {(g.failureClass || g.errorPhase) && (
                  <span className="flex-none">
                    {g.failureClass ?? 'failure'}
                    {g.errorPhase ? ` · during ${g.errorPhase}` : ''}
                  </span>
                )}
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {g.deviceIds.slice(0, 6).map((id) => (
                    <span key={id} className="flex-none text-dim">
                      {deviceCell(id, deviceNames)}
                    </span>
                  ))}
                  {g.deviceIds.length > 6 && <span className="flex-none">+{g.deviceIds.length - 6} more</span>}
                </span>
              </div>
            </div>
          ))}
        </Card>
      )}

      {r.slowest.length > 0 && (
        <Card title="Slowest members" aside="open one to read its timeline">
          {r.slowest.map((m) => (
            <Link
              key={m.jobId}
              href={jobHref(m.jobId)}
              className="flex items-center justify-between gap-3 border-b border-muted-2 px-3 py-[9px] transition-colors last:border-b-0 hover:bg-muted"
            >
              <span className="min-w-0 truncate text-row text-text">{deviceCell(m.deviceId, deviceNames)}</span>
              <span className="flex-none text-body text-dim tabular-nums">{secondsLabel(m.seconds)}</span>
            </Link>
          ))}
        </Card>
      )}

      <Card title="Runner and dispatch" aside={batch.id.slice(0, 12)}>
        <Field label="Script">
          {batch.scriptName ?? batch.scriptId}
          {batch.scriptVersion ? <span className="text-faint"> @{batch.scriptVersion}</span> : null}
        </Field>
        <Field label="Concurrency">
          {batch.concurrency === 0 ? 'unlimited' : `${batch.concurrency} at a time`} · order {batch.order}
        </Field>
        <Field label="Pacing">{pacingWords && pacingWords.length > 0 ? pacingWords : 'none — every member dispatched at once'}</Field>
        {batch.repeats.length > 0 && (
          <Field label="Repetitions">
            {batch.repeats.reduce((s, x) => s + x.completed, 0)}/{batch.repeats.reduce((s, x) => s + x.planned, 0)} across{' '}
            {batch.repeats.length} device{batch.repeats.length === 1 ? '' : 's'}
          </Field>
        )}
        <Field label="Verdicts">
          {Object.keys(r.resultStatus).length === 0
            ? 'no member reported a validated result yet'
            : Object.entries(r.resultStatus)
                .map(([k, v]) => `${v} ${k}`)
                .join(' · ')}
        </Field>
        <Field label="Dispatched by">{batch.createdBy ?? 'the farm'}</Field>
      </Card>

      {batch.skipped.length > 0 && (
        <Card title="Skipped devices" aside={`${batch.skipped.length} never got a job`}>
          {/* A device in the target that got no job row is not a failure and
              not a success — it is the third outcome, and leaving it out of
              the report is how a batch of forty reads as a batch of thirty-six. */}
          {batch.skipped.map((s) => (
            <div key={s.deviceId} className="flex items-baseline gap-2 border-b border-muted-2 px-3 py-[7px] last:border-b-0">
              <WarningIcon className="size-[13px] flex-none translate-y-[2px] text-warn" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body text-text-3">{deviceCell(s.deviceId, deviceNames)}</span>
              <span className="flex-none text-meta text-faint">{s.reason}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
