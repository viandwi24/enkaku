'use client'

import { useEffect, useState } from 'react'
import { Check, Usb, Wifi } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from '@enkaku/ui'
import { newId, ws } from '@/lib/ws'

/**
 * Device enrollment (spec §15.1).
 *
 * The two paths are separate tabs because their steps genuinely differ —
 * they are not variations of one flow. The USB path watches for the device
 * to arrive and advances on its own; people used to have to guess whether it
 * had worked.
 */
/**
 * What the wizard saw. `admitted: false` means the phone reached the
 * Discovered tray — connected, identified, and one deliberate step short of
 * being a farm device (plan 56).
 */
interface Detected {
  label: string
  admitted: boolean
}

export function EnrollmentDialog({
  open,
  onOpenChange,
  unauthorizedSerials,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  unauthorizedSerials: string[]
}) {
  const [detected, setDetected] = useState<Detected | null>(null)

  useEffect(() => {
    if (!open) return
    setDetected(null)
    const off = ws.on((m) => {
      // `device.discovered` is what a freshly connected phone now emits (plan
      // 56): connecting no longer enrols, so waiting only for `device.added`
      // would leave this wizard spinning forever while the phone sat in the
      // Discovered tray — the step is done, and it must say so.
      if (m.type === 'device.discovered') setDetected({ label: m.payload.label ?? m.payload.stableId, admitted: false })
      if (m.type === 'device.added') setDetected({ label: m.payload.label, admitted: true })
    })
    return off
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add device</DialogTitle>
          <DialogDescription>Connect an Android device to this farm.</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="usb">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="usb">
              <Usb className="size-3.5" aria-hidden /> USB cable
            </TabsTrigger>
            <TabsTrigger value="wifi">
              <Wifi className="size-3.5" aria-hidden /> Wireless
            </TabsTrigger>
          </TabsList>

          <TabsContent value="usb" className="pt-3">
            <UsbSteps unauthorizedSerials={unauthorizedSerials} detected={detected} />
          </TabsContent>

          <TabsContent value="wifi" className="pt-3">
            <WirelessSteps detected={detected} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function UsbSteps({ unauthorizedSerials, detected }: { unauthorizedSerials: string[]; detected: Detected | null }) {
  const steps = [
    'On the phone: Settings → About phone → tap "Build number" seven times.',
    'Open Developer options and turn on USB debugging.',
    'Plug the phone into the machine running the core.',
    'The phone shows "Allow USB debugging?" — tick "Always allow", then tap Allow.',
    // Plan 56: connecting is no longer the last step. Ending the list at
    // "Allow" would tell an operator the job is done while the phone is still
    // sitting in the tray, unusable and apparently ignored.
    'Open Discovered and add the phone to the farm.',
  ]

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {steps.map((text, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed">
            <span className="readout mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] text-fg-muted">
              {i + 1}
            </span>
            <span className="text-fg-muted">{text}</span>
          </li>
        ))}
      </ol>

      {unauthorizedSerials.length > 0 && (
        <p className="rounded border border-led-warn/30 bg-led-warn/5 px-2.5 py-2 text-[12px] text-led-warn">
          Waiting for approval on the phone: <span className="readout">{unauthorizedSerials.join(', ')}</span>
        </p>
      )}

      <DetectionStatus detected={detected} waiting="Waiting for a device to appear…" />
    </div>
  )
}

function WirelessSteps({ detected }: { detected: Detected | null }) {
  const [host, setHost] = useState('')
  const [pairPort, setPairPort] = useState('')
  const [code, setCode] = useState('')
  const [connectPort, setConnectPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const ready = host.trim() && /^\d+$/.test(pairPort) && /^\d{6}$/.test(code.trim())

  async function pair() {
    setBusy(true)
    setMessage(null)
    setFailed(false)
    try {
      const req = await ws.request({
        type: 'device.pairing.request',
        id: newId(),
        payload: { host: host.trim(), port: Number.parseInt(pairPort, 10) },
      })
      if (req.type !== 'device.pairing.request.result') throw new Error('Unrecognised reply from the core')
      const res = await ws.request({
        type: 'device.pairing.code',
        id: newId(),
        payload: {
          pairingId: req.payload.pairingId,
          code: code.trim(),
          ...(connectPort ? { connectPort: Number.parseInt(connectPort, 10) } : {}),
        },
      })
      if (res.type !== 'device.pairing.code.result') throw new Error('Unrecognised reply from the core')
      setMessage(res.payload.message)
      setFailed(!res.payload.success)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        On the phone: Developer options → <strong className="text-fg">Wireless debugging</strong> → tap{' '}
        <strong className="text-fg">Pair device with pairing code</strong>. Leave that screen open — the code
        expires when it closes.
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="space-y-1.5">
          <Label htmlFor="host" className="text-[12px] font-normal">
            IP address
          </Label>
          <Input id="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.42" className="readout h-8" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pp" className="text-[12px] font-normal">
            Pairing port
          </Label>
          <Input id="pp" value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="37129" className="readout h-8" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="code" className="text-[12px] font-normal">
            6-digit code
          </Label>
          <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} placeholder="123456" className="readout h-8" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pc" className="text-[12px] font-normal">
            Connect port
          </Label>
          <Input id="pc" value={connectPort} onChange={(e) => setConnectPort(e.target.value)} placeholder="5555" className="readout h-8" />
        </div>
      </div>

      {/* Two different ports is the single most common point of confusion. */}
      <p className="text-[11.5px] leading-relaxed text-fg-subtle">
        The pairing port is in the code window that is open right now. The connect port is on the main Wireless
        debugging screen — it is a different number.
      </p>

      <Button onClick={() => void pair()} disabled={!ready || busy} className="w-full">
        {busy ? 'Connecting…' : 'Pair and connect'}
      </Button>

      {message && (
        <pre
          className={cn(
            'readout max-h-32 overflow-auto whitespace-pre-wrap rounded border p-2 text-[11px]',
            failed ? 'border-led-danger/40 text-led-danger' : 'text-fg-muted',
          )}
        >
          {message}
        </pre>
      )}

      <DetectionStatus detected={detected} waiting="Waiting for the device to show up…" />
    </div>
  )
}

function DetectionStatus({ detected, waiting }: { detected: Detected | null; waiting: string }) {
  return detected ? (
    <p className="flex items-center gap-2 rounded border border-led-ok/30 bg-led-ok/5 px-2.5 py-2 text-[12.5px] text-led-ok">
      <Check className="size-4" aria-hidden />
      {detected.admitted
        ? `${detected.label} is in the farm.`
        : `${detected.label} is connected. Add it from Discovered to finish.`}
    </p>
  ) : (
    <p className="flex items-center gap-2 text-[12px] text-fg-subtle">
      <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle" aria-hidden />
      {waiting}
    </p>
  )
}
