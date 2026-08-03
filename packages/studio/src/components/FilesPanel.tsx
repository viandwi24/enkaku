'use client'

import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { InstallResult } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { api, useAction } from '@/lib/actions'
import { coreBase, ws } from '@/lib/ws'
import { fileSize } from '@/lib/format'

/**
 * The device page's Files tab (plan 39 §4.7): install an APK in one flow
 * (upload → install, with progress), push a file to a path, and pull a file
 * back into a new artifact. Every action here goes through the SAME two-step
 * shape the plan requires: `POST /api/artifacts` (a multipart upload, which
 * hands back an artifact id) THEN `POST /api/devices/:id/install|push` with
 * that id — the client never sends a path or URL as "the source" (§3.5,
 * acceptance #8). Progress is driven by `transfer.progress`/`transfer.done`
 * (plan §4.4), so a second viewer of this device sees the same bar.
 */

interface TransferProgress {
  transferId: string | null
  sent: number
  total: number | null
}

const EMPTY_PROGRESS: TransferProgress = { transferId: null, sent: 0, total: null }

/** A raw multipart upload — the `api()` helper is JSON-only, and a browser must set its own multipart boundary, not a fixed content-type. */
async function uploadArtifact(file: File, label: string): Promise<{ id: string }> {
  const form = new FormData()
  form.set('file', file)
  form.set('label', label)
  const res = await fetch(`${coreBase()}/api/artifacts`, { method: 'POST', body: form })
  const body = (await res.json().catch(() => null)) as { artifact?: { id: string }; error?: { message?: string } } | null
  if (!res.ok || !body?.artifact) {
    throw new Error(body?.error?.message ?? `Upload failed (HTTP ${res.status})`)
  }
  return { id: body.artifact.id }
}

function ProgressBar({ progress, label }: { progress: TransferProgress; label: string }) {
  if (progress.transferId === null) return null
  const pct = progress.total ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : null
  return (
    <div className="mt-2 space-y-1">
      <Progress value={pct ?? undefined} />
      <p className="text-[11.5px] text-fg-subtle">
        {label} — {fileSize(progress.sent)}
        {progress.total ? ` / ${fileSize(progress.total)}` : ''}
        {pct !== null ? ` (${pct}%)` : ''}
      </p>
    </div>
  )
}

export function FilesPanel({
  deviceId,
  clientId,
  canUse,
}: {
  deviceId: string
  /** The WS session id — install/push/pull are lease-scoped, exactly like the terminal and the adb endpoint (plan §3.7). */
  clientId: string | null
  /** Same server-authoritative gate every other input control on this page uses — a convenience only, the server checks the lease and `device.files` itself on every request. */
  canUse: boolean
}) {
  const { run, isPending } = useAction()
  const installFileRef = useRef<HTMLInputElement>(null)
  const pushFileRef = useRef<HTMLInputElement>(null)
  const [pushPath, setPushPath] = useState('/data/local/tmp/')
  const [pullPath, setPullPath] = useState('')
  const [installResult, setInstallResult] = useState<InstallResult | null>(null)
  const [pullArtifactId, setPullArtifactId] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState<TransferProgress>(EMPTY_PROGRESS)
  const [pushProgress, setPushProgress] = useState<TransferProgress>(EMPTY_PROGRESS)

  useEffect(() => {
    return ws.on((msg) => {
      if (msg.type === 'transfer.progress' && msg.payload.deviceId === deviceId) {
        const p: TransferProgress = { transferId: msg.payload.transferId, sent: msg.payload.sent, total: msg.payload.total }
        if (msg.payload.kind === 'install') setInstallProgress(p)
        else if (msg.payload.kind === 'push') setPushProgress(p)
      } else if (msg.type === 'transfer.done' && msg.payload.deviceId === deviceId) {
        if (msg.payload.kind === 'install') setInstallProgress(EMPTY_PROGRESS)
        else if (msg.payload.kind === 'push') setPushProgress(EMPTY_PROGRESS)
      }
    })
  }, [deviceId])

  function cancel(progress: TransferProgress): void {
    if (progress.transferId) ws.send({ type: 'transfer.cancel', payload: { transferId: progress.transferId } })
  }

  async function installApk(): Promise<void> {
    const file = installFileRef.current?.files?.[0]
    if (!file || !clientId) return
    setInstallResult(null)
    await run(
      'files-install',
      async () => {
        const uploaded = await uploadArtifact(file, file.name)
        const body = await api<{ result: InstallResult }>(`/api/devices/${deviceId}/install`, {
          method: 'POST',
          json: { artifactId: uploaded.id, clientId },
        })
        setInstallResult(body.result)
        if (installFileRef.current) installFileRef.current.value = ''
      },
      { failure: 'Install failed' },
    )
  }

  async function pushFile(): Promise<void> {
    const file = pushFileRef.current?.files?.[0]
    if (!file || !clientId || !pushPath.trim()) return
    await run(
      'files-push',
      async () => {
        const uploaded = await uploadArtifact(file, file.name)
        await api(`/api/devices/${deviceId}/push`, {
          method: 'POST',
          json: { artifactId: uploaded.id, remotePath: pushPath.trim(), clientId },
        })
        if (pushFileRef.current) pushFileRef.current.value = ''
      },
      { success: 'Pushed', failure: 'Push failed' },
    )
  }

  async function pullFile(): Promise<void> {
    if (!clientId || !pullPath.trim()) return
    setPullArtifactId(null)
    await run(
      'files-pull',
      async () => {
        const body = await api<{ result: { artifactId: string; bytes: number } }>(`/api/devices/${deviceId}/pull`, {
          method: 'POST',
          json: { remotePath: pullPath.trim(), clientId },
        })
        setPullArtifactId(body.result.artifactId)
      },
      { failure: 'Pull failed' },
    )
  }

  // A gated panel always renders its controls, disabled, with one line saying
  // why — never a sentence INSTEAD of the panel (Plan 42 §3.2, §4.2). That is
  // how the Control tab's own canvas already behaves; before this, an
  // operator who just pressed "Take control" on this tab saw nothing change
  // until they switched tabs and back.
  const disabled = !canUse

  return (
    <div className="px-5 py-4">
      {disabled && (
        <p className="mb-4 rounded-lg border bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-muted">
          Take control of this device to push, pull, or install files.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-lg border bg-surface p-4">
          <h3 className="text-[13.5px] font-semibold tracking-tight">Install APK</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">
            Uploads the APK as an artifact, then installs it on this device (<code className="readout">pm install -r -g</code>).
            The staged file is removed from the device afterwards either way.
          </p>
          <input
            ref={installFileRef}
            type="file"
            accept=".apk"
            disabled={disabled}
            className="mt-3 block w-full text-[12px] disabled:opacity-50"
          />
          <Button
            size="sm"
            className="mt-3"
            onClick={() => void installApk()}
            disabled={disabled || isPending('files-install')}
          >
            <Upload className="mr-1.5 size-3.5" aria-hidden />
            {isPending('files-install') ? 'Installing…' : 'Upload and install'}
          </Button>
          <ProgressBar progress={installProgress} label="Installing" />
          {installProgress.transferId && (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => cancel(installProgress)}>
              Cancel
            </Button>
          )}
          {installResult && (
            <p className="mt-3 rounded-md border border-led-ok/35 bg-led-ok/5 px-2.5 py-2 text-[12px]">
              Installed{installResult.package ? ` ${installResult.package}` : ''} in {installResult.durationMs}ms.
            </p>
          )}
        </section>

        <section className="rounded-lg border bg-surface p-4">
          <h3 className="text-[13.5px] font-semibold tracking-tight">Push a file</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">Uploads a file, then writes it to a path on the device.</p>
          <input
            ref={pushFileRef}
            type="file"
            disabled={disabled}
            className="mt-3 block w-full text-[12px] disabled:opacity-50"
          />
          <Input
            className="mt-2 h-8 text-[12px]"
            value={pushPath}
            onChange={(e) => setPushPath(e.target.value)}
            placeholder="/data/local/tmp/file.bin"
            disabled={disabled}
          />
          <Button size="sm" className="mt-3" onClick={() => void pushFile()} disabled={disabled || isPending('files-push')}>
            {isPending('files-push') ? 'Pushing…' : 'Push'}
          </Button>
          <ProgressBar progress={pushProgress} label="Pushing" />
          {pushProgress.transferId && (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => cancel(pushProgress)}>
              Cancel
            </Button>
          )}
        </section>

        <section className="rounded-lg border bg-surface p-4">
          <h3 className="text-[13.5px] font-semibold tracking-tight">Pull a file</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">Reads a path from the device into a new artifact.</p>
          <Input
            className="mt-3 h-8 text-[12px]"
            value={pullPath}
            onChange={(e) => setPullPath(e.target.value)}
            placeholder="/sdcard/report.txt"
            disabled={disabled}
          />
          <Button size="sm" className="mt-3" onClick={() => void pullFile()} disabled={disabled || isPending('files-pull')}>
            {isPending('files-pull') ? 'Pulling…' : 'Pull'}
          </Button>
          {pullArtifactId && (
            <p className="mt-3 text-[12px]">
              <a className="text-accent hover:underline" href={`${coreBase()}/api/artifacts/${pullArtifactId}/content`} target="_blank" rel="noreferrer">
                Download the pulled file
              </a>
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
