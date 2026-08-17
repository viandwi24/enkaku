'use client'

import { useEffect, useState } from 'react'
import {
  DeviceLabelStateSchema,
  DeviceResponseSchema,
  SettingsResponseSchema,
  type DeviceLabelState,
  type FarmSettings,
} from '@enkaku/protocol'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { DeviceNumberField } from '@/components/device/DeviceNumberField'
import { PhysicalLabellingPanel } from '@/components/device/PhysicalLabellingPanel'
import { PreparationPanel } from '@/components/device-popup/PreparationPanel'
import { AgentPanel } from '@/components/guest-agent/AgentPanel'
import { NetworkPanel } from '@/components/guest-agent/NetworkPanel'
import { IdentityPanel } from '@/components/identity/IdentityPanel'
import { KvPanel } from '@/components/kv/KvPanel'
import { deviceSections } from '@/components/settings/deviceSections'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { DeviceVideoFields } from '@/components/video/DeviceVideoFields'
import { TagEditor } from '@/components/TagEditor'
import { Dialog, DialogContent, DialogHeader, DialogTitle, LoadingRows, api, useAction } from '@enkaku/ui'

/**
 * The device popup's one sectioned Settings popup (plan 103 §3.3, §4.2 row
 * "Settings", §5 step 103.6, extended by step 103.11's audit closure) —
 * General, Identity, KV, Network, Preparation, Agent, Video, Timing,
 * Labelling, Tags. Ten separate action rows would defeat the owner's own
 * compactness requirement on their own (§3.3) — that is why they are one
 * popup with sections instead, per §5 of this file's own plan for facts an
 * operator "looks up".
 *
 * **Preparation is the tenth section (plan 106 §5 step 106.3)** — not
 * reused from `app/device/page.tsx` like the other nine, because no such
 * tab exists there; `PreparationPanel.tsx`'s own file header records the
 * weighed choice (a `SettingsPopup` section, not a `SidePanel` tab) and why.
 *

 * **General, Video, and Timing joined the original six (plan 103 §5, closing
 * step 103.11's audit rows 17-19, 2026-08-17)** — named, at the time, as a
 * gap in this popup's own scope (six surfaces, step 103.6) rather than a
 * silently dropped one. All three are reused exactly as
 * `app/device/page.tsx`'s own Settings tab composes them: General is
 * `DeviceNumberField` (hand-authored — `number` lives outside
 * `DeviceSettingsSchema`, §4.1, so it can never be one of `deviceSections`'s
 * derived keys) plus a plain `SchemaForm` for every ungrouped field; Video is
 * `DeviceVideoFields` (the farm-default readout, the Advanced disclosure);
 * Timing is the SAME pointer paragraph (layer 1 vs. the run form's own layer
 * 2/3 pacing) plus a plain `SchemaForm`. This popup still does not attempt
 * FULL parity with the page's own Settings tab — the schema's other named
 * groups (`Engines`, `Power & readiness`, and the schema's OWN `Identity`
 * group, distinct from this popup's `IdentityPanel` section below) were
 * never named as absent by step 103.11's audit table and stay out of this
 * closure's scope, not silently dropped from a count that never included
 * them.
 */
export function SettingsPopup({
  deviceId,
  device,
  canUse,
  open,
  onOpenChange,
  onDeviceUpdated,
}: {
  deviceId: string
  device: DeviceDetailInfo
  /** `iHoldControl && !busy` — gates Identity/Network/Agent's own mutating controls, the same fact every other panel on the device page reads. */
  canUse: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a settings save succeeds, so the caller can refresh `deviceDetail` from the server — the same `reloadDevice` `ActionsList`'s connection rows already use. */
  onDeviceUpdated: () => void
}) {
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  const [savedSettings, setSavedSettings] = useState<unknown>(device.settings)
  const [draftSettings, setDraftSettings] = useState<unknown>(device.settings)
  const [labelState, setLabelState] = useState<DeviceLabelState | null>(null)
  // The Video section's own farm-default readout (plan 103 §5, closing step
  // 103.11's audit row 18) — needs "the farm" as the source for any field
  // this device leaves empty, the same fact `app/device/page.tsx`'s own
  // `farmVideo` state already reads off this SAME `/api/settings` fetch.
  const [farmVideo, setFarmVideo] = useState<FarmSettings['video'] | null>(null)
  const [section, setSection] = useState('general')
  const { run, isPending } = useAction()

  // Fetched once when the popup opens, not on every render — the same
  // deviceSchema `app/device/page.tsx` reads from `/api/settings`, needed
  // here to narrow it down to each section's own keys (Labelling, General,
  // Video, Timing alike).
  useEffect(() => {
    if (!open) return
    setSavedSettings(device.settings)
    setDraftSettings(device.settings)
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setSchema(b.deviceSchema as JsonSchemaNode)
        setFarmVideo(b.settings.video)
      })
      .catch(() => undefined)
    void api(`/api/devices/${deviceId}/label`, DeviceLabelStateSchema)
      .then(setLabelState)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deviceId])

  const saveSettings = () =>
    run(
      'popup-settings',
      () => api(`/api/devices/${deviceId}`, DeviceResponseSchema, { method: 'PATCH', json: { settings: draftSettings } }),
      {
        success: 'Device settings saved',
        failure: 'Could not save the device settings',
        onSuccess: () => {
          setSavedSettings(draftSettings)
          onDeviceUpdated()
        },
      },
    )

  const labellingKeys = schema ? deviceSections(schema).find((s) => s.id === 'physical-labelling')?.keys ?? [] : []
  // Plan 103 §5, closing step 103.11's audit rows 17-19 — the same
  // `deviceSections()` derivation `app/device/page.tsx` itself reads, so a
  // setting can never appear on the page's own Settings tab and be missing
  // here purely because this popup hand-maintained a second key list.
  const generalKeys = schema ? deviceSections(schema).find((s) => s.id === 'general')?.keys ?? [] : []
  const videoKeys = schema ? deviceSections(schema).find((s) => s.id === 'video')?.keys ?? [] : []
  const timingKeys = schema ? deviceSections(schema).find((s) => s.id === 'timing')?.keys ?? [] : []
  const dirty = JSON.stringify(draftSettings) !== JSON.stringify(savedSettings)

  const sections: SettingsSection[] = [
    {
      // Plan 103 §5, closing step 103.11's audit row 17 — `DeviceNumberField`
      // (hand-authored: `number` lives outside `DeviceSettingsSchema`, §4.1,
      // so it can never be one of `generalKeys`) plus a plain `SchemaForm`
      // for every field the schema leaves ungrouped, exactly matching
      // `app/device/page.tsx`'s own `general` branch.
      id: 'general',
      title: 'General',
      render: () =>
        schema ? (
          <>
            <DeviceNumberField device={device} onSaved={() => onDeviceUpdated()} />
            <div className="mt-3">
              <SchemaForm
                schema={narrowSchema(schema, generalKeys)}
                value={draftSettings}
                onChange={setDraftSettings}
                onSubmit={saveSettings}
                onReset={() => setDraftSettings(savedSettings)}
                busy={isPending('popup-settings')}
                dirty={dirty}
              />
            </div>
          </>
        ) : (
          <LoadingRows rows={3} />
        ),
    },
    {
      id: 'identity',
      title: 'Identity',
      render: () => <IdentityPanel deviceId={deviceId} canUse={canUse} />,
    },
    {
      id: 'storage',
      title: 'KV',
      render: () => <KvPanel scope={{ kind: 'device', stableId: device.stableId }} />,
    },
    {
      id: 'network',
      title: 'Network',
      render: () => <NetworkPanel deviceId={deviceId} canUse={canUse} />,
    },
    {
      // Plan 106 §5 step 106.3 — the tenth section, deliberately a
      // `SettingsPopup` section rather than a `SidePanel` tab (see
      // `PreparationPanel.tsx`'s own file header for the weighed decision):
      // this is something an operator READS and retries in the background,
      // never something that needs the live screen open beside it the way
      // Actions/Inspector/Record do.
      id: 'preparation',
      title: 'Preparation',
      render: () => <PreparationPanel deviceId={deviceId} deviceLabel={device.label} canUse={canUse} />,
    },
    {
      id: 'agent',
      title: 'Agent',
      render: () => <AgentPanel deviceId={deviceId} deviceLabel={device.label} canUse={canUse} />,
    },
    {
      // Plan 103 §5, closing step 103.11's audit row 18 — `DeviceVideoFields`
      // UNCHANGED, the same schema-plus-readout shape
      // `app/device/page.tsx`'s own `video` branch already uses.
      id: 'video',
      title: 'Video',
      render: () =>
        schema ? (
          <DeviceVideoFields
            schema={narrowSchema(schema, videoKeys)}
            draft={draftSettings as Record<string, unknown>}
            onChange={setDraftSettings}
            onSubmit={saveSettings}
            onReset={() => setDraftSettings(savedSettings)}
            busy={isPending('popup-settings')}
            dirty={dirty}
            farmVideo={farmVideo}
          />
        ) : (
          <LoadingRows rows={4} />
        ),
    },
    {
      // Plan 103 §5, closing step 103.11's audit row 19 — the SAME pointer
      // paragraph `app/device/page.tsx`'s own `timing` branch renders
      // (layer 1, sub-second, inside one action — never the run form's own
      // layer 2/3 repeat pacing, deliberately never shown on this same
      // screen) plus a plain `SchemaForm`.
      id: 'timing',
      title: 'Timing',
      render: () =>
        schema ? (
          <>
            <p className="mb-3 rounded-lg border bg-surface-2/40 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
              This is how THIS device performs one action — hold duration, coordinate jitter, typing cadence — and it
              applies to everything this device runs. Repeat pacing (how many times a run repeats, and how long to
              wait between repetitions or across a fleet) is a property of the RUN, not the device — set it in the run
              form's Repeat section instead.
            </p>
            <SchemaForm
              schema={narrowSchema(schema, timingKeys)}
              value={draftSettings}
              onChange={setDraftSettings}
              onSubmit={saveSettings}
              onReset={() => setDraftSettings(savedSettings)}
              busy={isPending('popup-settings')}
              dirty={dirty}
            />
          </>
        ) : (
          <LoadingRows rows={3} />
        ),
    },
    {
      id: 'physical-labelling',
      title: 'Labelling',
      render: () =>
        schema ? (
          <PhysicalLabellingPanel
            device={{ id: device.id, label: device.label, number: device.number ?? null, screenW: device.screenW, screenH: device.screenH }}
            schema={narrowSchema(schema, labellingKeys)}
            draft={draftSettings as Record<string, unknown>}
            onChange={setDraftSettings}
            onSubmit={saveSettings}
            onReset={() => setDraftSettings(savedSettings)}
            busy={isPending('popup-settings')}
            dirty={dirty}
            labelState={labelState}
            onLabelStateChange={setLabelState}
          />
        ) : (
          <LoadingRows rows={3} />
        ),
    },
    {
      id: 'tags',
      title: 'Tags',
      render: () => <TagEditor deviceId={deviceId} tags={device.tags} />,
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent overlay={false} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings — {device.label}</DialogTitle>
        </DialogHeader>
        <SectionNav sections={sections} active={section} onChange={setSection} />
      </DialogContent>
    </Dialog>
  )
}
