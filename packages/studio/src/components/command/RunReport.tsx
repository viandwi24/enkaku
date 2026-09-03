'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CommandCounts, CommandMember, CommandOutput, CommandRunStatus } from '@enkaku/protocol'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Progress,
  cn,
  duration,
} from '@enkaku/ui'
import { groupMembers, type OutcomeGroup } from './run-grouping'

/**
 * Plan 93 §3.15, §4.4, step 93.7 — the fan-out report. Four properties this
 * step's own brief names as non-negotiable, each traced to a line below:
 *
 * 1. A run's result is per-device, always — every member is reachable by
 *    name from a group, never only a count (`renderGroup`'s device chips).
 * 2. The acknowledgement is a scale confirmation, not a safety net — this
 *    component does not re-litigate it; `ConfirmFanout` owns that entirely.
 * 3. Staged rollout waits without holding control activities — the `awaiting-continue`
 *    banner says so explicitly, in the operator's own words.
 * 4. Output is subscriber-scoped — this component never assumes it is
 *    watching; the console page owns subscribe/unsubscribe, this only
 *    renders whatever state it is handed.
 *
 * Bounded DOM (§3.15): a collapsed group renders ONE row regardless of how
 * many members it holds — a 100-device run never renders 100 rows unless
 * every group is individually expanded — and an expanded group caps at 200
 * rendered members with a "+N more" note rather than true virtualisation
 * (not worth a dependency for a bound this generous).
 */

const MAX_EXPANDED_ROWS = 200
const CHIP_PREVIEW = 8

export interface RunReportRun {
  id: string
  cmd: string
  status: CommandRunStatus
  stage: number
  stageFirstN: number
  counts: CommandCounts
  startedAt: number
  finishedAt: number | null
}

export function RunReport({
  run,
  members,
  outputs,
  deviceLabel,
  onCancel,
  onContinue,
  onRetryFailed,
  onRetrySkipped,
  fetchFullOutput,
  busy,
}: {
  run: RunReportRun
  members: CommandMember[]
  outputs: CommandOutput[]
  /**
   * Resolves a device id to its FULLY COMPOSED name — `#7 Galaxy A15`, the
   * number already in the string.
   *
   * Plan 124 §4.4, step 124.4 — this prop is deliberately not widened into
   * `{ number, label }` (§4.4's own rule for the `deviceLabel: string`
   * shaped props: "their callers pass `formatDeviceName(...)`"). Both callers
   * — `app/console/page.tsx` and `device-popup/AdbCommandDialog.tsx` — hold
   * the `DeviceInfo[]` and compose in their own lookup, so the number reaches
   * all three render sites below (the collapsed group's `.join(', ')`
   * preview, each `MemberRow`, and the output drawer's title) through one
   * definition instead of three.
   *
   * The consequence for anyone editing this file: **never wrap the result in
   * `formatDeviceName` again here** — it is already composed, and doing so
   * would render `#7 #7 Galaxy A15`.
   */
  deviceLabel: (deviceId: string) => string
  onCancel: () => void
  onContinue: () => void
  onRetryFailed: () => void
  onRetrySkipped: () => void
  fetchFullOutput: (deviceId: string, stream: 'stdout' | 'stderr') => Promise<string>
  /** A named action currently in flight ('cancel' | 'continue' | 'retry-failed' | 'retry-skipped'), or null. */
  busy: string | null
}) {
  const [drawer, setDrawer] = useState<{ deviceId: string } | null>(null)
  const groups = groupMembers(members)
  const { counts } = run
  const settled = counts.ok + counts.failed + counts.skipped + counts.cancelled
  const percent = counts.total > 0 ? Math.round((settled / counts.total) * 100) : 0
  // 'awaiting-continue' gets its OWN Stop button, right beside Continue in
  // the banner below — the header's Stop is only for the plain 'running'
  // case, so there is never a redundant second Stop button on screen.
  const isActive = run.status === 'running'
  const outputByHash = new Map(outputs.map((o) => [o.hash, o]))

  return (
    <div className="space-y-3 rounded-lg border bg-surface p-3.5" data-testid="run-report">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <code className="readout min-w-0 flex-1 truncate text-[12.5px]">{run.cmd}</code>
          {isActive ? (
            <Button size="sm" variant="outline" disabled={busy === 'cancel'} onClick={onCancel}>
              {busy === 'cancel' ? 'Stopping…' : 'Stop'}
            </Button>
          ) : run.status !== 'awaiting-continue' ? (
            <Badge variant="outline">{duration(run.startedAt, run.finishedAt)}</Badge>
          ) : null}
        </div>
        <Progress value={percent} aria-label="Run progress" />
        <p className="text-[11.5px] text-fg-muted">
          {counts.ok} ok · {counts.failed} failed · {counts.skipped} skipped
          {counts.cancelled > 0 && <> · {counts.cancelled} cancelled</>}
          {counts.running > 0 && <> · {counts.running} running</>}
          {counts.pending > 0 && <> · {counts.pending} pending</>}
          {' '}
          ({settled}/{counts.total})
        </p>
      </div>

      {run.status === 'awaiting-continue' && (
        <div className="space-y-2 rounded-md border border-led-warn/40 bg-led-warn/5 px-3 py-2.5 text-[12.5px]">
          <p className="font-medium text-led-warn">
            Stage {run.stage} of 2 complete — waiting on Continue.
          </p>
          <p className="text-fg-muted">
            No device is held while this waits. Review the results below, then continue on the rest or stop here.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy === 'continue'} onClick={onContinue}>
              {busy === 'continue' ? 'Continuing…' : 'Continue'}
            </Button>
            <Button size="sm" variant="outline" disabled={busy === 'cancel'} onClick={onCancel}>
              Stop
            </Button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={counts.failed === 0 || busy === 'retry-failed'} onClick={onRetryFailed}>
          {busy === 'retry-failed' ? 'Retrying…' : `Retry failed (${counts.failed})`}
        </Button>
        <Button size="sm" variant="outline" disabled={counts.skipped === 0 || busy === 'retry-skipped'} onClick={onRetrySkipped}>
          {busy === 'retry-skipped' ? 'Retrying…' : `Retry skipped (${counts.skipped})`}
        </Button>
      </div>

      <ul className="space-y-1.5">
        {groups.map((g) => (
          <GroupRow
            key={g.key}
            group={g}
            deviceLabel={deviceLabel}
            output={g.members[0]?.outputHash ? outputByHash.get(g.members[0].outputHash) : undefined}
            onOpenOutput={(deviceId) => setDrawer({ deviceId })}
          />
        ))}
      </ul>

      {drawer && (
        <OutputDrawer
          deviceId={drawer.deviceId}
          label={deviceLabel(drawer.deviceId)}
          fetchFullOutput={fetchFullOutput}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  )
}

const KIND_TONE: Record<OutcomeGroup['kind'], string> = {
  failed: 'text-led-danger',
  skipped: 'text-led-warn',
  cancelled: 'text-fg-subtle',
  running: 'text-led-active',
  pending: 'text-fg-subtle',
  ok: 'text-led-ok',
}

function GroupRow({
  group,
  deviceLabel,
  output,
  onOpenOutput,
}: {
  group: OutcomeGroup
  /** Already composed with the device's number — see `RunReport`'s own prop doc. */
  deviceLabel: (deviceId: string) => string
  output: CommandOutput | undefined
  onOpenOutput: (deviceId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const preview = group.members.slice(0, CHIP_PREVIEW)
  const overflow = group.members.length - preview.length

  return (
    <li className="rounded-md border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-surface-2/60">
            {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn('text-[12.5px] font-medium', KIND_TONE[group.kind])}>{group.title}</span>
                <Badge variant="outline">{group.members.length} device{group.members.length === 1 ? '' : 's'}</Badge>
              </div>
              {!open && (
                <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
                  {preview.map((m) => deviceLabel(m.deviceId)).join(', ')}
                  {overflow > 0 && ` +${overflow} more`}
                </p>
              )}
              {output && output.stdoutPreview && (
                <p className="readout mt-0.5 truncate text-[11px] text-fg-subtle">&quot;{output.stdoutPreview}&quot;</p>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="space-y-1 border-t px-2.5 py-2">
            {group.members.slice(0, MAX_EXPANDED_ROWS).map((m) => (
              <MemberRow key={m.deviceId} member={m} label={deviceLabel(m.deviceId)} onOpenOutput={() => onOpenOutput(m.deviceId)} />
            ))}
            {group.members.length > MAX_EXPANDED_ROWS && (
              <li className="text-[11px] text-fg-subtle">
                showing the first {MAX_EXPANDED_ROWS} of {group.members.length}
              </li>
            )}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function MemberRow({ member, label, onOpenOutput }: { member: CommandMember; label: string; onOpenOutput: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px]">
      <span className="min-w-0 truncate font-medium">{label}</span>
      {member.exitCode !== null && <span className="text-fg-subtle">exit {member.exitCode}</span>}
      {member.durationMs !== null && <span className="text-fg-subtle">{member.durationMs} ms</span>}
      {member.truncated && <span className="text-led-warn">truncated</span>}
      {member.outputHash && (
        <button type="button" className="text-accent underline" onClick={onOpenOutput}>
          output
        </button>
      )}
      <Link href={`/device?id=${encodeURIComponent(member.deviceId)}&tab=terminal`} className="text-accent underline">
        terminal
      </Link>
      {member.truncated && (
        <Link href={`/device?id=${encodeURIComponent(member.deviceId)}&tab=monitor`} className="text-accent underline">
          open in Monitor
        </Link>
      )}
    </li>
  )
}

function OutputDrawer({
  deviceId,
  label,
  fetchFullOutput,
  onClose,
}: {
  deviceId: string
  label: string
  fetchFullOutput: (deviceId: string, stream: 'stdout' | 'stderr') => Promise<string>
  onClose: () => void
}) {
  const [stdout, setStdout] = useState<string | null>(null)
  const [stderr, setStderr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchFullOutput(deviceId, 'stdout').then((text) => !cancelled && setStdout(text))
    void fetchFullOutput(deviceId, 'stderr').then((text) => !cancelled && setStderr(text))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{label} — full output</DialogTitle>
        </DialogHeader>
        <div className="max-h-[28rem] space-y-3 overflow-y-auto">
          <div>
            <p className="rack-label text-fg-subtle">stdout</p>
            <pre className="readout mt-1 whitespace-pre-wrap break-all rounded-md bg-surface-2 p-2 text-[11.5px]">
              {stdout === null ? 'loading…' : stdout || '(empty)'}
            </pre>
          </div>
          {stderr && (
            <div>
              <p className="rack-label text-fg-subtle">stderr</p>
              <pre className="readout mt-1 whitespace-pre-wrap break-all rounded-md bg-led-warn/5 p-2 text-[11.5px] text-led-warn">{stderr}</pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
