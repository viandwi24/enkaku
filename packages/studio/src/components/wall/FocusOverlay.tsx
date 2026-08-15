'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ExternalLink, OctagonX, ScreenShare, X } from 'lucide-react'
import {
  DeviceDetailResponseSchema,
  JobCancelResponseSchema,
  SettingsResponseSchema,
  type CoControlMode,
  type DeviceInfo,
  type DeviceStatus,
  type LeaseHolder,
  type MirrorMember,
  type MirrorResult,
} from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { RotationQuickAction } from '@/components/device/RotationQuickAction'
import { AssistDialog } from '@/components/device/AssistDialog'
import { mmss, type DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { LoadingRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api, useAction } from '@/lib/actions'
import { newId, ws } from '@/lib/ws'
import { useNow } from '@/lib/useNow'

/** How many candidate devices a Mirror group needs before it means anything — one device mirroring itself is just ordinary control. */
const MIN_MIRROR_DEVICES = 2

/**
 * The focus overlay (plan 91 §3.11, §5 step 91.9) — the thing that closes
 * what step 91.8 opened. Double-clicking a wall tile sets `?focus=<id>`; this
 * is what reads it (via the `deviceId` prop `app/page.tsx` hands down from
 * that same param) and gives the operator a way back.
 *
 * **Not a `Dialog`.** No focus trap, no `aria-modal`, no full-screen backdrop
 * — a plain `fixed`, resizable panel over the Wall, which stays mounted and
 * live behind it (§3.11's own reasoning: this is a React overlay in the same
 * route, not a navigation, so nothing here remounts the page or drops the
 * WS). `Esc` closes it, but only when the video canvas does NOT already
 * consume that key as `BACK` (`LiveView.tsx`'s own `onKeyDown` binding) —
 * see the keydown effect below for the precedence rule and why it needs no
 * change to `LiveView` at all.
 *
 * **Quality handoff.** This is the ONE place in Studio that renders
 * `<LiveView quality="control" />` for a device also visible as a Wall tile:
 * `WallTile` (91.8) already stops decoding the focused device and shows the
 * "Controlling here" placeholder instead, so opening this overlay moves a
 * decoder rather than adding one (proven in `FocusOverlay.test.tsx`, not
 * merely asserted here).
 *
 * **Quick control, not a takeover.** An idle device is claimed automatically
 * on open — the owner's own "double-click to focus remote control" (§0.3) —
 * with no separate Take-control step, since the rail has no such button
 * (§3.11's own nine-item table does not list one). A device already held by
 * a job or another person is never auto-claimed or taken over from here;
 * Assist is the only way in, exactly like the device page's own busy-state
 * banner (`ScreenCard.tsx`, step 91.6) — reused via `AssistDialog` itself,
 * not reimplemented.
 *
 * **The rail.** Four of §3.11's nine items need nothing from this file at
 * all: Back/Home/Recents, Power/Volume/Mute, Wake/Sleep and Clipboard are
 * already inside `LiveView`'s own (non-`compact`) chrome (F26) — rendering
 * an ordinary `<LiveView>` here is what "reuses" them. Rotate is
 * `RotationQuickAction`, placed in the sidebar unchanged. Open full device
 * page is a plain `next/link`. Only Assist, Mirror (on/off, member count,
 * the result strip) and End task are new, per the plan's own exception list.
 */
export function FocusOverlay({
  deviceId,
  devices,
  selectedIds,
  onClose,
}: {
  deviceId: string
  /** The Wall's full (unfiltered) device list — labels/status for the Mirror candidate set, never fetched a second time. */
  devices: DeviceInfo[]
  /** The Wall's own selection (plan 91 §5 step 91.8) — unioned with `deviceId` itself to form Mirror's candidate set. */
  selectedIds: readonly string[]
  onClose: () => void
}) {
  const [deviceDetail, setDeviceDetail] = useState<DeviceDetailInfo | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [controlExpiresAt, setControlExpiresAt] = useState<number | null>(null)
  const [assisting, setAssisting] = useState<{ expiresAt: number; primary: LeaseHolder } | null>(null)
  const [assistOpen, setAssistOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [coControlMode, setCoControlMode] = useState<CoControlMode>('operator')
  const [assistGrantTtlSec, setAssistGrantTtlSec] = useState(300)

  // Mirror (plan 91 §3.8, §3.9) — this overlay's own client-side state for
  // the ONE group it may own; `mirror.stop` on unmount (below) means no
  // group ever outlives the panel that was driving it.
  const [mirrorGroupId, setMirrorGroupId] = useState<string | null>(null)
  const [mirrorMembers, setMirrorMembers] = useState<MirrorMember[]>([])
  const [mirrorStarting, setMirrorStarting] = useState(false)
  const [mirrorConfirmOpen, setMirrorConfirmOpen] = useState(false)
  const [mirrorLastResults, setMirrorLastResults] = useState<MirrorResult[] | null>(null)
  const [mirrorResultsOpen, setMirrorResultsOpen] = useState(false)
  const [soloToggle, setSoloToggle] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const [endTaskOpen, setEndTaskOpen] = useState(false)

  const now = useNow()
  const { run, isPending } = useAction()

  const mirrorGroupIdRef = useRef(mirrorGroupId)
  mirrorGroupIdRef.current = mirrorGroupId

  const label = deviceDetail?.label ?? deviceId
  const status: DeviceStatus | null = deviceDetail?.status ?? null
  const busy = status === 'busy'
  const iHoldControl = controlExpiresAt !== null
  const iAmAssisting = assisting !== null
  const inputEnabled = (iHoldControl && !busy) || iAmAssisting
  const assistSecondsLeft = assisting === null ? null : Math.max(0, Math.round((assisting.expiresAt - now) / 1000))
  const jobId = deviceDetail?.heldBy?.kind === 'job' ? deviceDetail.heldBy.id : null
  const solo = altHeld || soloToggle

  // Fetch the focus device's own detail, and quietly claim it if nobody else
  // holds it (see the file header — no "Take control" rail item exists on
  // purpose). Deliberately does NOT reset `mirrorGroupId`/`mirrorMembers`
  // below: a Mirror group belongs to this whole overlay SESSION, not to
  // whichever tile happens to be focused inside it — switching which member
  // you are looking at must not silently stop driving the rest (§3.9).
  useEffect(() => {
    let cancelled = false
    setDeviceDetail(null)
    setFetchError(null)
    setControlExpiresAt(null)
    setAssisting(null)
    setNotice(null)
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        if (cancelled) return
        setDeviceDetail(b.device)
        if (b.device.status === 'idle') {
          void ws
            .request({ type: 'lease.acquire', id: newId(), payload: { deviceId } })
            .then((res) => {
              if (cancelled) return
              if (res.type === 'lease.acquired') setControlExpiresAt(res.payload.expiresAt * 1000)
            })
            .catch(() => {
              // Lost a race to someone else on a busy wall — not an error
              // worth a red banner. The `lease.changed`/`device.status`
              // handlers below pick up the real holder the moment the
              // broadcast lands, and the Assist banner covers it from there.
            })
        }
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [deviceId])

  useEffect(() => {
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setCoControlMode(b.settings.coControl.mode)
        setAssistGrantTtlSec(b.settings.coControl.grantTtlSec)
      })
      .catch(() => undefined)
  }, [])

  // Kept live, the same shape `app/device/page.tsx` already established for
  // each of these broadcasts — this overlay is a second, simultaneous
  // viewer of exactly the same facts, not a fork of them.
  useEffect(() => {
    const off = ws.on((msg) => {
      if (msg.type === 'device.status' && msg.payload.id === deviceId) {
        setDeviceDetail((d) => (d ? { ...d, status: msg.payload.status } : d))
        if (msg.payload.status !== 'manual' && msg.payload.status !== 'busy') setControlExpiresAt(null)
      } else if (msg.type === 'lease.changed' && msg.payload.deviceId === deviceId) {
        setDeviceDetail((d) => (d ? { ...d, heldBy: msg.payload.heldBy } : d))
      } else if (msg.type === 'lease.revoked' && msg.payload.deviceId === deviceId) {
        setControlExpiresAt(null)
      } else if (msg.type === 'assist.changed' && msg.payload.deviceId === deviceId) {
        setDeviceDetail((d) => (d ? { ...d, assistedBy: msg.payload.assistedBy } : d))
      } else if (msg.type === 'assist.stopped' && msg.payload.deviceId === deviceId) {
        setAssisting(null)
        if (msg.payload.reason !== 'released') {
          setNotice(
            msg.payload.reason === 'ttl'
              ? 'Assisting stopped automatically after a period of inactivity.'
              : msg.payload.reason === 'primary_ended'
                ? 'Assisting stopped — the job it was helping has finished.'
                : msg.payload.reason === 'mode_off'
                  ? 'Assisting was turned off for this farm.'
                  : 'Assisting stopped — the connection dropped.',
          )
        }
      } else if (msg.type === 'mirror.changed' && mirrorGroupIdRef.current && msg.payload.groupId === mirrorGroupIdRef.current) {
        setMirrorMembers(msg.payload.members)
      }
    })
    return off
  }, [deviceId])

  // Leaving the group behind when the panel closes (unmount, not merely a
  // focus change — see the effect above) is the honest counterpart of
  // 91.10's own "orphaned mirror groups" leak detector: this client stops
  // producing input for it the instant the overlay is gone, so the group
  // should not linger server-side either.
  useEffect(
    () => () => {
      const groupId = mirrorGroupIdRef.current
      if (groupId) ws.send({ type: 'mirror.stop', payload: { groupId } })
    },
    [],
  )

  // `Esc` closes the overlay — UNLESS the video canvas already consumed it
  // as `BACK` (plan 91 §3.11's own called-out collision). `LiveView`'s
  // `onKeyDown` runs first (its listener sits closer to the actual target in
  // React's own delegated dispatch) and calls `preventDefault()` the moment
  // it turns Escape into a keycode — which happens only when the canvas has
  // focus AND input is enabled. A bubble-phase `window` listener fires
  // strictly after that, so checking `defaultPrevented` here is a complete,
  // accurate answer to "did the canvas just use this key" — no coupling to
  // `LiveView`'s internals, and no change needed inside that file for this
  // at all.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // `Alt` for solo (§3.9) — held, not toggled; `blur` clears it so an
  // Alt-Tab away from the browser never leaves it stuck down.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Alt') setAltHeld(true)
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') setAltHeld(false)
    }
    function onBlur() {
      setAltHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  function noteActivity() {
    if (assisting) setAssisting((a) => (a ? { ...a, expiresAt: Date.now() + assistGrantTtlSec * 1000 } : a))
  }

  function stopAssisting() {
    ws.send({ type: 'assist.stop', payload: { deviceId } })
    setAssisting(null)
  }

  const candidateIds = useMemo(() => [...new Set([deviceId, ...selectedIds])], [deviceId, selectedIds])
  const candidateDevices = useMemo(() => devices.filter((d) => candidateIds.includes(d.id)), [devices, candidateIds])
  const canStartMirror = candidateDevices.length >= MIN_MIRROR_DEVICES
  const freeCount = candidateDevices.filter((d) => d.status === 'idle').length
  const assistCandidateCount = candidateDevices.filter((d) => d.status === 'busy' || d.status === 'manual').length
  const otherCount = candidateDevices.length - freeCount - assistCandidateCount

  async function startMirror() {
    setMirrorStarting(true)
    try {
      const res = await ws.request({
        type: 'mirror.start',
        id: newId(),
        payload: { focusDeviceId: deviceId, deviceIds: candidateIds },
      })
      if (res.type === 'mirror.started') {
        setMirrorGroupId(res.payload.groupId)
        setMirrorMembers(res.payload.members)
        setMirrorLastResults(null)
      }
    } catch (err) {
      toast.error('Could not start mirroring', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setMirrorStarting(false)
    }
  }

  function stopMirror() {
    const groupId = mirrorGroupId
    if (!groupId) return
    ws.send({ type: 'mirror.stop', payload: { groupId } })
    setMirrorGroupId(null)
    setMirrorMembers([])
    setMirrorLastResults(null)
  }

  function labelFor(id: string): string {
    return mirrorMembers.find((m) => m.deviceId === id)?.label ?? devices.find((d) => d.id === id)?.label ?? id
  }

  const activeMemberCount = mirrorMembers.filter((m) => m.mode !== 'skipped').length
  const okResultCount = mirrorLastResults?.filter((r) => r.ok).length ?? 0
  const failedResults = mirrorLastResults?.filter((r) => !r.ok) ?? []

  return (
    <div
      role="region"
      aria-label={`Focused control — ${label}`}
      className="fixed left-1/2 top-1/2 z-40 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-auto rounded-lg border border-line-strong bg-surface shadow-2xl resize"
      style={{ width: 'min(92vw, 980px)', height: 'min(88vh, 720px)', minWidth: 420, minHeight: 360 }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ScreenShare className="size-4 shrink-0 text-accent-strong" aria-hidden />
          <span className="truncate text-[13px] font-medium">{label}</span>
          {busy && <span className="rack-label text-led-active">busy</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/device?id=${encodeURIComponent(deviceId)}`}>
              <ExternalLink className="size-3.5" aria-hidden />
              Open full device page
            </Link>
          </Button>
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {notice && <p className="shrink-0 border-b px-3 py-1.5 text-[11.5px] text-led-warn">{notice}</p>}
      {fetchError && <p className="shrink-0 border-b px-3 py-1.5 text-[11.5px] text-led-danger">{fetchError}</p>}

      <div className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-auto p-3 sm:flex-nowrap">
        <div className="min-w-0 flex-1">
          {deviceDetail ? (
            <LiveView
              deviceId={deviceId}
              inputEnabled={inputEnabled}
              onActivity={noteActivity}
              quality="control"
              mirror={mirrorGroupId ? { groupId: mirrorGroupId, solo, onResult: setMirrorLastResults } : undefined}
            />
          ) : (
            !fetchError && <LoadingRows rows={2} />
          )}
        </div>

        <aside className="w-full shrink-0 space-y-3 sm:w-60">
          {deviceDetail && (
            <RotationQuickAction
              deviceId={deviceId}
              settings={deviceDetail.settings}
              onSaved={(s) => setDeviceDetail((d) => (d ? { ...d, settings: s } : d))}
            />
          )}

          {/* Assist (plan 91 §3.2, §3.12) — reuses `AssistDialog` unchanged; only the banner/chip around it is new here. */}
          {deviceDetail?.heldBy && !assisting && (
            <div className="space-y-1.5 rounded-lg border p-2.5">
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                <span className="readout text-fg">{deviceDetail.heldBy.label}</span>{' '}
                {deviceDetail.heldBy.kind === 'job' ? 'is running on this device.' : 'is using this device.'}
              </p>
              <Button size="sm" variant="outline" disabled={coControlMode === 'off'} onClick={() => setAssistOpen(true)}>
                Assist
              </Button>
              {coControlMode === 'off' && <p className="text-[11px] text-fg-subtle">Assisting is turned off for this farm.</p>}
            </div>
          )}
          {assisting && (
            <div className="space-y-1 rounded-lg border border-led-warn p-2.5">
              <p className="rack-label text-led-warn">Assisting — the job still has control</p>
              <div className="flex items-center justify-between">
                <span className="readout text-[11px] text-led-warn">{mmss(assistSecondsLeft ?? 0)}</span>
                <button
                  type="button"
                  onClick={stopAssisting}
                  className="text-[11px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  Stop assisting
                </button>
              </div>
            </div>
          )}
          {deviceDetail?.heldBy && (
            <AssistDialog
              deviceId={deviceId}
              deviceLabel={label}
              primary={deviceDetail.heldBy}
              grantTtlSec={assistGrantTtlSec}
              open={assistOpen}
              onOpenChange={setAssistOpen}
              onAssisted={(expiresAtMs, primary) => setAssisting({ expiresAt: expiresAtMs, primary })}
            />
          )}

          {/* Mirror (plan 91 §3.8, §3.9) — on/off, the live member count, and the per-action result strip. */}
          <div className="space-y-2 rounded-lg border p-2.5">
            <div className="flex items-center justify-between">
              <span className="rack-label">Mirror</span>
              <Switch
                aria-label="Mirror input to the selected devices"
                checked={mirrorGroupId !== null}
                disabled={mirrorStarting || (!mirrorGroupId && !canStartMirror)}
                onCheckedChange={(checked) => {
                  if (checked) setMirrorConfirmOpen(true)
                  else stopMirror()
                }}
              />
            </div>
            {!mirrorGroupId && !canStartMirror && (
              <p className="text-[11px] text-fg-subtle">Select at least one more device on the Wall to mirror input to it.</p>
            )}
            {mirrorGroupId && (
              <>
                <p className="readout text-[11px] text-fg-muted">
                  {activeMemberCount} / {mirrorMembers.length} devices active
                </p>
                <label className="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
                  Focused only
                  <Switch size="sm" checked={solo} disabled={altHeld} onCheckedChange={setSoloToggle} />
                </label>
                {mirrorLastResults && mirrorLastResults.length > 0 && (
                  <div>
                    <button
                      type="button"
                      className="readout text-[11px] underline-offset-2 hover:underline"
                      onClick={() => setMirrorResultsOpen((o) => !o)}
                    >
                      {okResultCount}/{mirrorLastResults.length}
                    </button>
                    {mirrorResultsOpen && failedResults.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[11px] text-fg-subtle">
                        {failedResults.map((r) => (
                          <li key={r.deviceId}>
                            {labelFor(r.deviceId)} — {r.code ?? 'failed'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* End task — this plan's button over the existing `POST /api/jobs/:id/cancel`. */}
          {jobId && (
            <Button size="sm" variant="outline" className="w-full text-led-danger" onClick={() => setEndTaskOpen(true)}>
              <OctagonX className="size-3.5" aria-hidden />
              End task
            </Button>
          )}
        </aside>
      </div>

      <AlertDialog open={mirrorConfirmOpen} onOpenChange={setMirrorConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Control {candidateDevices.length} devices at once?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5 text-[12.5px] leading-relaxed text-fg-muted">
                {freeCount > 0 && (
                  <p>
                    {freeCount} device{freeCount === 1 ? ' is' : 's are'} free — you will take control of {freeCount === 1 ? 'it' : 'them'}.
                  </p>
                )}
                {assistCandidateCount > 0 && (
                  <p>
                    {assistCandidateCount} device{assistCandidateCount === 1 ? '' : 's'} already in use — you will assist{' '}
                    {assistCandidateCount === 1 ? 'it' : 'them'}, and whoever holds {assistCandidateCount === 1 ? 'it' : 'them'} keeps control.
                  </p>
                )}
                {otherCount > 0 && <p>{otherCount} device{otherCount === 1 ? '' : 's'} may be skipped (offline, quarantined, or otherwise unavailable) — the exact reason appears on its tile once mirroring starts.</p>}
                <p>
                  Everything you tap, swipe, type or press goes to all {candidateDevices.length} at once. Hold Alt, or use
                  &quot;Focused only&quot; in the rail, to send to just this device.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mirrorStarting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mirrorStarting}
              onClick={async (e) => {
                e.preventDefault()
                await startMirror()
                setMirrorConfirmOpen(false)
              }}
            >
              {mirrorStarting ? 'Starting…' : `Control ${candidateDevices.length} devices`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {jobId && (
        <AlertDialog open={endTaskOpen} onOpenChange={setEndTaskOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                End {deviceDetail?.heldBy?.label ?? 'this job'} on {label}?
              </AlertDialogTitle>
              <AlertDialogDescription>The job stops immediately. This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending('end-task')}>Keep it running</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending('end-task')}
                className="bg-led-danger text-white hover:bg-led-danger/90"
                onClick={async (e) => {
                  e.preventDefault()
                  await run('end-task', () => api(`/api/jobs/${jobId}/cancel`, JobCancelResponseSchema, { method: 'POST' }), {
                    success: 'Job ended',
                    failure: 'Could not end the job',
                  })
                  setEndTaskOpen(false)
                }}
              >
                {isPending('end-task') ? 'Ending…' : 'End task'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
