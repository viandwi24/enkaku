'use client'

import { useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAction } from '@/lib/actions'
import { coreBase } from '@/lib/ws'

/**
 * Devices list → multi-select → "Install on selected" (plan 39 §4.5, §4.7):
 * ONE batch (`internal:install`, registered beside `internal:sleep`), never
 * N parallel requests — the batch machinery already gives concurrency,
 * ordering, a per-device report, and cancel with no new orchestration.
 */
export function InstallBatchDialog({
  open,
  onOpenChange,
  deviceIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceIds: string[]
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { run, isPending } = useAction()
  const router = useRouter()

  async function submit(): Promise<void> {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    await run(
      'install-batch',
      async () => {
        const form = new FormData()
        form.set('file', file)
        form.set('label', file.name)
        const uploadRes = await fetch(`${coreBase()}/api/artifacts`, { method: 'POST', body: form })
        const uploadBody = (await uploadRes.json().catch(() => null)) as
          | { artifact?: { id: string }; error?: { message?: string } }
          | null
        if (!uploadRes.ok || !uploadBody?.artifact) {
          throw new Error(uploadBody?.error?.message ?? `Upload failed (HTTP ${uploadRes.status})`)
        }
        const batchRes = await fetch(`${coreBase()}/api/batches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scriptId: 'internal:install',
            params: { artifactId: uploadBody.artifact.id },
            target: { deviceIds },
          }),
        })
        const batchBody = (await batchRes.json().catch(() => null)) as { batch?: { id: string }; error?: { message?: string } } | null
        if (!batchRes.ok || !batchBody?.batch) {
          throw new Error(batchBody?.error?.message ?? `Could not create the batch (HTTP ${batchRes.status})`)
        }
        onOpenChange(false)
        router.push(`/batches/detail?id=${batchBody.batch.id}`)
      },
      { failure: 'Install batch failed to start' },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install on {deviceIds.length} device{deviceIds.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Uploads the APK once, then installs it across every selected device as one batch. Each device reports its
            own result.
          </DialogDescription>
        </DialogHeader>
        <input ref={fileRef} type="file" accept=".apk" className="block w-full text-[12.5px]" />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={isPending('install-batch')}>
            {isPending('install-batch') ? 'Starting…' : 'Install'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
