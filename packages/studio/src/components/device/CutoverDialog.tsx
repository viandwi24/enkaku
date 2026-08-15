'use client'

import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { CutoverResponseSchema, type ConnectionMedium, type CutoverState, type DeviceInfo } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectionBadge } from '@/components/ConnectionBadge'
import { api, type ApiError } from '@/lib/actions'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'
import { cn } from '@/lib/utils'

function isApiError(err: unknown): err is Error & ApiError {
  return err instanceof Error && 'code' in err
}

/** `DELETE .../connection/cutover` returns `{ ok: true }`, a non-empty body — `z.void()` only parses `undefined` (see `AdmitDeviceDialog.tsx`'s own comment on the exact same trap). The result is discarded either way. */
const CutoverCancelResponseSchema = z.object({ ok: z.boolean() })

/**
 * The USB → network cutover wizard (plan 88 §3.4, §4.6, §5 step 88.5) —
 * arm, flip, watch. The physical USB↔OTG role switch on the chassis is a
 * button no software can press (§2 non-goals), so this is a guided
 * sequence with a human in the middle of it, not a toggle: enable TCP mode
 * over the CURRENT USB cable (verified by read-back before Enkaku ever
 * calls itself armed), then one screen with one instruction — flip the
 * port now — while `device.cutover` broadcasts carry the ladder+sweep's
 * live progress. The waiting state is deliberately honest: it names that
 * it can fail, that it can time out, and that the operator may simply not
 * have pressed anything yet.
 */
export function CutoverDialog({
  device,
  open,
  onOpenChange,
  onDone,
}: {
  device: DeviceInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the phone answers on the network — the caller reloads the device (its badge, address and mediumSource all just changed). */
  onDone: () => void
}) {
  const [medium, setMedium] = useState<ConnectionMedium>('wired')
  const [port, setPort] = useState('')
  const [address, setAddress] = useState('')
  /** `null` = the Check screen (idle) — everything after that is the server's own `CutoverState`. */
  const [state, setState] = useState<CutoverState | null>(null)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null)
  const now = useNow(1000)

  useEffect(() => {
    if (!open) {
      setState(null)
      setRefusal(null)
      setBusy(false)
      setMedium('wired')
      setPort('')
      setAddress('')
    }
  }, [open])

  // `device.cutover` (plan 88 §3.4, §4.6) — a second browser tab, or this
  // tab after a reload, sees the SAME progress. Filtered to this device's
  // `stableId`: the message carries only `state`, no separate deviceId to
  // key on (§4.6's own shape).
  useEffect(() => {
    if (!open || !device) return
    return ws.on((m) => {
      if (m.type === 'device.cutover' && m.payload.state.stableId === device.stableId) {
        setState(m.payload.state)
        if (m.payload.state.step === 'done') onDone()
      }
    })
  }, [open, device, onDone])

  if (!device) return null

  const start = async () => {
    setBusy(true)
    setRefusal(null)
    try {
      const body: { medium: ConnectionMedium; port?: number; address?: string } = { medium }
      const parsedPort = Number(port)
      if (port.trim() && Number.isFinite(parsedPort) && parsedPort > 0) body.port = Math.round(parsedPort)
      if (address.trim()) body.address = address.trim()
      const res = await api(`/api/devices/${device.id}/connection/cutover`, CutoverResponseSchema, { method: 'POST', json: body })
      setState(res.cutover)
      if (res.cutover.step === 'failed') toast.error(`Could not arm ${device.label}`, { description: res.cutover.detail })
    } catch (err) {
      if (isApiError(err)) setRefusal({ code: err.code, message: err.message })
      else toast.error('Could not start the cutover wizard', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    try {
      // Reverts nothing (§3.4): TCP mode stays on, and a phone in TCP mode
      // still works perfectly over USB — this only stops Enkaku watching.
      await api(`/api/devices/${device.id}/connection/cutover`, CutoverCancelResponseSchema, { method: 'DELETE' })
    } catch {
      // Best-effort — the dialog closes either way; there is nothing an
      // operator can do about a failed cancel except close the dialog.
    } finally {
      setBusy(false)
      onOpenChange(false)
    }
  }

  const step = state?.step ?? 'check'
  const windowTotalMs = state?.expiresAt !== null && state?.expiresAt !== undefined ? state.expiresAt - state.startedAt : null
  const remainingMs = state?.expiresAt ? Math.max(0, state.expiresAt - now) : null
  const progressPct =
    windowTotalMs && windowTotalMs > 0 && remainingMs !== null ? Math.max(0, Math.min(100, 100 * (1 - remainingMs / windowTotalMs))) : 0

  // A preview of the badge AFTER a successful cutover — the acceptance
  // criterion is literally "the badge changes from USB to OTG", so the
  // Done screen shows it changing rather than just saying so in prose.
  const connectedHost = state?.connectedAddress?.split(':')[0] ?? null
  const connectedPort = state?.connectedAddress ? Number(state.connectedAddress.split(':').pop()) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move {device.label} to the network</DialogTitle>
          {step === 'check' && (
            <DialogDescription>
              Enkaku enables Wi-Fi/OTG mode over the CURRENT USB cable, then watches for the phone on the network once
              you flip the chassis port. The USB→OTG switch is a physical button on the chassis — no software can
              press it for you.
            </DialogDescription>
          )}
        </DialogHeader>

        {step === 'check' && (
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <ChecklistRow ok={device.connection.kind === 'usb'} label="Connected over USB" />
              <ChecklistRow ok={device.status !== 'offline'} label="Online" />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label htmlFor="cutover-port" className="text-[12px] font-normal">
                  Port
                </Label>
                <Input
                  id="cutover-port"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="5555 (default)"
                  className="readout h-8"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[12px] font-normal">Medium</Label>
                <Select value={medium} onValueChange={(v) => setMedium(v as ConnectionMedium)}>
                  <SelectTrigger className="h-8 text-[12.5px]" aria-label="Medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wired">Wired (OTG)</SelectItem>
                    <SelectItem value="wireless">Wi-Fi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cutover-address" className="text-[12px] font-normal">
                Address (optional — only needed if no network scan is configured)
              </Label>
              <Input
                id="cutover-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="10.20.0.37:5555"
                className="readout h-8"
              />
            </div>

            {device.connection.kind !== 'usb' && (
              <p className="rounded-md border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
                {device.label} is already on the network — this wizard is for the USB→network move itself.
              </p>
            )}
          </div>
        )}

        {(step === 'enabling-tcp' || step === 'armed' || step === 'connecting') && (
          <div className="space-y-3">
            {step === 'enabling-tcp' ? (
              <p className="text-[12.5px] text-fg-muted">Enabling TCP mode over USB…</p>
            ) : (
              <>
                <p className="text-[13.5px] font-medium text-fg">Flip the port on the chassis from USB to OTG now.</p>
                <p className="text-[12.5px] leading-relaxed text-fg-muted">
                  Enkaku is watching for the phone on the network. This can fail, and it can time out — the phone
                  reappears over USB by itself if you flip the port back, or if nothing was pressed at all.
                </p>
              </>
            )}

            {remainingMs !== null && (
              <div className="space-y-1">
                <Progress value={progressPct} />
                <p className="readout text-[11px] text-fg-subtle">{Math.ceil(remainingMs / 1000)}s left in the watch window</p>
              </div>
            )}

            <p className="text-[12.5px] text-fg-muted">{state?.detail}</p>

            {state?.persistSurvivesReboot === false && (
              <p className="text-[11.5px] text-led-warn">This phone will need re-arming after a reboot (H3).</p>
            )}
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-[13px] text-led-ok">
              <Check className="size-4" aria-hidden />
              {state?.detail}
            </p>
            {connectedHost !== null && connectedPort !== null && state && (
              <div className="flex items-center gap-2">
                <ConnectionBadge
                  connection={{
                    kind: 'tcp',
                    medium: state.medium,
                    mediumSource: 'declared',
                    address: connectedHost,
                    port: connectedPort,
                    networkLabel: null,
                  }}
                />
                <code className="readout text-[12px] text-fg-muted">{state.connectedAddress}</code>
              </div>
            )}
          </div>
        )}

        {step === 'failed' && (
          <div className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px] text-led-danger">
            {state?.detail}
          </div>
        )}

        {refusal && (
          <div className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px] text-led-danger">
            {refusal.message}
          </div>
        )}

        {/* §3.4's own note: there is no "return to USB" flow — flip the port
            back and USB hotplug re-announces the phone by itself. */}
        <p className="text-[11.5px] leading-relaxed text-fg-subtle">
          To move it back to USB, flip the chassis port back — the phone reappears here on its own, nothing to do in
          Enkaku.
        </p>

        <DialogFooter>
          {step === 'check' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void start()} disabled={busy || device.connection.kind !== 'usb'}>
                {busy ? 'Enabling…' : 'Enable & arm'}
              </Button>
            </>
          )}
          {(step === 'enabling-tcp' || step === 'armed' || step === 'connecting') && (
            <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </Button>
          )}
          {step === 'failed' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => setState(null)}>Try again</Button>
            </>
          )}
          {step === 'done' && <Button onClick={() => onOpenChange(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChecklistRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className={cn('flex items-center gap-2 text-[12.5px]', ok ? 'text-fg-muted' : 'text-led-danger')}>
      {ok ? <Check className="size-3.5 shrink-0" aria-hidden /> : <X className="size-3.5 shrink-0" aria-hidden />}
      {label}
    </p>
  )
}
