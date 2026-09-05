'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { AppRestartPreviewSchema, AppRestartReportSchema, type AppRestartPreview, type SupervisionMode } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, api, describeApiError } from '@enkaku/ui'

/**
 * The whole-app restart confirmation (plan 120 §4) — deliberately its own
 * component, never a variant of `AdbRestartDialog`: restarting Enkaku
 * itself is a materially bigger blast radius than restarting the shared adb
 * server (every live session/stream drops, every in-flight job is
 * interrupted, the farm is briefly fully unreachable), and an operator must
 * never be able to confuse the two from the dialog alone — same reasoning
 * `AppRestartCard`'s own header comment states for the button that opens
 * this.
 *
 * `mode` comes from `GET /api/tools/app/restart-preview`, fetched fresh
 * every time the dialog opens (never cached, matching `AdbRestartDialog`'s
 * own discipline) — this is what lets the copy below state what ACTUALLY
 * happens next instead of a generic warning: for `docker`/`systemd` the
 * process restarting itself is something Enkaku can promise, because a
 * supervisor outside this process is watching and will relaunch it; for
 * `bare` there is no such supervisor, so the copy says what this process
 * itself does (spawn a copy, verify it, only then step aside) rather than
 * promising a guarantee only a supervisor could keep.
 */

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** What Enkaku can honestly promise happens next, per detected deployment mode — never a guarantee the backend cannot keep. */
function modeExplanation(mode: SupervisionMode): string {
  if (mode === 'docker') {
    return "This is running in Docker — the container's own restart policy (restart: unless-stopped) brings it back automatically, usually within a few seconds."
  }
  if (mode === 'systemd') {
    return 'This is running under systemd — the service unit is configured to relaunch it automatically, usually within a few seconds.'
  }
  return 'This is running with no supervisor watching it (a plain "bun run dev" or a release binary run directly). Enkaku starts a fresh copy of itself and only switches over once that copy proves itself healthy — if it never does, this process keeps running and you will see an error, never a silent failure.'
}

export function AppRestartDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<AppRestartPreview | null>(null)
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
    api('/api/tools/app/restart-preview', AppRestartPreviewSchema)
      .then(setPreview)
      .catch((e) => setLoadError(describeApiError(e)))
  }, [open])

  const busyFarm = preview !== null && (preview.jobsRunning > 0 || preview.controlled > 0)
  const canConfirm = preview !== null && (!busyFarm || force)

  const confirm = async () => {
    setBusy(true)
    try {
      const report = await api('/api/tools/app/restart', AppRestartReportSchema, { method: 'POST', json: { force } })
      toast.success(
        report.outcome === 'verified'
          ? 'Enkaku restarted — this page will reconnect automatically'
          : 'Restart initiated — Enkaku is restarting itself now',
        { description: 'This page will reconnect once it comes back.' },
      )
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
          <DialogTitle>Restart Enkaku itself?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-fg-muted">
              <p>
                This restarts the <strong className="text-fg">whole application</strong> — not just the adb connection. Every live session and
                stream drops, every in-flight job is interrupted, and the farm is briefly fully unreachable while it comes back.
              </p>

              {loadError && <p className="text-led-danger">{loadError}</p>}
              {!preview && !loadError && <p>Checking this farm's current state…</p>}

              {preview && (
                <>
                  <p>
                    <strong className="text-fg">Here:</strong> all {plural(preview.devicesTotal, 'device')} go dark for a moment.{' '}
                    {preview.sessionsActive > 0
                      ? `${plural(preview.sessionsActive, 'live screen')} stop and must be reopened.`
                      : 'No live screens are open right now.'}
                    {preview.controlled > 0 && ` Control is released on ${plural(preview.controlled, 'device')}.`}
                    {preview.jobsRunning > 0 && ` ${plural(preview.jobsRunning, 'running job')} fail${preview.jobsRunning === 1 ? 's' : ''}.`}
                  </p>
                  <p>{modeExplanation(preview.mode)}</p>

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
                        {plural(preview.controlled, 'device')}.
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
            variant="destructive"
            disabled={!canConfirm || busy}
            title={!canConfirm && preview ? 'Check the box above to restart despite the running work' : undefined}
            onClick={() => void confirm()}
          >
            {busy ? 'Restarting…' : 'Restart Enkaku'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
