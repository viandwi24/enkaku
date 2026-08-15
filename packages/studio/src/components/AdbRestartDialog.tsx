'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AdbRestartPreviewSchema, AdbRestartReportSchema } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { api, describeApiError } from '@/lib/actions'

/**
 * The adb restart confirmation (plan 88 §3.10, §4.8, §5 step 88.8).
 *
 * The owner accepted, explicitly, that restarting the shared adb server
 * costs something real: every OTHER program on this machine using adb loses
 * its connection at the same moment. That cost is stated here, before the
 * click, with THIS farm's live numbers — fetched fresh every time the
 * dialog opens, never cached, never a generic warning nobody reads.
 *
 * No automatic restart exists anywhere in this codebase; this dialog is the
 * only path to `POST /api/tools/adb/restart` (`tools/routes.ts`) — a human
 * opens it, reads it, and clicks. That is the whole point of the
 * `kill-server` prohibition this restart is an audited exception to.
 */

interface Preview {
  devicesTotal: number
  sessionsActive: number
  leasesHeld: number
  jobsRunning: number
  networkDevicesWithEndpoint: number
  restartCooldownSec: number
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function AdbRestartDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      // Reset so the NEXT open always re-fetches — a preview from five
      // minutes ago is not this farm's current state.
      setPreview(null)
      setLoadError(null)
      setForce(false)
      return
    }
    api('/api/tools/adb/restart-preview', AdbRestartPreviewSchema)
      .then(setPreview)
      .catch((e) => setLoadError(describeApiError(e)))
  }, [open])

  const busyFarm = preview !== null && (preview.jobsRunning > 0 || preview.leasesHeld > 0)
  const canConfirm = preview !== null && (!busyFarm || force)

  const confirm = async () => {
    setBusy(true)
    try {
      const report = await api('/api/tools/adb/restart', AdbRestartReportSchema, { method: 'POST', json: { force } })
      toast.success(`adb restarted — ${report.devicesAfter}/${report.devicesBefore} device(s) back online`, {
        ...(report.reattachFailed.length > 0
          ? { description: `${plural(report.reattachFailed.length, 'network device')} did not reconnect: ${report.reattachFailed.map((d) => d.label).join(', ')}` }
          : {}),
      })
      setOpen(false)
    } catch (e) {
      toast.error('Restart failed', { description: describeApiError(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart the adb server?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-fg-muted">
              <p>This stops and restarts the adb server that this computer shares with every other program using adb.</p>

              {loadError && <p className="text-led-danger">{loadError}</p>}
              {!preview && !loadError && <p>Checking this farm's current state…</p>}

              {preview && (
                <>
                  <p>
                    <strong className="text-fg">Here:</strong> all {plural(preview.devicesTotal, 'device')} disconnect and reconnect.{' '}
                    {preview.sessionsActive > 0
                      ? `${plural(preview.sessionsActive, 'live screen')} stop and resume.`
                      : 'No live screens are open right now.'}
                    {preview.leasesHeld > 0 && ` Control is released on ${plural(preview.leasesHeld, 'device')}.`}
                    {preview.jobsRunning > 0 && ` ${plural(preview.jobsRunning, 'running job')} fail${preview.jobsRunning === 1 ? 's' : ''}.`}
                  </p>
                  <p>
                    <strong className="text-fg">Elsewhere:</strong> any other program using adb on this machine loses its connection at the same
                    moment — Android Studio's device list and Logcat, a terminal running <code className="readout">adb logcat</code>, Flutter or
                    React Native tooling. Most reconnect on their own; a command already running will exit.
                  </p>
                  <p>
                    <strong className="text-fg">Network devices</strong> ({preview.networkDevicesWithEndpoint} here) are dialled again from their
                    last known addresses afterwards. Any whose address has changed need a rescan.
                  </p>
                  <p>Usually takes 5–15 seconds.</p>

                  {busyFarm && (
                    <label className="flex items-start gap-2 rounded border border-led-danger/35 bg-led-danger/10 px-3 py-2 text-[12.5px] text-fg">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={force}
                        onChange={(e) => setForce(e.target.checked)}
                        aria-label="Restart anyway, despite running jobs or held control"
                      />
                      <span>
                        Restart anyway — this fails {plural(preview.jobsRunning, 'running job')} and releases control on{' '}
                        {plural(preview.leasesHeld, 'device')}.
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="bg-led-danger text-white hover:bg-led-danger/90"
            disabled={!canConfirm || busy}
            title={!canConfirm && preview ? 'Check the box above to restart despite the running work' : undefined}
            onClick={() => void confirm()}
          >
            {busy ? 'Restarting…' : 'Restart adb server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
