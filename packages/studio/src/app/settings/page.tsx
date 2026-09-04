'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SettingsResponseSchema, UpdateSettingsResponseSchema } from '@enkaku/protocol'
import { ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import { PageHeader } from '@/components/layout/PageHeader'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { farmSections } from '@/components/settings/farmSections'
import { AccessSection } from '@/components/settings/AccessSection'
import { ToolchainSection } from '@/components/settings/ToolchainSection'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'

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
  const [data, setData] = useState<{ settings: unknown; schema: unknown } | null>(null)
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
  // FarmSettingsSchema's own top-level keys, and splices in `access` before
  // `advanced`. This plan splices in one more bespoke section, `toolchain`,
  // directly after `access` — the ONLY place this page names a section that
  // is not a schema key, alongside `access` itself (plan 219 §3.3.8). The
  // splice reads `advancedAt` dynamically rather than assuming a fixed
  // index, so it survives either order `farmSections()` returns (§8 risk).
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
      const scoped = narrowSchema(data.schema as never, keys)
      return (
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
      )
    },
  }))

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-[236px_1fr] gap-0 border-t border-line">
        <div className="border-r border-line px-2.5 py-3 pb-4">
          <SectionNav sections={settingsSections} active={tab} onChange={(id) => router.push(id === 'general' ? '/settings' : `/settings?tab=${id}`)} />
        </div>
        <div className="max-w-[720px] px-[22px] pt-[18px] pb-7">
          {settingsSections.find((s) => s.id === tab)?.render() ?? settingsSections[0]?.render()}
        </div>
      </div>
    </>
  )
}
