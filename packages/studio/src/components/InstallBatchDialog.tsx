'use client'

import { useState } from 'react'
import { BatchResponseSchema, type BatchOrder, type DeviceInfo } from '@enkaku/protocol'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { OutcomeSummary } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups } from '@/components/bulk/SkippedGroups'
import { batchOutcomeCounts, batchOutcomeGroups, useBatchReport } from '@/components/bulk/use-batch-report'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAction } from '@/lib/actions'
import { coreBase } from '@/lib/ws'

/**
 * Devices list → multi-select → "Install on selected" (plan 39 §4.5, §4.7;
 * plan 93 §3.11, §3.12, §4.8, F15, F17, step 93.11): ONE batch
 * (`internal:install`), never N parallel requests — the batch machinery
 * already gives concurrency, ordering, a per-device report, and cancel with
 * no new orchestration. Three changes from the pre-plan-93 version, all
 * from F15/F17: concurrency and order are now real controls (F17 —
 * previously always "all at once, as listed"); the artifact comes from
 * `ArtifactPicker` so a previously uploaded APK can be reused; and,
 * F15's own headline defect, the dialog no longer navigates away before a
 * result exists — it STAYS OPEN and renders the same `OutcomeSummary` +
 * `SkippedGroups` report every other bulk surface in this plan uses (H3).
 */
export function InstallBatchDialog({
  open,
  onOpenChange,
  devices,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  devices: DeviceInfo[]
}) {
  const deviceIds = devices.map((d) => d.id)
  const { run, isPending } = useAction()
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [batchId, setBatchId] = useState<string | null>(null)
  const report = useBatchReport(batchId)

  const deviceLabel = (id: string) => devices.find((d) => d.id === id)?.label ?? id

  function reset(): void {
    setSource(null)
    setBatchId(null)
  }

  async function submitBatch(): Promise<void> {
    if (!source) return
    await run(
      'install-batch',
      async () => {
        const artifactId = await uploadArtifactSource(source)
        const res = await fetch(`${coreBase()}/api/batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scriptId: 'internal:install',
            params: { artifactId },
            target: { deviceIds },
            concurrency,
            order,
          }),
        })
        const parsed = BatchResponseSchema.safeParse(await res.json().catch(() => null))
        if (!res.ok || !parsed.success) {
          throw new Error('Could not create the batch')
        }
        setBatchId(parsed.data.batch.id)
      },
      { failure: 'Install batch failed to start' },
    )
  }

  const counts = report.batch ? batchOutcomeCounts(report.batch) : null
  const groups = report.batch ? batchOutcomeGroups(report.batch, report.jobs, deviceLabel) : null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install on {deviceIds.length} device{deviceIds.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Uploads (or reuses) the APK once, then installs it across every selected device as one batch. Each
            device reports its own result — this dialog stays open to show it.
          </DialogDescription>
        </DialogHeader>

        {!batchId ? (
          <>
            <ArtifactPicker accept=".apk" value={source} onChange={setSource} disabled={isPending('install-batch')} />
            {deviceIds.length > 1 && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border bg-surface-2/40 p-3">
                <div className="space-y-1.5">
                  <Label className="text-[12.5px] font-normal">Concurrency</Label>
                  <Select value={String(concurrency)} onValueChange={(v) => setConcurrency(Number.parseInt(v, 10))}>
                    <SelectTrigger className="h-8 w-full text-[12.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">All at once</SelectItem>
                      <SelectItem value="1">One at a time</SelectItem>
                      <SelectItem value="2">2 at a time</SelectItem>
                      <SelectItem value="3">3 at a time</SelectItem>
                      <SelectItem value="5">5 at a time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[12.5px] font-normal">Order</Label>
                  <Select value={order} onValueChange={(v) => setOrder(v as BatchOrder)}>
                    <SelectTrigger className="h-8 w-full text-[12.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="as-listed">As listed</SelectItem>
                      <SelectItem value="random">Random</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-3">
            {counts && <OutcomeSummary counts={counts} label="Install progress" />}
            {groups && <SkippedGroups failed={groups.failed} skipped={groups.skipped} />}
            {!report.done && <p className="text-[11.5px] text-fg-subtle">Installing…</p>}
          </div>
        )}

        <DialogFooter>
          {!batchId ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submitBatch()} disabled={!source || isPending('install-batch')}>
                {isPending('install-batch') ? 'Starting…' : 'Install'}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
