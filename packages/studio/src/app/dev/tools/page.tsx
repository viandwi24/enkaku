'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { JobCreateResponseSchema } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, useAction } from '@/lib/actions'

/**
 * Development aid — deliberately absent from the menu.
 *
 * This form submits a job as-is, including internal executors such as
 * `internal:sleep` used to exercise the queue. The ordinary Jobs screen only
 * shows genuinely published scripts, so nobody is faced with a field that
 * demands a memorised id.
 */
export default function DevToolsPage() {
  const [scriptId, setScriptId] = useState('internal:sleep')
  const [deviceId, setDeviceId] = useState('')
  const [params, setParams] = useState('{ "durationMs": 3000 }')
  const [paramError, setParamError] = useState<string | null>(null)
  const { run, isPending } = useAction()
  const router = useRouter()

  const submit = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(params)
    } catch (e) {
      setParamError(e instanceof Error ? e.message : 'Invalid JSON')
      return
    }
    setParamError(null)
    return run(
      'submit',
      () => api('/api/jobs', JobCreateResponseSchema, { method: 'POST', json: { scriptId, deviceId, params: parsed } }),
      {
        success: 'Raw job created',
        failure: 'Could not create the job',
        onSuccess: (b) => router.push(`/jobs/detail?id=${b.job.jobId}`),
      },
    )
  }

  return (
    <>
      <PageHeader
        title="Development tools"
        description="Submit a raw job without going through the script list — for exercising the queue and runner"
      />
      <div className="max-w-xl space-y-4 px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="script" className="text-[13px] font-normal">
            Script id or internal executor
          </Label>
          <Input id="script" className="readout" value={scriptId} onChange={(e) => setScriptId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dev" className="text-[13px] font-normal">
            Device id
          </Label>
          <Input
            id="dev"
            className="readout"
            placeholder="copy it from a device card"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="params" className="text-[13px] font-normal">
            Params (JSON)
          </Label>
          <Textarea
            id="params"
            rows={5}
            className="readout text-[12px]"
            value={params}
            onChange={(e) => setParams(e.target.value)}
            aria-invalid={Boolean(paramError)}
          />
          {paramError && <p className="text-[11.5px] text-led-danger">{paramError}</p>}
        </div>
        <Button disabled={!deviceId || isPending('submit')} onClick={() => void submit()}>
          {isPending('submit') ? 'Submitting…' : 'Submit job'}
        </Button>
      </div>
    </>
  )
}
