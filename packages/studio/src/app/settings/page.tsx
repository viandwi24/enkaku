'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SettingsResponseSchema, UpdateSettingsResponseSchema, type FarmSettings } from '@enkaku/protocol'
import { ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { farmSections } from '@/components/settings/farmSections'
import { AccessSection } from '@/components/settings/AccessSection'
import { ToolchainSection } from '@/components/settings/ToolchainSection'
import { VirtualDevicesSection } from '@/components/settings/VirtualDevicesSection'
import { ResetSectionAction } from '@/components/settings/ResetSectionAction'
import { StorageUsageRow } from '@/components/settings/StorageUsageRow'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { SpeechPanel } from '@/components/settings/SpeechPanel'
import type { JsonSchemaNode } from '@/components/schema-form/types'

/** The two `ai` fields `SpeechPanel` edits itself (plan 318) — left out of the generic form so one value never has two editors on one screen. */
const SPEECH_FIELDS = ['whisperCliPath', 'whisperModel']

function withoutSpeechFields(schema: JsonSchemaNode): JsonSchemaNode {
  const ai = schema.properties?.ai
  if (!ai?.properties) return schema
  const properties = Object.fromEntries(Object.entries(ai.properties).filter(([k]) => !SPEECH_FIELDS.includes(k)))
  const required = ai.required?.filter((k) => !SPEECH_FIELDS.includes(k))
  return { ...schema, properties: { ...schema.properties, ai: { ...ai, properties, ...(required ? { required } : {}) } } }
}

/**
 * The Settings page (design handoff, "Screen: Settings"; plan 219). Rebuilt
 * on the handoff rather than restyled — every section is either derived
 * straight from `FarmSettingsSchema` (`farmSections()`, plan 212 §4.5) and
 * rendered through `SchemaForm`, or one of the two bespoke sections spliced
 * in by id: Access (users, API tokens, the audit log) and Toolchain (tool
 * versions, doctor diagnostics, the two restart dialogs) — neither is a
 * settings field at all.
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="px-5 py-4"><LoadingRows rows={4} /></div>}>
      <SettingsScreen />
    </Suspense>
  )
}

function SettingsScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = params.get('tab') ?? 'general'
  const [data, setData] = useState<{ settings: FarmSettings; schema: unknown; defaults: FarmSettings } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setData(b)
        setDraft(b.settings)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const save = () =>
    run('save', () => api('/api/settings', UpdateSettingsResponseSchema, { method: 'PATCH', json: draft }), {
      success: 'Settings saved',
      failure: 'Could not save settings',
      onSuccess: (b) => {
        setData((d) => (d ? { ...d, settings: b.settings } : d))
        setDraft(b.settings)
        setServerErrors({})
      },
    })

  if (error) return <ErrorState message={error} onRetry={load} />
  if (data === null || draft === null) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  // farmSections() (plan 212 §4.5) derives nine schema-backed sections from
  // FarmSettingsSchema's own top-level keys, and splices in `access` and
  // `virtualDevices` before `advanced` (plan 403 §3.2, §4.4 — VM rows live
  // behind `/api/vms`, not inside `FarmSettingsSchema`, same reason `access`
  // is bespoke). This page splices in one more bespoke section, `toolchain`,
  // directly after `access`. This is the ONLY place this page names a section that is not a schema
  // key: as of plan 403 it names three — `access`, `toolchain` (plan 219
  // §3.3.8), and `virtualDevices` (plan 403). The splice reads `advancedAt`
  // dynamically rather than assuming a fixed index, so it survives either
  // order `farmSections()` returns (§8 risk).
  const derived = farmSections(data.schema as never)
  const advancedAt = derived.findIndex((s) => s.id === 'advanced')
  const toolchain = { id: 'toolchain', title: 'Toolchain', group: 'Farm', keys: [] as string[] }
  const sections = advancedAt === -1 ? [...derived, toolchain] : [...derived.slice(0, advancedAt), toolchain, ...derived.slice(advancedAt)]

  const settingsSections: SettingsSection[] = sections.map(({ id, title, group, keys }) => ({
    id,
    title,
    group,
    render: () => {
      if (id === 'access') return <AccessSection />
      if (id === 'toolchain') return <ToolchainSection />
      if (id === 'virtualDevices') return <VirtualDevicesSection />
      const narrowed = narrowSchema(data.schema as never, keys)
      const scoped = id === 'ai' ? withoutSpeechFields(narrowed) : narrowed
      return (
        <>
          {id === 'storage' && <StorageUsageRow />}
          <SchemaForm
            schema={scoped}
            value={draft}
            onChange={setDraft}
            serverErrors={serverErrors}
            onSubmit={save}
            onReset={() => setDraft(data.settings)}
            busy={isPending('save')}
            dirty={JSON.stringify(draft) !== JSON.stringify(data.settings)}
          />
          {/*
            Distinct from `SchemaForm`'s own `onReset`, which drops unsaved
            edits back to the SAVED values. This puts the saved values back to
            what the BUILD ships — the only way a farm that has already run
            picks up a default changed in a later release, since its
            `farm_settings` row stores every key explicitly (see
            `ResetSectionAction`). One key per section, so it renders only for
            the schema-backed sections; `access`, `toolchain` and
            `virtualDevices` are not settings rows at all.
          */}
          {keys.length === 1 && keys[0] !== undefined && (
            <ResetSectionAction
              sectionId={keys[0]}
              sectionTitle={title}
              settings={data.settings}
              defaults={data.defaults}
              onReset={(settings) => {
                setData((d) => (d ? { ...d, settings } : d))
                setDraft(settings)
                setServerErrors({})
              }}
            />
          )}
          {/*
            Plan 318 — speech transcription lives under the AI form (`/settings?tab=ai`). It saves its own two fields
            straight to the row, so the page's saved copy and the draft are updated here — otherwise the next Save of
            the form above would write the old whisper values back.
          */}
          {id === 'ai' && (
            <SpeechPanel
              settings={data.settings}
              onSaved={(settings) => {
                setData((d) => (d ? { ...d, settings } : d))
                setDraft((d: unknown) =>
                  d && typeof d === 'object'
                    ? { ...d, ai: { ...(d as FarmSettings).ai, whisperCliPath: settings.ai.whisperCliPath, whisperModel: settings.ai.whisperModel } }
                    : settings,
                )
              }}
            />
          )}
        </>
      )
    },
  }))

  return (
    <>
      <PageHeader title="Settings" />
      {/*
        `PagePanel` is `overflow-hidden`, so a page that does not carry its own
        scroller is simply cut off at the panel's edge — Settings sections
        longer than the window had no way to reach their own Save button
        (owner, 2026-09-04). The scroller lives here rather than in the panel
        because screens like Devices and Jobs manage several independent
        scroll regions of their own and must keep doing so.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid min-h-full grid-cols-[236px_1fr] gap-0 border-t border-line">
        <div className="border-r border-line px-2.5 py-3 pb-4">
          <SectionNav navOnly sections={settingsSections} active={tab} onChange={(id) => router.push(id === 'general' ? '/settings' : `/settings?tab=${id}`)} />
        </div>
          <div className="max-w-[720px] px-[22px] pt-[18px] pb-7">
            {settingsSections.find((s) => s.id === tab)?.render() ?? settingsSections[0]?.render()}
          </div>
        </div>
      </div>
    </>
  )
}
