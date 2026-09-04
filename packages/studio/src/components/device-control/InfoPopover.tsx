'use client'

import { useEffect, useState } from 'react'
import { ws } from '@/lib/ws'
import type { DeviceDetail } from '@enkaku/protocol'
import { Button, Popover, PopoverContent, PopoverTrigger, InfoIcon } from '@enkaku/ui'
import { fetchGuestAgentStatus, type GuestAgentStatus } from '@/lib/api'
import { useOverlay } from '@/lib/overlays'

/**
 * The `[i]` popover (design handoff README.md:270-272; plan 215 §4.9): 306px,
 * "This device" then "Active engines" then Change. The four engine rows keep
 * the labels `DeviceHeader.tsx`'s `ENGINE_ROWS` used before that file was
 * deleted by this plan, so the popover and the Settings dialog name the
 * same four things.
 */
const ENGINE_ROWS = [
  { key: 'transport', label: 'transport' },
  { key: 'display', label: 'video' },
  { key: 'input', label: 'input' },
  { key: 'inspection', label: 'inspection' },
] as const

export function InfoPopover({ device, onChange }: { device: DeviceDetail; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [guestAgent, setGuestAgent] = useState<GuestAgentStatus | null>(null)
  /**
   * Why the inspector is not the engine this device is configured for.
   *
   * The core already broadcasts `device.inspector.fallback` with a written
   * reason — "the installed guest agent build does not advertise the ui-tree
   * capability", "the accessibility service is not enabled on this phone" —
   * and nothing in Studio listened. So a farm silently paying ui-server's
   * eight-second attach looked exactly like a farm on the fast engine, and
   * the only way to learn otherwise was to read the core's log (owner,
   * 2026-09-04). The wire carried the answer the whole time.
   */
  const [fallback, setFallback] = useState<{ from: string; to: string; reason: string } | null>(null)

  useEffect(
    () =>
      ws.on((msg) => {
        if (msg.type === 'device.inspector.fallback' && msg.payload.deviceId === device.id) {
          setFallback({ from: msg.payload.from, to: msg.payload.to, reason: msg.payload.reason })
        }
      }),
    [device.id],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchGuestAgentStatus(device.id)
      .then((s) => {
        if (!cancelled) setGuestAgent(s)
      })
      .catch(() => {
        if (!cancelled) setGuestAgent(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, device.id])

  useOverlay('menu', open, () => setOpen(false))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Device info">
          <InfoIcon className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent data-menu-root="1" align="end" className="w-[306px]">
        <h3 className="mb-1.5 text-label text-faint">This device</h3>
        <dl className="mb-3 space-y-1 text-meta">
          <Row label="group" value={device.group?.name ?? 'No group'} />
          <Row label="stable id" value={device.stableId} mono />
          <Row label="endpoint" value={device.connection.address ?? device.serial} mono />
          <Row label="api level" value={device.apiLevel !== null ? String(device.apiLevel) : '–'} />
          <Row label="screen" value={device.screenW && device.screenH ? `${device.screenW}x${device.screenH}` : '–'} />
          <Row label="density" value={device.density !== null ? String(device.density) : '–'} />
          {/*
            The agent's own version and what it can do, not just its state.
            "How do I check the guest agent version on this phone?" had no
            answer in Studio (owner, 2026-09-04) — and it is the question that
            decides whether the ui-tree inspector is live here or whether this
            device is silently falling back to ui-server's ~32 s attach.
            `capabilities` is the honest form of that: `liveInspection` on the
            device says which engine WON, this says which were possible.
          */}
          <Row label="guest agent" value={guestAgent ? guestAgent.state : 'Not installed'} />
          {guestAgent && (
            <Row
              label="agent version"
              value={`${guestAgent.appVersion ?? '–'}${guestAgent.versionCode !== null ? ` (code ${guestAgent.versionCode})` : ''}`}
              mono
            />
          )}
          {guestAgent && (
            <Row label="agent can" value={guestAgent.capabilities && guestAgent.capabilities.length > 0 ? guestAgent.capabilities.join(', ') : 'nothing declared'} />
          )}
          <Row label="live inspection" value={device.liveInspection ?? '–'} />
          {fallback && (
            <div className="pt-0.5 text-meta text-warn">
              fell back from {fallback.from} to {fallback.to}: {fallback.reason}
            </div>
          )}
        </dl>
        <h3 className="mb-1.5 text-label text-faint">Active engines</h3>
        <dl className="mb-3 space-y-1 text-meta">
          {ENGINE_ROWS.map((r) => (
            <Row key={r.key} label={r.label} value={(device[r.key as keyof DeviceDetail] as string | null) ?? '–'} />
          ))}
        </dl>
        <Button variant="outline" size="sm" className="w-full" onClick={onChange}>
          Change
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-faint">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-text' : 'truncate text-text'}>{value}</dd>
    </div>
  )
}
