'use client'

import { useState } from 'react'
import { CrashesPanel } from '@/components/CrashesPanel'
import { DeviceLog } from '@/components/DeviceLog'
import { FilesPanel } from '@/components/FilesPanel'
import { JobsList } from '@/components/JobsList'
import { MonitorPane } from '@/components/monitor/MonitorPane'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ws } from '@/lib/ws'
import { JobDetailPanel } from './JobDetailPanel'

/**
 * The device popup's read popups (plan 103 §3.3, §5 step 103.4) — Jobs,
 * Files, Crashes, Logs. §3.3's own question sorts them here rather than into
 * the Actions tab or a side panel: "you read these, nothing needs touching
 * on the phone meanwhile." Both are ALWAYS non-modal (103.1's path) — unlike
 * the six action dialogs in `ActionsList.tsx`, these have no other calling
 * context that would ever want them modal, so `nonModal` is not a prop here,
 * it is simply how each one opens.
 *
 * **Two popups, not four — a deliberate reading of a conflict in the plan
 * itself, flagged rather than silently resolved.** Plan 103 §4.2's own
 * fixed twelve-row list has exactly ONE row for this whole category
 * ("Jobs" — "Files" is its own separate row), and its own rule is that
 * growing the list past what fits must DISPLACE a row, never append one;
 * this pass's own brief names exactly four rows as still disabled today
 * (`Adb command`, `Files`, `Jobs`, `Settings` — verified against
 * `ActionsList.test.tsx`'s own list) and asks that those four become real,
 * not that new rows be added. There is nowhere in the fixed list for
 * "Crashes" or "Logs" to become a thirteenth and fourteenth row without
 * either violating "displace, don't append" or picking (unilaterally) which
 * existing row to displace — neither of which this pass will do silently.
 * So `JobsPopup` below is a small sectioned popup of its own (Jobs · Crashes
 * · Logs, tabs — the same "one popup, several reads" shape 103.6's Settings
 * popup already uses for a harder version of the identical problem),
 * reached through the ONE existing "Jobs" row. `FilesPopup` stays its own
 * popup, reached through the existing "Files" row. This is a judgement call
 * this pass made to keep the list compact rather than an owner ruling —
 * flagged in this plan's own status line.
 *
 * **A fourth tab, Monitor (plan 103 §5, closing step 103.11's audit row 5,
 * 2026-08-17).** `MonitorPane` (live logcat/top/thermal/crash/ps/meminfo/df,
 * with save-to-file) applies §3.3's own test the same way Crashes/Logs
 * already do here: you READ it, nothing needs touching on the phone
 * meanwhile (§3.3: *"Monitor mostly does not [need to be open while you are
 * touching the phone] — you read logcat"*), so it is one more tab in this
 * SAME small sectioned popup rather than a thirteenth `ActionsList` row —
 * the identical "displace, don't append" reasoning that put Crashes and Logs
 * here in the first place, extended to a third read surface rather than
 * re-derived from scratch. Reused UNCHANGED — `MonitorPane` is already
 * self-contained (`deviceId` is its only prop; it has no server-side
 * authorization of its own to gate here, unlike Files/Settings) — mounted
 * only while its own tab is active, the same on-demand treatment
 * `app/device/page.tsx` itself already gives Monitor (its own comment: "a
 * device-side `logcat` stream... keeping it alive for a tab nobody is
 * looking at would leave a process running on a real phone").
 *
 * **A job row now drills into a real detail (2026-08-16, plan 103 §9 Q2
 * answered, closing step 103.11's audit row 4).** Clicking a job's script
 * name in the Jobs tab swaps the whole Jobs·Crashes·Logs tab strip for
 * `JobDetailPanel` — the SAME result view (with its `invalid`/`partial`/
 * `oversize` banners), params, logs, and artifacts `/jobs/detail` renders,
 * through the SAME data hook (`lib/use-job-detail.ts`) and the SAME
 * presentational pieces (`components/jobs/`), not a thinner copy of either.
 * "Back to jobs" returns to the list without ever touching `next/link` — the
 * Wall this popup floats over never unmounts.
 */

const DIALOG_WIDTH = 'sm:max-w-3xl'

export function JobsPopup({
  deviceId,
  deviceLabel,
  deviceOffline,
  open,
  onOpenChange,
}: {
  deviceId: string
  deviceLabel: string
  deviceOffline: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tab, setTab] = useState('jobs')
  // Plan 103 §9 Q2, answered 2026-08-16, closing step 103.11's audit row 4
  // ("the Jobs popup lists jobs and stops there — no job detail, no logs").
  // A job id here means "showing that job's detail IN PLACE"
  // (`JobDetailPanel`) instead of the Jobs·Crashes·Logs tabs; `null` means
  // the list. Reset whenever the whole popup closes, so reopening always
  // starts back at the list rather than wherever it was left.
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  function handleOpenChange(o: boolean): void {
    onOpenChange(o)
    if (!o) setSelectedJobId(null)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
      <DialogContent overlay={false} className={DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Jobs — {deviceLabel}</DialogTitle>
        </DialogHeader>
        {selectedJobId ? (
          <JobDetailPanel jobId={selectedJobId} onBack={() => setSelectedJobId(null)} />
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="jobs">Jobs</TabsTrigger>
              <TabsTrigger value="crashes">Crashes</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
              <TabsTrigger value="monitor">Monitor</TabsTrigger>
            </TabsList>
            <TabsContent value="jobs">
              {/*
               * §9 Q2 of plan 103, answered 2026-08-16: a job's detail
               * renders IN PLACE, with a back affordance
               * (`JobDetailPanel`, above) — never a link to `/jobs/detail`,
               * which is a different route and would unmount the Wall this
               * popup floats over (plan 103 §3.2). `linkToDetail={false}`
               * stops `JobsList`'s own `next/link`; `onOpenDetail` is what
               * makes the row a real control again instead of the merely
               * inert span it rendered as before this pass.
               */}
              <JobsList
                filter={{ deviceId }}
                columns={{ script: true, time: 'started', actions: true }}
                linkToDetail={false}
                onOpenDetail={setSelectedJobId}
                empty={{
                  title: 'No jobs on this device',
                  description: 'Run a script against it from the Actions tab, or from the Scripts page.',
                }}
              />
            </TabsContent>
            <TabsContent value="crashes">
              <CrashesPanel deviceId={deviceId} />
            </TabsContent>
            <TabsContent value="logs">
              <DeviceLog deviceId={deviceId} deviceOffline={deviceOffline} />
            </TabsContent>
            <TabsContent value="monitor">
              <MonitorPane deviceId={deviceId} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function FilesPopup({
  deviceId,
  canUse,
  open,
  onOpenChange,
}: {
  deviceId: string
  /** `iHoldControl && !busy` — the same server-authoritative gate the device page's own Files tab uses; a convenience only, the server checks the lease itself on every request. */
  canUse: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent overlay={false} className={DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Files</DialogTitle>
        </DialogHeader>
        <FilesPanel deviceId={deviceId} clientId={ws.getSessionId()} canUse={canUse} />
      </DialogContent>
    </Dialog>
  )
}
