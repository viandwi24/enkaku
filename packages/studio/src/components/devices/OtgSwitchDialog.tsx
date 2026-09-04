'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CutoverStateSchema, type ConnectionMedium, type CutoverState, type DeviceInfo } from '@enkaku/protocol'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  formatDeviceName,
} from '@enkaku/ui'
import { ActionRefusedError, runOnDevice } from '@/lib/actions'
import { useNow } from '@/lib/useNow'
import { ws } from '@/lib/ws'

/**
 * Switch to OTG (the fleet menu on Devices; owner, 2026-09-04) — the whole
 * farm's USB→network move on one screen, instead of one phone at a time.
 *
 * The mechanism is not new: this is `CutoverManager` (plan 88 §3.4), the
 * same arm/flip/watch state machine `CutoverDialog` drives for a single
 * device, fanned out over a selection. What was new is that nothing in
 * Studio mounted `CutoverDialog` at all after the MVP rewrite — the wizard
 * existed and was unreachable, which is why an operator looking for
 * "switch to OTG" could not find it.
 *
 * Two things it will not pretend to do. The USB↔OTG role switch is a
 * physical button on the chassis (§2 non-goals): Enkaku enables adb-over-TCP
 * across the cable that is plugged in right now, and then watches. And it
 * never claims a phone moved — a row says `done` only when that phone
 * actually answered on the network, reported by the server's own
 * `device.cutover` broadcast, address included.
 *
 * Kept separate from Scan networks, in the same menu, on purpose: see
 * `ScanNetworkDialog.tsx`'s own header for the owner's reasoning.
 */
export function OtgSwitchDialog({
  open,
  onOpenChange,
  devices,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The farm as the Devices screen already has it — this dialog does not fetch. */
  devices: DeviceInfo[]
  /** Called each time a phone answers on the network: its badge, address and mediumSource all just changed. */
  onDone: () => void
}) {
  const [medium, setMedium] = useState<ConnectionMedium>('wired')
  const [port, setPort] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** The server's own state per device, keyed by `stableId` — never a local guess about progress. */
  const [states, setStates] = useState<Record<string, CutoverState>>({})
  const [busy, setBusy] = useState(false)
  const now = useNow(1000)

  // Only a phone on a cable can be moved off one. An offline phone cannot be
  // reached to enable TCP mode in the first place, and one already on the
  // network has nothing to move.
  const eligible = useMemo(() => devices.filter((d) => d.connection.kind === 'usb' && d.status !== 'offline'), [devices])
  const already = useMemo(() => devices.filter((d) => d.connection.kind !== 'usb'), [devices])

  useEffect(() => {
    if (!open) {
      setSelected(new Set())
      setStates({})
      setBusy(false)
      setPort('')
      setMedium('wired')
    }
  }, [open])

  // `device.cutover` (plan 88 §4.6) — the same broadcast a second browser
  // tab sees. Progress is the server's; this dialog only renders it.
  useEffect(() => {
    if (!open) return
    return ws.on((m) => {
      if (m.type !== 'device.cutover') return
      const state = m.payload.state
      setStates((prev) => ({ ...prev, [state.stableId]: state }))
      if (state.step === 'done') onDone()
    })
  }, [open, onDone])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allSelected = eligible.length > 0 && eligible.every((d) => selected.has(d.id))

  const parsedPort = (): number | undefined => {
    const n = Number(port.trim())
    return port.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
  }

  /**
   * Started one at a time, not `Promise.all`: each start enables TCP mode
   * over that phone's own cable and reads the port back before arming, and
   * firing twenty of those at the adb server at once is exactly the storm
   * `ADB_MAX_HOST_PROCESSES` exists to prevent. A failure on one device is
   * reported against that device and does not stop the rest — the operator
   * asked for twenty phones, not for the first nineteen to be abandoned
   * because the twentieth was unplugged mid-click.
   */
  const enable = async () => {
    setBusy(true)
    const chosen = eligible.filter((d) => selected.has(d.id))
    const p = parsedPort()
    for (const device of chosen) {
      try {
        const body: { op: 'start'; medium: ConnectionMedium; port?: number } = { op: 'start', medium }
        if (p !== undefined) body.port = p
        const r = await runOnDevice('cutover', device.id, body)
        const next = CutoverStateSchema.parse(r.detail)
        setStates((prev) => ({ ...prev, [device.stableId]: next }))
      } catch (err) {
        const name = formatDeviceName(device.number, device.label)
        if (err instanceof ActionRefusedError) toast.error(`${name}: ${err.message}`)
        else toast.error(`Could not arm ${name}`, { description: err instanceof Error ? err.message : String(err) })
      }
    }
    setBusy(false)
  }

  const cancelAll = async () => {
    const armed = eligible.filter((d) => {
      const step = states[d.stableId]?.step
      return step === 'enabling-tcp' || step === 'armed' || step === 'connecting'
    })
    // Best-effort, and it reverts nothing (§3.4): TCP mode stays on, and a
    // phone in TCP mode still works perfectly over USB. This only stops
    // Enkaku watching.
    for (const d of armed) await runOnDevice('cutover', d.id, { op: 'cancel' }).catch(() => null)
  }

  const watching = Object.values(states).some((s) => s.step === 'enabling-tcp' || s.step === 'armed' || s.step === 'connecting')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Switch to OTG</DialogTitle>
          <DialogDescription>
            Enkaku enables adb over the network across the cable each phone is plugged into right now, then watches for
            it on the LAN once you flip its chassis port. The USB→OTG switch is a physical button — no software can
            press it for you.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5">
            <Label htmlFor="otg-port" className="text-meta font-normal">
              Port
            </Label>
            <Input
              id="otg-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="5555 (default)"
              className="readout h-8"
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-meta font-normal">Medium</Label>
            <Select value={medium} onValueChange={(v) => setMedium(v as ConnectionMedium)}>
              <SelectTrigger className="h-8" aria-label="Medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wired">Wired (OTG)</SelectItem>
                <SelectItem value="wireless">Wi-Fi</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          {eligible.length === 0 ? (
            <EmptyState
              title="No phone is on a cable"
              description={
                already.length > 0
                  ? `Every phone here is already on the network. Flip a chassis port back to USB and it reappears by itself — there is nothing to switch.`
                  : 'This wizard moves a phone from its USB cable to the network. Connect one over USB first.'
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        aria-label="Select every phone on a cable"
                        onCheckedChange={(v) => setSelected(v === true ? new Set(eligible.map((d) => d.id)) : new Set())}
                      />
                    </TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead>Serial</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eligible.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(d.id)}
                          aria-label={`Select ${formatDeviceName(d.number, d.label)}`}
                          onCheckedChange={() => toggle(d.id)}
                        />
                      </TableCell>
                      <TableCell className="text-row text-text">{formatDeviceName(d.number, d.label)}</TableCell>
                      <TableCell className="readout text-meta text-dim">{d.serial}</TableCell>
                      <TableCell>
                        <StateCell state={states[d.stableId] ?? null} now={now} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {already.length > 0 && (
            <p className="mt-2 text-meta text-faint">
              {already.length} phone{already.length === 1 ? ' is' : 's are'} already on the network and not listed here.
            </p>
          )}

          <p className="mt-3 text-meta leading-relaxed text-faint">
            To move one back to USB, flip its chassis port back — the phone reappears on its own, nothing to do here.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {watching && (
            <Button variant="outline" onClick={() => void cancelAll()}>
              Stop watching
            </Button>
          )}
          <Button onClick={() => void enable()} disabled={busy || selected.size === 0}>
            {busy ? 'Enabling…' : `Enable OTG (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One row's live state. The waiting text is deliberately honest — it can
 * fail, it can time out, and the operator may simply not have pressed
 * anything yet — rather than a spinner that implies progress nobody has
 * observed.
 */
function StateCell({ state, now }: { state: CutoverState | null; now: number }) {
  if (!state) return <span className="text-meta text-faint">On USB — not armed</span>

  const remainingMs = state.expiresAt ? Math.max(0, state.expiresAt - now) : null

  if (state.step === 'done') {
    return (
      <span className="text-meta text-led-ok">
        On the network{state.connectedAddress ? ` · ${state.connectedAddress}` : ''}
      </span>
    )
  }
  if (state.step === 'failed') return <span className="text-meta text-led-danger">{state.detail}</span>
  if (state.step === 'enabling-tcp') return <span className="text-meta text-faint">Enabling TCP mode over USB…</span>
  return (
    <span className={cn('text-meta', 'text-led-warn')}>
      Flip this chassis port to OTG now
      {remainingMs !== null && ` · ${Math.ceil(remainingMs / 1000)}s left`}
    </span>
  )
}
