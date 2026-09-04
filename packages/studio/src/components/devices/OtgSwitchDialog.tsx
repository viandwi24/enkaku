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
 * arm/flip/watch state machine, fanned out over a selection. What was new is
 * that nothing in Studio mounted its old single-device dialog at all after
 * the MVP rewrite — the wizard existed and was unreachable, which is why an
 * operator looking for "switch to OTG" could not find it.
 *
 * That dialog (`components/device/CutoverDialog.tsx`) is now deleted rather
 * than revived, and this is the only door. One phone is this screen with one
 * row ticked, which is why the group filter and the single-phone address
 * field below exist at all: the alternative was two surfaces for one action,
 * drifting apart, which is the split this codebase argues against every time
 * it comes up. The one thing the old dialog could do that a fleet screen
 * cannot is a per-phone address, so that field came across with it — shown
 * only when exactly one phone is ticked, because an address names one
 * chassis port and nothing sensible can be done with one across twenty.
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
  const [group, setGroup] = useState('all')
  const [medium, setMedium] = useState<ConnectionMedium>('wired')
  const [port, setPort] = useState('')
  const [address, setAddress] = useState('')
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

  /**
   * Groups are derived from the phones this dialog can actually act on, not
   * from the farm's whole group list: a group whose every phone is already
   * on the network would otherwise sit in the menu and select nothing.
   * Ungrouped phones get their own entry for the same reason — they are a
   * real thing an operator filters to, and "All" hiding them behind a
   * scroll is what made this dialog awkward on a rack with two chassis.
   */
  const groupOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; count: number }>()
    let ungrouped = 0
    for (const d of eligible) {
      if (!d.group) {
        ungrouped += 1
        continue
      }
      const seen = byId.get(d.group.id)
      if (seen) seen.count += 1
      else byId.set(d.group.id, { id: d.group.id, name: d.group.name, count: 1 })
    }
    const rows = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
    return ungrouped > 0 ? [...rows, { id: 'none', name: 'Ungrouped', count: ungrouped }] : rows
  }, [eligible])

  const visible = useMemo(
    () => (group === 'all' ? eligible : eligible.filter((d) => (group === 'none' ? d.group === null : d.group?.id === group))),
    [eligible, group],
  )

  /**
   * Only what is on screen is ever enabled. A selection made before the
   * filter changed stays remembered — switch back and the ticks are still
   * there — but "Enable OTG (3)" must never mean "and one more you cannot
   * see": this is a physical action on a specific chassis.
   */
  const chosen = useMemo(() => visible.filter((d) => selected.has(d.id)), [visible, selected])

  useEffect(() => {
    if (!open) {
      setSelected(new Set())
      setStates({})
      setBusy(false)
      setPort('')
      setAddress('')
      setMedium('wired')
      setGroup('all')
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

  const allSelected = visible.length > 0 && visible.every((d) => selected.has(d.id))

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
    const p = parsedPort()
    for (const device of chosen) {
      try {
        const body: { op: 'start'; medium: ConnectionMedium; port?: number; address?: string } = { op: 'start', medium }
        if (p !== undefined) body.port = p
        // Only ever sent for a single phone — see the field's own note below.
        if (chosen.length === 1 && address.trim()) body.address = address.trim()
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

        <div className="grid grid-cols-3 gap-2.5">
          <div className="min-w-0 space-y-1.5">
            <Label className="text-meta font-normal">Group</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger className="h-8" aria-label="Group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All groups ({eligible.length})</SelectItem>
                {groupOptions.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name} ({g.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5">
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
          <div className="min-w-0 space-y-1.5">
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

        {chosen.length === 1 && (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="otg-address" className="text-meta font-normal">
              Address (optional — only needed if no network range is configured)
            </Label>
            <Input
              id="otg-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="10.20.0.37:5555"
              className="readout h-8"
            />
            <p className="text-meta text-faint">
              Where this phone will answer once you flip its port. Without it Enkaku looks in the addresses it
              remembers and in the ranges under Scan networks — which is enough for a farm that has either, and
              nothing at all for a farm that has neither. One phone only: an address names one chassis port, so this
              disappears the moment a second phone is ticked.
            </p>
          </div>
        )}

        <div className="min-w-0">
          {visible.length === 0 ? (
            <EmptyState
              title={eligible.length === 0 ? 'No phone is on a cable' : 'No phone on a cable in this group'}
              description={
                eligible.length > 0
                  ? 'Every phone on a cable is in another group. Pick All groups to see them.'
                  : already.length > 0
                    ? 'Every phone here is already on the network. Flip a chassis port back to USB and it reappears by itself — there is nothing to switch.'
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
                        aria-label="Select every phone listed"
                        onCheckedChange={(v) => setSelected(v === true ? new Set(visible.map((d) => d.id)) : new Set())}
                      />
                    </TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead>Serial</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((d) => (
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
          <Button onClick={() => void enable()} disabled={busy || chosen.length === 0}>
            {busy ? 'Enabling…' : `Enable OTG (${chosen.length})`}
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
