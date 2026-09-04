'use client'

import { useEffect, useState } from 'react'
import { FarmAgentSettingsResponseSchema, UpdateFarmAgentSettingsResponseSchema } from '@enkaku/protocol'
import { ErrorState, LoadingRows, api, useAction } from '@enkaku/ui'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import { SectionNav, type SettingsSection } from '@/components/settings/SectionNav'
import { ConnectorsSettingsSection } from './ConnectorsSettingsSection'
import { WebhooksSettingsSection } from './WebhooksSettingsSection'

/**
 * The Agents page's Settings tab (plan 212 §4.7, plan 220 §1 goal 3):
 * `FarmAgentSettingsSchema`'s two schema-backed sections (`defaults`,
 * `scheduled`) through the same `SchemaForm`/`narrowSchema` pipeline plan
 * 219's farm Settings page uses, plus the two bespoke, non-schema sections
 * (Connectors, Webhooks) plan 212 leaves for this plan to place.
 *
 * DISCREPANCY from plan 220 §4.7's code block (recorded per plan 200 §2.2 —
 * the file wins for facts): the plan's own text assumed `AgentSettingsSchema`
 * / `AgentSettingsResponseSchema` / `UpdateAgentSettingsResponseSchema` and
 * a field named `settings`/`schema` returned bare. The route that actually
 * shipped (`packages/core/src/api/agents.ts`, `GET/PATCH /api/agents/settings`)
 * uses `FarmAgentSettingsSchema`/`FarmAgentSettingsResponseSchema`/
 * `UpdateFarmAgentSettingsResponseSchema` instead — `packages/protocol/src/
 * agent-settings.ts`'s own doc comment states why: `./agent.ts` already
 * exports `AgentSettingsSchema` for ONE agent's own per-agent overrides
 * block, and this farm-wide schema could not reuse that name. This file
 * follows the real names.
 *
 * The two-column outer grid mirrors `docs/plans/219-mvp-plugins-and-settings.md`
 * §4.5's own outline exactly, including its stated reason for not widening
 * `SectionNav`'s built-in grid (the handoff's Settings screen has no
 * responsive collapse — plan 213 §2's non-goal).
 */
export function SettingsTab() {
  const [tab, setTab] = useState('defaults')
  const [data, setData] = useState<{ settings: unknown; schema: unknown } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/agents/settings', FarmAgentSettingsResponseSchema)
      .then((b) => {
        setData(b)
        setDraft(b.settings)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const save = () =>
    run('save', () => api('/api/agents/settings', UpdateFarmAgentSettingsResponseSchema, { method: 'PATCH', json: draft }), {
      success: 'Agent settings saved',
      failure: 'Could not save agent settings',
      onSuccess: (b) => {
        setData((d) => (d ? { ...d, settings: b.settings } : d))
        setDraft(b.settings)
        setServerErrors({})
      },
    })

  if (error) return <div className="px-5 py-4"><ErrorState message={error} onRetry={load} /></div>
  if (data === null || draft === null) return <div className="px-5 py-4"><LoadingRows rows={4} /></div>

  const sections: SettingsSection[] = [
    {
      id: 'defaults',
      title: 'Defaults',
      render: () => (
        <SchemaForm
          schema={narrowSchema(data.schema as never, ['defaults'])}
          value={draft}
          onChange={setDraft}
          serverErrors={serverErrors}
          onSubmit={save}
          onReset={() => setDraft(data.settings)}
          busy={isPending('save')}
          dirty={JSON.stringify(draft) !== JSON.stringify(data.settings)}
        />
      ),
    },
    {
      id: 'scheduled',
      title: 'Scheduled agents',
      render: () => (
        <SchemaForm
          schema={narrowSchema(data.schema as never, ['scheduled'])}
          value={draft}
          onChange={setDraft}
          serverErrors={serverErrors}
          onSubmit={save}
          onReset={() => setDraft(data.settings)}
          busy={isPending('save')}
          dirty={JSON.stringify(draft) !== JSON.stringify(data.settings)}
        />
      ),
    },
    { id: 'connectors', title: 'Connectors', render: () => <ConnectorsSettingsSection /> },
    { id: 'webhooks', title: 'Webhooks', render: () => <WebhooksSettingsSection /> },
  ]

  return (
    <div className="grid grid-cols-[236px_1fr] gap-0 border-t border-line">
      <div className="border-r border-line px-2.5 py-3 pb-4">
        <SectionNav sections={sections} active={tab} onChange={setTab} />
      </div>
      <div className="max-w-[720px] px-[22px] pt-[18px] pb-7">{sections.find((s) => s.id === tab)?.render() ?? sections[0]?.render()}</div>
    </div>
  )
}
