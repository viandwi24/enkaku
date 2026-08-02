'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DeviceInfo } from '@enkaku/protocol'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, useAction } from '@/lib/actions'
import { DEVICE_LABEL } from '@/components/StatusBadge'

export interface ScriptRow {
  id: string
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
  enabled: boolean
  createdBy?: string | null
  source?: string | null
  createdAt: number | null
}

/**
 * Running a script: pick a device, fill in the parameters, run.
 *
 * It is a dialog because this decision deserves full attention — the panel
 * used to sit below the list, where it was easy to miss.
 */
export function RunScriptDialog({
  script,
  devices,
  initialDevice,
  onClose,
}: {
  script: ScriptRow | null
  devices: DeviceInfo[]
  initialDevice?: string | null
  onClose: () => void
}) {
  const [deviceId, setDeviceId] = useState('')
  const [params, setParams] = useState<unknown>(undefined)
  const { run, isPending } = useAction()
  const router = useRouter()

  // Offline and quarantined devices cannot accept a job — never offer a
  // choice the server is certain to reject.
  const usable = devices.filter((d) => d.status !== 'offline' && d.status !== 'quarantined')

  useEffect(() => {
    if (!script) return
    setParams(undefined)
    setDeviceId(initialDevice && usable.some((d) => d.id === initialDevice) ? initialDevice : (usable[0]?.id ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, initialDevice, devices.length])

  if (!script) return null

  const runScript = () =>
    run(
      'run',
      () =>
        api<{ job: { jobId: string } }>('/api/jobs', {
          method: 'POST',
          json: { scriptId: script.id, deviceId, params: params ?? {} },
        }),
      {
        success: 'Job created',
        failure: 'Could not create the job',
        onSuccess: (b) => {
          onClose()
          router.push(`/jobs/detail?id=${b.job.jobId}`)
        },
      },
    )

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Run {script.name}
            <span className="readout ml-1.5 text-[12px] font-normal text-fg-muted">@{script.version}</span>
          </DialogTitle>
          <DialogDescription>The job joins the queue of the device you pick.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dev" className="text-[13px] font-normal">
              Device
            </Label>
            {usable.length === 0 ? (
              <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                No device is ready to accept a job. Connect one first.
              </p>
            ) : (
              <Select value={deviceId} onValueChange={setDeviceId}>
                <SelectTrigger id="dev">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {usable.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                      <span className="ml-2 text-[11px] text-fg-subtle">{DEVICE_LABEL[d.status]}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {script.paramsSchema ? (
            <SchemaForm schema={script.paramsSchema} value={params} onChange={setParams} />
          ) : (
            <p className="text-[12px] text-fg-muted">This script takes no parameters.</p>
          )}

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void runScript()} disabled={!deviceId || isPending('run')}>
              {isPending('run') ? 'Creating job…' : 'Run'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
