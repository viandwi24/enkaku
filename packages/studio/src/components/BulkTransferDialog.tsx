'use client'

import { useEffect, useState } from 'react'
import { BatchResponseSchema, type BatchOrder, type DeviceInfo } from '@enkaku/protocol'
import { ArtifactPicker, uploadArtifactSource, type ArtifactSource } from '@/components/ArtifactPicker'
import { OutcomeSummary } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups } from '@/components/bulk/SkippedGroups'
import { batchOutcomeCounts, batchOutcomeGroups, useBatchReport } from '@/components/bulk/use-batch-report'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAction } from '@/lib/actions'
import { coreBase } from '@/lib/ws'

/**
 * Push and pull, over a selection (plan 93 §3.11, §3.13, §4.8, F15, step
 * 93.11) — one dialog, two modes, each posting a single batch
 * (`internal:push` / `internal:pull`, both step 93.9's, already registered
 * and gated identically to `internal:install`, §3.12). Same shape as
 * `InstallBatchDialog`, deliberately: concurrency/order controls, an
 * `ArtifactPicker` for push's source file, and it STAYS OPEN showing the
 * report instead of navigating away (F15, H3) — the whole point of this
 * plan's "no bulk surface invents a fourth style" rule (§3.15).
 */
export function BulkTransferDialog({
  mode,
  open,
  onOpenChange,
  devices,
}: {
  mode: 'push' | 'pull'
  open: boolean
  onOpenChange: (open: boolean) => void
  devices: DeviceInfo[]
}) {
  const deviceIds = devices.map((d) => d.id)
  const { run, isPending } = useAction()
  const [source, setSource] = useState<ArtifactSource | null>(null)
  const [remotePath, setRemotePath] = useState('')
  const [concurrency, setConcurrency] = useState(0)
  const [order, setOrder] = useState<BatchOrder>('as-listed')
  const [batchId, setBatchId] = useState<string | null>(null)
  const report = useBatchReport(batchId)

  const deviceLabel = (id: string) => devices.find((d) => d.id === id)?.label ?? id

  // A fresh mode swap (Push → Pull or back) starts clean rather than
  // carrying a stale artifact/path/report across — the two are unrelated
  // operations sharing one dialog shell, not one form with two states.
  useEffect(() => {
    setSource(null)
    setRemotePath('')
    setBatchId(null)
  }, [mode])

  function reset(): void {
    setSource(null)
    setRemotePath('')
    setBatchId(null)
  }

  const canSubmit = mode === 'push' ? source !== null && remotePath.trim().length > 0 : remotePath.trim().length > 0

  async function submitBatch(): Promise<void> {
    if (!canSubmit) return
    await run(
      'bulk-transfer',
      async () => {
        const params =
          mode === 'push' && source
            ? { artifactId: await uploadArtifactSource(source), remotePath: remotePath.trim() }
            : { remotePath: remotePath.trim() }
        const res = await fetch(`${coreBase()}/api/batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scriptId: mode === 'push' ? 'internal:push' : 'internal:pull',
            params,
            target: { deviceIds },
            concurrency,
            order,
          }),
        })
        const parsed = BatchResponseSchema.safeParse(await res.json().catch(() => null))
        if (!res.ok || !parsed.success) {
          throw new Error(`Could not create the ${mode} batch`)
        }
        setBatchId(parsed.data.batch.id)
      },
      { failure: `Bulk ${mode} failed to start` },
    )
  }

  const counts = report.batch ? batchOutcomeCounts(report.batch) : null
  const groups = report.batch ? batchOutcomeGroups(report.batch, report.jobs, deviceLabel) : null
  const title = mode === 'push' ? 'Push file to' : 'Pull file from'

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
          <DialogTitle>
            {title} {deviceIds.length} device{deviceIds.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'push'
              ? 'Uploads (or reuses) the file once, then writes it to the same path on every selected device as one batch.'
              : 'Reads the same path off every selected device into its own new artifact, as one batch.'}
            {' '}Each device reports its own result — this dialog stays open to show it.
          </DialogDescription>
        </DialogHeader>

        {!batchId ? (
          <div className="space-y-3">
            {mode === 'push' && (
              <ArtifactPicker value={source} onChange={setSource} disabled={isPending('bulk-transfer')} />
            )}
            <div className="space-y-1.5">
              <Label className="text-[12.5px] font-normal">Remote path</Label>
              <Input
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder={mode === 'push' ? '/sdcard/Download/file.bin' : '/sdcard/report.txt'}
                disabled={isPending('bulk-transfer')}
              />
            </div>
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
          </div>
        ) : (
          <div className="space-y-3">
            {counts && <OutcomeSummary counts={counts} label={`${mode === 'push' ? 'Push' : 'Pull'} progress`} />}
            {groups && <SkippedGroups failed={groups.failed} skipped={groups.skipped} />}
            {!report.done && <p className="text-[11.5px] text-fg-subtle">{mode === 'push' ? 'Pushing…' : 'Pulling…'}</p>}
          </div>
        )}

        <DialogFooter>
          {!batchId ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submitBatch()} disabled={!canSubmit || isPending('bulk-transfer')}>
                {isPending('bulk-transfer') ? 'Starting…' : mode === 'push' ? 'Push' : 'Pull'}
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
